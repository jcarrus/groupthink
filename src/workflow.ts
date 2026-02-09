/**
 * Cloudflare Workflow for processing LLM requests durably.
 *
 * This runs without timeout limits, handling:
 * - Fetching Discord messages
 * - Calling Claude API
 * - Posting responses back to Discord
 */
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import {
  sendMessage,
  sendMessageWithFiles,
  getAllMessages,
  deleteOriginalResponse,
  editOriginalResponse,
  getOriginalResponse,
  getChannel,
  createChannel,
  createThread,
  fetchPlainTextAttachment,
  isPlainTextAttachment,
  type DiscordMessage,
} from "./discord";
import {
  chat,
  chatStream,
  withCaching,
  type AnthropicTool,
  type Message,
  type ModelTier,
} from "./claude";
import {
  fetchAllMcpTools,
  mcpCallTool,
  getMcpConfigFromMessages,
  resolveMcpServersWithOAuth,
} from "./mcp";

// ============================================================================
// Workflow Parameters
// ============================================================================

export type JobType =
  | "chat"
  | "summarize"
  | "post-to-channel"
  | "branch-with-summary";

interface BaseParams {
  type: JobType;
  channelId: string;
  interactionToken: string;
  appId: string;
}

interface ChatParams extends BaseParams {
  type: "chat";
  isThread: boolean;
  instruction?: string;
  invokingUsername?: string;
}

interface SummarizeParams extends BaseParams {
  type: "summarize";
}

interface PostToChannelParams extends BaseParams {
  type: "post-to-channel";
}

interface BranchWithSummaryParams extends BaseParams {
  type: "branch-with-summary";
  isThread: boolean;
  guildId: string;
}

export type WorkflowParams =
  | ChatParams
  | SummarizeParams
  | PostToChannelParams
  | BranchWithSummaryParams;

export interface WorkflowEnv {
  DISCORD_TOKEN: string;
  DISCORD_APP_ID: string;
  ANTHROPIC_API_KEY: string;
  PUBLIC_URL: string;
  OAUTH_ENCRYPTION_KEY?: string;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_MESSAGE_LENGTH = 2000;
const SUMMARY_MARKER = "--- Summary so far ---";
const RETRY_OPTS = {
  retries: {
    limit: 2,
    delay: "5 seconds" as const,
    backoff: "linear" as const,
  },
};

/** Message boundary: --- separator or blank line. */
const MESSAGE_BREAK = /\n---\s*\n|\n\n/;

/** Minimum chars before posting an incremental message. */
const MIN_CHARS = 120;
/** Minimum ms between Discord posts to avoid rate limits. */
const MIN_INTERVAL_MS = 4_000;

// Claude 4.5 pricing per million tokens (1h cache TTL).
const PRICING: Record<
  ModelTier,
  { in: number; out: number; cacheRead: number; cacheWrite: number }
> = {
  haiku: { in: 1.0, out: 5.0, cacheRead: 0.1, cacheWrite: 2.0 },
  sonnet: { in: 3.0, out: 15.0, cacheRead: 0.3, cacheWrite: 6.0 },
  opus: { in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 10.0 },
};

// ============================================================================
// Helpers
// ============================================================================

/** Run a step durably: serialize to JSON for Cloudflare Workflow checkpointing. */
async function durable<T>(
  step: WorkflowStep,
  name: string,
  fn: () => Promise<T>,
  config?: object
): Promise<T> {
  const run = async () => JSON.stringify(await fn());
  const json = config
    ? await step.do(name, config as any, run)
    : await step.do(name, run);
  return JSON.parse(json);
}

const formatUsageInfo = (
  usage: Record<string, unknown>,
  modelTier: ModelTier = "sonnet"
): string => {
  const inputTokens = (usage.input_tokens as number) || 0;
  const outputTokens = (usage.output_tokens as number) || 0;
  const cacheCreationTokens =
    (usage.cache_creation_input_tokens as number) || 0;
  const cacheReadTokens = (usage.cache_read_input_tokens as number) || 0;
  const p = PRICING[modelTier];
  const totalCost =
    (inputTokens / 1_000_000) * p.in +
    (outputTokens / 1_000_000) * p.out +
    (cacheReadTokens / 1_000_000) * p.cacheRead +
    (cacheCreationTokens / 1_000_000) * p.cacheWrite;
  const totalTokens =
    inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  const parts: string[] = [
    `model: ${modelTier}`,
    `total: ${totalTokens.toLocaleString()} tokens`,
    `in: ${inputTokens.toLocaleString()}, out: ${outputTokens.toLocaleString()}`,
  ];
  if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
    parts.push(
      `cache: ${cacheReadTokens.toLocaleString()} read, ${cacheCreationTokens.toLocaleString()} write`
    );
  }
  parts.push(`$${totalCost.toFixed(4)}`);
  return `-# ${parts.join(" · ")}`;
};

const isSummaryMarker = (msg: DiscordMessage): boolean =>
  !!msg.author.bot && !!msg.content?.startsWith(SUMMARY_MARKER);

const MODEL_SET_PATTERN = /^-# model:\s*(haiku|sonnet|opus)\s*$/i;

function getModelFromMessages(messages: DiscordMessage[]): ModelTier {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i].content?.trim().match(MODEL_SET_PATTERN);
    if (messages[i].author.bot && m) return m[1].toLowerCase() as ModelTier;
  }
  return "sonnet";
}

/** Send text to a channel, splitting at natural boundaries if too long. */
async function sendLongMessage(
  channelId: string,
  text: string,
  token: string
): Promise<void> {
  for (const part of splitLongMessage(text)) {
    await sendMessage(channelId, part, token);
  }
}

// ============================================================================
// Response Parsing (artifacts and message breaks)
// ============================================================================

interface Artifact {
  name: string;
  content: string;
}

interface ParsedResponse {
  messages: string[];
  artifacts: Artifact[];
}

/** Parse LLM response: extract file attachments, split on --- or blank lines. */
function parseResponse(text: string): ParsedResponse {
  const artifacts: Artifact[] = [];
  const artifactRegex =
    /<groupthink:file-attachment\s+name="([^"]+)">([\s\S]*?)<\/groupthink:file-attachment>/g;
  const cleanedText = text
    .replace(artifactRegex, (_, filename, content) => {
      artifacts.push({ name: filename.trim(), content: content.trim() });
      return "";
    })
    .replace(/\[From\s+<@\d+>\s+\([^)]*\)\]\s*/g, "");
  const messages = cleanedText
    .split(MESSAGE_BREAK)
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (messages.length === 1 && messages[0].length > MAX_MESSAGE_LENGTH) {
    return { messages: splitLongMessage(messages[0]), artifacts };
  }
  return { messages, artifacts };
}

/** Split a long message at natural boundaries */
function splitLongMessage(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try to split at paragraph break
    let splitIndex = remaining.lastIndexOf("\n\n", maxLen);

    // If no paragraph break, try single newline
    if (splitIndex === -1 || splitIndex < maxLen / 2) {
      splitIndex = remaining.lastIndexOf("\n", maxLen);
    }

    // If no newline, try sentence end
    if (splitIndex === -1 || splitIndex < maxLen / 2) {
      const sentenceEnd = remaining.slice(0, maxLen).match(/.*[.!?]\s/);
      splitIndex = sentenceEnd ? sentenceEnd[0].length : -1;
    }

    // Last resort: hard cut at space
    if (splitIndex === -1 || splitIndex < maxLen / 2) {
      splitIndex = remaining.lastIndexOf(" ", maxLen);
    }

    // Absolute last resort: hard cut
    if (splitIndex === -1) {
      splitIndex = maxLen;
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

// ============================================================================
// System Prompts
// ============================================================================

const CHAT_SYSTEM_PROMPT = `You are a helpful assistant in a Discord chat with a group of highly intelligent and knowledgeable individuals.

## What GroupThink is
You are running inside GroupThink: a Discord bot for collaborative AI conversations. The group shares a channel or thread; someone runs /generate and you get the full conversation as context and reply here. Your reply is posted back to the same channel or thread. The group can later use /summarize to checkpoint the conversation (so future /generate only sees the summary plus new messages), /branch to copy the conversation to a new channel or thread, /branch-with-summary to start a branch with a summarized context, and in threads /post-to-channel to extract insights back to the parent channel. You are one voice in an ongoing discussion—add value, stay on topic, and leave room for others to respond.

## Guidelines
- Reference thought leaders when relevant. Your job is to provide a best-in-class response, but also to open the door to further discussion.
- Be brief and to the point like William Strunk.
- Stay focused on the essence of the conversation like Greg McKeown.

## Message Format
- Messages from users are prefixed with their username in brackets like [username].
- Reactions are shown as [Reactions: 👍 x3, ❤️ x2] - these indicate agreement, appreciation, or emphasis.
- When addressing a user by name, use @username naturally in conversation.

## Style
- Write like a chat message, not a document. Favor plain prose and short paragraphs.
- Use formatting sparingly: at most a little **bold** or \`code\` when it clearly helps. No walls of markdown.
- Avoid: headers (#), markdown tables, block quotes, long code blocks in the message (use file attachments instead), bullet/list overload.
- Never use markdown table syntax (pipes | and dashes). The renderer does not support it. Use short bullets or prose; only for tabular data use a code fence with an ASCII table inside.
- One or two short bullet points is fine; long lists belong in a file attachment.

## Response Structure
Prefer short, conversational messages: one main idea per message. A blank line or three dashes on their own line starts a new message:
---
That keeps the thread readable and lets the group see your reply as it streams.

For data, code, or structured content that would be better as a file attachment, use XML tags:
<groupthink:file-attachment name="filename.ext">
content here
</groupthink:file-attachment>

Examples of good file attachments:
- CSV data: \`<groupthink:file-attachment name="data.csv">\`
- Code files: \`<groupthink:file-attachment name="script.py">\`
- Long text: \`<groupthink:file-attachment name="notes.md">\`

Keep the main conversational response in regular text, use file attachments for supplementary content like data exports, code samples, or detailed reports.`;

const SUMMARIZE_SYSTEM_PROMPT = `You are a helpful assistant that creates concise summaries of Discord conversations.

Create a summary that captures:
1. The main topics discussed
2. Key decisions or conclusions reached
3. Any action items or next steps mentioned
4. Important context that would be needed to continue the conversation

Be concise but comprehensive. Use bullet points for clarity.`;

const DOCUMENT_SYSTEM_PROMPT = `Extract critical insights from this thread for the parent channel. Output only bullet points. Maximum compression.

Format:
- One short line per bullet. No paragraphs. No emojis. No headings.
- Use simple clauses. Omit needless words (Strunk). If you can say it in 5 words, don't use 10.
- Group by idea when natural (e.g. "Key constraint: X" then "Artists: A, B, C" as separate bullets).
- Include: decisions, solutions, recommendations, names/key terms, next steps. Nothing else.
- Target: a reader who wasn't there gets the gist in under 15 bullets.`;

// ============================================================================
// Context Collection
// ============================================================================

async function getChannelContext(
  channelId: string,
  token: string
): Promise<DiscordMessage[]> {
  const chronological = (await getAllMessages(channelId, token)).reverse();
  let startIndex = 0;
  for (let i = chronological.length - 1; i >= 0; i--) {
    if (isSummaryMarker(chronological[i])) {
      startIndex = i;
      break;
    }
  }
  return chronological.slice(startIndex);
}

async function getThreadContext(
  threadId: string,
  token: string
): Promise<DiscordMessage[]> {
  const threadInfo = await getChannel(threadId, token);
  if (!threadInfo.parent_id) {
    return (await getAllMessages(threadId, token)).reverse();
  }
  const [channelMessages, threadMessages] = await Promise.all([
    getChannelContext(threadInfo.parent_id, token),
    getAllMessages(threadId, token),
  ]);
  return [...channelMessages, ...threadMessages.reverse()];
}

/** Fetch context: thread (parent + thread) or channel. */
const fetchContext = (channelId: string, isThread: boolean, token: string) =>
  isThread
    ? getThreadContext(channelId, token)
    : getChannelContext(channelId, token);

// ============================================================================
// Conversation Conversion
// ============================================================================

async function discordMessagesToLLMConversation(
  messages: DiscordMessage[]
): Promise<Message[]> {
  const lastSummaryMarkerIndex = messages.findLastIndex(isSummaryMarker);

  const conversation = await Promise.all(
    messages
      .slice(Math.max(0, lastSummaryMarkerIndex))
      // Remove empty messages
      .filter((m) => m.content?.trim())
      // Remove bot metadata (token usage, model setting, MCP config, etc.)
      .filter((m) => !m.content?.trim().startsWith("-#"))
      .map(async (m): Promise<Message> => {
        return {
          role: m.author.bot ? "assistant" : "user",
          content: await Promise.all([
            {
              // Prepend the author's username to the content
              type: "text" as const,
              text: `[From <@${m.author.id}> (${m.author.username})]`,
            },
            {
              // Include the text content
              type: "text" as const,
              text: m.content,
            },
            // Include text attachments
            ...(m.attachments
              ?.filter((a) => isPlainTextAttachment(a))
              .map(async (a) => ({
                type: "text" as const,
                text: await fetchPlainTextAttachment(a.url),
              })) ?? []),
            // Include image attachments
            ...(m.attachments
              ?.filter((a) => a.content_type?.startsWith("image/jp")) // currently only JPEG is supported
              .map(async (a) => ({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: "image/jpeg" as const,
                  data: Buffer.from(
                    (await fetch(a.url).then((r) =>
                      r.arrayBuffer()
                    )) as ArrayBuffer
                  ).toString("base64"),
                },
              })) ?? []),
            // Add emoji reactions at notes
            ...(m.reactions?.map((r) => ({
              type: "text" as const,
              text: `${r.emoji.name} x${r.count}`,
            })) ?? []),
          ]),
        };
      })
  );

  if (conversation.at(-1)?.role === "assistant") {
    conversation.push({
      role: "user",
      content: "[System]: Please continue the conversation.",
    });
  }
  return conversation;
}

// ============================================================================
// The Workflow
// ============================================================================

export class GroupThinkWorkflow extends WorkflowEntrypoint<
  WorkflowEnv,
  WorkflowParams
> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    console.log(
      `Starting workflow: ${params.type} for channel ${params.channelId}`
    );

    try {
      switch (params.type) {
        case "chat":
          await this.processChat(params, step);
          break;
        case "summarize":
          await this.processSummarize(params, step);
          break;
        case "post-to-channel":
          await this.processPostToChannel(params, step);
          break;
        case "branch-with-summary":
          await this.processBranchWithSummary(params, step);
          break;
      }
    } catch (err) {
      console.error("Workflow error:", err);
      // Try to send error message
      await step.do("send-error", async () => {
        await sendMessage(
          params.channelId,
          `❌ Error: ${err}`,
          this.env.DISCORD_TOKEN
        );
        await deleteOriginalResponse(params.appId, params.interactionToken);
      });
      throw err;
    }
  }

  private async processChat(params: ChatParams, step: WorkflowStep) {
    const t0 = Date.now();
    const elapsed = (label: string) =>
      console.log(`[chat] +${Date.now() - t0}ms ${label}`);

    const messages = await durable(step, "fetch-messages", () =>
      fetchContext(params.channelId, params.isThread, this.env.DISCORD_TOKEN)
    );
    elapsed(`fetched ${messages.length} messages`);

    const mcpServers = await resolveMcpServersWithOAuth(
      messages,
      getMcpConfigFromMessages(messages),
      this.env,
      params.channelId
    );
    elapsed(`resolved ${mcpServers.length} MCP servers`);

    const modelTier = getModelFromMessages(messages);
    // Apply cache breakpoints to the real Discord messages BEFORE
    // appending any ephemeral instruction, so breakpoints are stable
    // across calls.
    const conversation = withCaching(
      await discordMessagesToLLMConversation(messages),
    );
    elapsed(`built conversation (${conversation.length} turns)`);

    if (params.instruction?.trim()) {
      conversation.push({
        role: "user",
        content: `[Instruction]: ${params.instruction.trim()}`,
      });
    }
    if (params.instruction && params.invokingUsername) {
      await step.do("post-instruction-message", async () => {
        await sendMessage(
          params.channelId,
          params.invokingUsername + " just asked: " + params.instruction,
          this.env.DISCORD_TOKEN
        );
      });
    }

    // Prepare MCP tools (if any)
    let mcpTools: AnthropicTool[] = [];
    let resolveTool:
      | ((name: string, input: Record<string, unknown>) => Promise<string>)
      | undefined;
    let onToolCall: ((name: string) => Promise<void>) | undefined;

    if (mcpServers.length > 0) {
      try {
        const { tools, sessions, oauthRequired } =
          await fetchAllMcpTools(mcpServers);
        elapsed(`fetched ${tools.length} MCP tools`);
        if (oauthRequired?.length)
          await this.sendOAuthPrompts(oauthRequired, params.channelId);
        if (tools.length > 0) {
          mcpTools = tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            input_schema: t.inputSchema,
          }));
          resolveTool = async (name, input) => {
            const t = tools.find((x) => x.name === name);
            if (!t) return "Unknown tool";
            const s = mcpServers[t.serverIndex];
            return mcpCallTool(
              s.url,
              s.auth,
              name,
              input,
              sessions[t.serverIndex]
            );
          };
          onToolCall = async (name) => {
            await sendMessage(
              params.channelId,
              `_Calling ${name.replace(/_/g, " ")}_`,
              this.env.DISCORD_TOKEN
            );
          };
        }
      } catch (e) {
        console.error("MCP setup failed:", e);
      }
    }

    // Stream response (with incremental message delivery + optional tools)
    const responseJson = await step.do("call-claude", RETRY_OPTS, async () => {
      await editOriginalResponse(
        params.appId,
        params.interactionToken,
        "Thinking...",
        this.env.DISCORD_TOKEN
      );
      elapsed("posted thinking indicator");

      let firstToken = false;
      let sentUpTo = 0; // chars of the response already posted
      let lastPostTime = 0;
      const controller = new AbortController();

      const { text, usage } = await chatStream(
        conversation,
        this.env.ANTHROPIC_API_KEY,
        CHAT_SYSTEM_PROMPT,
        {
          modelTier,
          tools: mcpTools.length > 0 ? mcpTools : undefined,
          resolveTool,
          onToolCall,
          signal: controller.signal,
          onUpdate: async (accumulated) => {
            if (!firstToken) {
              firstToken = true;
              elapsed("first token");
            }
            // Find the furthest break point that gives us >= MIN_CHARS
            let candidateEnd = sentUpTo;
            const rest = accumulated.slice(sentUpTo);
            let searchFrom = 0;
            while (true) {
              const m = rest.slice(searchFrom).match(MESSAGE_BREAK);
              if (!m) break;
              candidateEnd = sentUpTo + searchFrom + m.index! + m[0].length;
              searchFrom += m.index! + m[0].length;
            }
            if (candidateEnd <= sentUpTo) return; // no break found
            const part = accumulated
              .slice(sentUpTo, candidateEnd)
              .trim()
              .replace(/\[From\s+<@\d+>\s+\([^)]*\)\]\s*/g, "");
            if (part.length < MIN_CHARS) return; // not enough text yet
            if (Date.now() - lastPostTime < MIN_INTERVAL_MS) return;
            if (part.length > 0) {
              const original = await getOriginalResponse(
                params.appId,
                params.interactionToken,
                this.env.DISCORD_TOKEN
              );
              if (original === null) {
                controller.abort();
                return;
              }
              await sendMessage(params.channelId, part, this.env.DISCORD_TOKEN);
              lastPostTime = Date.now();
              elapsed(`sent incremental (${part.length} chars)`);
            }
            sentUpTo = candidateEnd;
          },
        }
      );
      elapsed(`stream complete (sentUpTo=${sentUpTo}/${text.length})`);

      return JSON.stringify({
        text,
        usage,
        sentUpTo,
        lastPostTime,
        modelTier,
        aborted: controller.signal.aborted,
      });
    });

    await step.do("post-response", async () => {
      const parsed = JSON.parse(responseJson) as {
        text: string;
        usage: Record<string, number>;
        sentUpTo?: number;
        lastPostTime?: number;
        modelTier?: ModelTier;
        aborted?: boolean;
      };
      if (parsed.aborted) return;
      const {
        text,
        usage,
        sentUpTo = 0,
        lastPostTime: prevPostTime = 0,
        modelTier: tier = "sonnet",
      } = parsed;

      console.log(`[chat] full response (${text.length} chars):\n${text}`);

      // Parse only the remainder we haven't sent yet
      const remainder = text.slice(sentUpTo);
      const { messages: msgParts, artifacts } = parseResponse(remainder);
      console.log(
        `[chat] post-response: ${msgParts.length} parts, ${artifacts.length} artifacts from ${remainder.length} remaining chars`,
      );

      let lastSend = prevPostTime;
      for (const [i, part] of msgParts.entries()) {
        // Throttle: wait 4s between posts (skip for last part)
        const isLast = i === msgParts.length - 1;
        const sinceLast = Date.now() - lastSend;
        if (!isLast && lastSend > 0 && sinceLast < MIN_INTERVAL_MS) {
          await new Promise((r) =>
            setTimeout(r, MIN_INTERVAL_MS - sinceLast),
          );
        }
        console.log(
          `[chat] posting part ${i + 1}/${msgParts.length} (${part.length} chars): ${JSON.stringify(part.slice(0, 100))}`,
        );
        if (isLast && artifacts.length > 0) {
          await sendMessageWithFiles(
            params.channelId,
            part,
            artifacts,
            this.env.DISCORD_TOKEN,
          );
        } else {
          await sendMessage(params.channelId, part, this.env.DISCORD_TOKEN);
        }
        lastSend = Date.now();
      }
      // Throttle before usage message too
      const sinceLast = Date.now() - lastSend;
      if (lastSend > 0 && sinceLast < MIN_INTERVAL_MS) {
        await new Promise((r) =>
          setTimeout(r, MIN_INTERVAL_MS - sinceLast),
        );
      }
      await sendMessage(
        params.channelId,
        formatUsageInfo(usage, tier),
        this.env.DISCORD_TOKEN,
      );
      await deleteOriginalResponse(params.appId, params.interactionToken);
    });
    elapsed("done");
  }

  private async sendOAuthPrompts(oauthRequired: string[], channelId: string) {
    if (!this.env.PUBLIC_URL) {
      await sendMessage(
        channelId,
        "OAuth is required for this MCP server, but PUBLIC_URL is not configured.",
        this.env.DISCORD_TOKEN
      );
      return;
    }
    for (const url of oauthRequired) {
      const name = (() => {
        try {
          return new URL(url).hostname.replace(/^mcp\./, "");
        } catch {
          return "this server";
        }
      })();
      const link = `${this.env.PUBLIC_URL}/oauth/start?channel_id=${channelId}&mcp_url=${encodeURIComponent(url)}`;
      await sendMessage(
        channelId,
        `${name} requires OAuth. [Connect your account](${link})`,
        this.env.DISCORD_TOKEN
      );
    }
  }

  private async processSummarize(params: SummarizeParams, step: WorkflowStep) {
    const messages = await durable(step, "fetch-messages", () =>
      getChannelContext(params.channelId, this.env.DISCORD_TOKEN)
    );
    const { text, usage } = await durable(
      step,
      "call-claude",
      async () => {
        const conversation = await discordMessagesToLLMConversation(messages);
        conversation.push({
          role: "user",
          content: "Please summarize the previous conversation.",
        });
        return chat(
          conversation,
          this.env.ANTHROPIC_API_KEY,
          SUMMARIZE_SYSTEM_PROMPT
        );
      },
      RETRY_OPTS
    );

    await step.do("post-response", async () => {
      await sendLongMessage(
        params.channelId,
        `${SUMMARY_MARKER}\n${text}`,
        this.env.DISCORD_TOKEN
      );
      await sendMessage(
        params.channelId,
        formatUsageInfo(usage),
        this.env.DISCORD_TOKEN
      );
      await deleteOriginalResponse(params.appId, params.interactionToken);
    });
  }

  private async processPostToChannel(
    params: PostToChannelParams,
    step: WorkflowStep
  ) {
    const threadInfo = await durable(step, "get-thread-info", () =>
      getChannel(params.channelId, this.env.DISCORD_TOKEN)
    );
    if (!threadInfo.parent_id) {
      await step.do("send-error-response", async () => {
        await sendMessage(
          params.channelId,
          "Could not find parent channel.",
          this.env.DISCORD_TOKEN
        );
        await deleteOriginalResponse(params.appId, params.interactionToken);
      });
      return;
    }
    const messages = await durable(step, "fetch-messages", async () =>
      (await getAllMessages(params.channelId, this.env.DISCORD_TOKEN)).reverse()
    );
    const { text } = await durable(
      step,
      "call-claude",
      async () => {
        const conversation = await discordMessagesToLLMConversation(messages);
        conversation.push({
          role: "user",
          content:
            "Please extract the critical insights from the previous conversation.",
        });
        return chat(
          conversation,
          this.env.ANTHROPIC_API_KEY,
          DOCUMENT_SYSTEM_PROMPT
        );
      },
      RETRY_OPTS
    );

    await step.do("post-response", async () => {
      await sendLongMessage(
        threadInfo.parent_id!,
        `From "${threadInfo.name || "thread"}":\n${text}`,
        this.env.DISCORD_TOKEN
      );
      await deleteOriginalResponse(params.appId, params.interactionToken);
    });
  }

  private async processBranchWithSummary(
    params: BranchWithSummaryParams,
    step: WorkflowStep
  ) {
    const messages = await durable(step, "fetch-messages", () =>
      fetchContext(params.channelId, params.isThread, this.env.DISCORD_TOKEN)
    );

    const channelInfo = await durable(step, "get-channel-info", () =>
      getChannel(params.channelId, this.env.DISCORD_TOKEN)
    );

    const { text, usage } = await durable(
      step,
      "call-claude",
      async () => {
        const conversation = await discordMessagesToLLMConversation(messages);
        conversation.push({
          role: "user",
          content:
            "Please create a concise summary that captures all essential context needed to continue the discussion.",
        });
        return chat(
          conversation,
          this.env.ANTHROPIC_API_KEY,
          SUMMARIZE_SYSTEM_PROMPT
        );
      },
      RETRY_OPTS
    );

    await step.do("create-branch", async () => {
      const summaryText = `${SUMMARY_MARKER}\n${text}`;
      const tokenInfo = formatUsageInfo(usage);
      const sourceName = channelInfo.name || "thread";

      let targetId: string;
      if (params.isThread) {
        if (!channelInfo.parent_id) {
          await sendMessage(
            params.channelId,
            "Could not find parent channel for this thread.",
            this.env.DISCORD_TOKEN
          );
          await deleteOriginalResponse(params.appId, params.interactionToken);
          return;
        }
        const starterMsg = await sendMessage(
          channelInfo.parent_id,
          `**Branch with summary from "${sourceName}"**`,
          this.env.DISCORD_TOKEN
        );
        const newThread = await createThread(
          channelInfo.parent_id,
          starterMsg.id,
          `Branch of ${sourceName}`,
          this.env.DISCORD_TOKEN
        );
        targetId = newThread.id;
      } else {
        const newChannel = await createChannel(
          params.guildId,
          `branch-of-${sourceName}`,
          channelInfo.parent_id,
          this.env.DISCORD_TOKEN
        );
        targetId = newChannel.id;
      }

      await sendLongMessage(targetId, summaryText, this.env.DISCORD_TOKEN);
      await sendMessage(targetId, tokenInfo, this.env.DISCORD_TOKEN);
      await sendMessage(
        params.channelId,
        `Created new branch with summary: <#${targetId}>`,
        this.env.DISCORD_TOKEN
      );
      await deleteOriginalResponse(params.appId, params.interactionToken);
    });
  }
}
