/**
 * Claude (Anthropic) API client.
 * Shared request builder with two calling strategies:
 *   chat      — single request/response (summaries, extractions)
 *   chatStream — SSE streaming with optional multi-round tool use
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

export type ModelTier = "haiku" | "sonnet" | "opus";

const MODEL_IDS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-5",
  opus: "claude-opus-4-5",
};

export function getModelId(tier: ModelTier): string {
  return MODEL_IDS[tier] ?? MODEL_IDS.sonnet;
}

const WEB_SEARCH_TOOL = {
  type: "web_search_20250305" as const,
  name: "web_search" as const,
  max_uses: 5,
};

export interface Message {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        (
          | { type: "text"; text: string }
          | {
              type: "image";
              source: {
                type: "base64";
                media_type: "image/jpeg";
                data: string;
              };
            }
        ) & { cache_control?: typeof CACHE_TTL }
      >;
}

export interface ChatResponse {
  text: string;
  usage: Record<string, unknown>;
  toolsUsed?: string[];
}

// ============================================================================
// Prompt Caching
// ============================================================================

/** Cache the conversation prefix: one breakpoint on the last message.
 *  Anthropic's 20-block lookback finds the longest cached prefix automatically. */
const CACHE_TTL = { type: "ephemeral" as const, ttl: "1h" as const };

export function withCaching(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const result = messages.map((m) => ({ ...m }));
  // Two cache breakpoints:
  // 1. The last user message (caches the full current request)
  // 2. The last user message before the bot's most recent response
  //    (anchors the prefix — this was breakpoint #1 on the previous call)
  const lastUser = result.findLastIndex((m) => m.role === "user");
  if (lastUser >= 0) markCached(result[lastUser]);

  const lastAssistant = result.findLastIndex((m) => m.role === "assistant");
  if (lastAssistant > 0) {
    const anchorUser = result.findLastIndex(
      (m, i) => i < lastAssistant && m.role === "user",
    );
    if (anchorUser >= 0 && anchorUser !== lastUser)
      markCached(result[anchorUser]);
  }
  return result;
}

function markCached(msg: Message): void {
  if (typeof msg.content === "string") {
    msg.content = [
      { type: "text", text: msg.content, cache_control: CACHE_TTL },
    ];
  } else {
    const parts = [...msg.content];
    parts[parts.length - 1] = {
      ...parts[parts.length - 1],
      cache_control: CACHE_TTL,
    };
    msg.content = parts;
  }
}

// ============================================================================
// Shared Request Helpers
// ============================================================================

const DEFAULT_SYSTEM = "You are a helpful assistant in a Discord chat.";

const apiHeaders = (apiKey: string) => ({
  "Content-Type": "application/json",
  "x-api-key": apiKey,
  "anthropic-version": "2023-06-01",
});

/** Build the standard request body. Caller is responsible for caching. */
function buildBody(
  messages: Message[],
  systemPrompt: string | undefined,
  modelTier: ModelTier,
  extra?: Record<string, unknown>,
) {
  return {
    model: getModelId(modelTier),
    max_tokens: 8192,
    system: systemPrompt ?? DEFAULT_SYSTEM,
    messages,
    ...extra,
  };
}

/** POST to Anthropic API with shared headers and error handling. */
async function apiPost(
  apiKey: string,
  body: object,
  signal?: AbortSignal
): Promise<Response> {
  const res = await fetch(ANTHROPIC_API, {
    signal,
    method: "POST",
    headers: apiHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
  }
  return res;
}

// ============================================================================
// chat — single request/response
// ============================================================================

export async function chat(
  messages: Message[],
  apiKey: string,
  systemPrompt?: string,
  modelTier: ModelTier = "sonnet"
): Promise<ChatResponse> {
  const res = await apiPost(
    apiKey,
    buildBody(messages, systemPrompt, modelTier)
  );
  const data: {
    content: Array<{ type: string; text: string }>;
    usage: Record<string, unknown>;
  } = await res.json();
  return { text: data.content[0]?.text ?? "", usage: data.usage };
}

// ============================================================================
// chatStream — SSE streaming with optional multi-round tool use
//
// Always streams. Web search is always available.
// When tools + resolveTool are provided, enters a multi-round loop:
//   stream → collect tool_use blocks → resolve → stream next round.
// Text deltas fire onUpdate incrementally across all rounds.
// ============================================================================

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ChatStreamOptions {
  modelTier?: ModelTier;
  tools?: AnthropicTool[];
  resolveTool?: (
    name: string,
    input: Record<string, unknown>
  ) => Promise<string>;
  onToolCall?: (name: string) => void | Promise<void>;
  onUpdate?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export async function chatStream(
  messages: Message[],
  apiKey: string,
  systemPrompt?: string,
  options: ChatStreamOptions = {}
): Promise<ChatResponse> {
  const {
    modelTier = "sonnet",
    signal,
    onUpdate,
    tools = [],
    resolveTool,
    onToolCall,
  } = options;

  console.log(
    "first and last 2 messages",
    JSON.stringify(
      [...messages.slice(0, 2), ...messages.slice(-2)].map((m) => ({
        role: m.role,
        content:
          typeof m.content === "string"
            ? m.content.slice(0, 30)
            : m.content.map((c) =>
                c.type === "text"
                  ? {
                      type: c.type,
                      text: c.text.slice(0, 20),
                      cache_control: c.cache_control,
                    }
                  : {
                      type: c.type,
                      cache_control: c.cache_control,
                    }
              ),
      })),
      null,
      2
    )
  );

  const allTools: unknown[] = [WEB_SEARCH_TOOL, ...tools];
  const apiMessages: unknown[] = [...messages];

  // Cache debug: log a fingerprint of the request prefix
  {
    const toolNames = tools
      .map((t) => t.name)
      .sort()
      .join(",");
    const msgCount = messages.length;
    const sysLen = (systemPrompt ?? DEFAULT_SYSTEM).length;
    const firstMsg = messages[0]
      ? JSON.stringify(messages[0].content).slice(0, 80)
      : "(none)";
    const lastMsg = messages[msgCount - 1]
      ? JSON.stringify(messages[msgCount - 1].content).slice(0, 80)
      : "(none)";
    // Log last 5 messages (role + first 60 chars of content)
    const tail5 = messages.slice(-5).map((m, i) => {
      const c =
        typeof m.content === "string"
          ? m.content.slice(0, 60)
          : JSON.stringify(m.content).slice(0, 60);
      return `  [${msgCount - 5 + i}] ${m.role}: ${c}`;
    });
    // Hash the full request prefix to detect any non-obvious differences
    const toolsJson = JSON.stringify(allTools);
    const msgsJson = JSON.stringify(apiMessages);
    const prefixLen = toolsJson.length + (systemPrompt ?? DEFAULT_SYSTEM).length + msgsJson.length;
    // Simple hash: sum of char codes mod a large prime
    let hash = 0;
    for (const s of [toolsJson, systemPrompt ?? DEFAULT_SYSTEM, msgsJson]) {
      for (let j = 0; j < s.length; j++) hash = (hash * 31 + s.charCodeAt(j)) | 0;
    }
    console.log(
      `[cache-debug] model=${modelTier} tools=[${toolNames}] sysLen=${sysLen} msgs=${msgCount} prefixLen=${prefixLen} hash=${hash}`,
    );
    console.log(`[cache-debug] first: ${firstMsg}`);
    console.log(`[cache-debug] last: ${lastMsg}`);
    console.log(`[cache-debug] tail:\n${tail5.join("\n")}`);
  }

  let fullText = "";
  let usage: Record<string, unknown> = {};
  const toolsUsed: string[] = [];
  const MAX_ROUNDS = 10;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await apiPost(
      apiKey,
      {
        model: getModelId(modelTier),
        max_tokens: 8192,
        system: systemPrompt ?? DEFAULT_SYSTEM,
        messages: apiMessages,
        tools: allTools,
        stream: true,
      },
      signal
    );

    const {
      toolUses,
      contentBlocks,
      usage: roundUsage,
    } = await readToolStream(
      res,
      async (delta) => {
        fullText += delta;
        await onUpdate?.(fullText);
      },
      signal
    );

    console.log(
      `[cache-debug] round=${round} cacheRead=${roundUsage.cache_read_input_tokens ?? 0} cacheWrite=${roundUsage.cache_creation_input_tokens ?? 0} input=${roundUsage.input_tokens ?? 0} output=${roundUsage.output_tokens ?? 0}`
    );
    usage = mergeUsage(usage, roundUsage);

    if (toolUses.length === 0 || !resolveTool) break;

    // Resolve tool calls, then continue the loop
    for (const t of toolUses) toolsUsed.push(t.name);
    apiMessages.push({ role: "assistant", content: contentBlocks });

    const toolResults = await Promise.all(
      toolUses.map(async (t) => {
        await onToolCall?.(t.name);
        const result = await resolveTool(t.name, t.input);
        return {
          type: "tool_result" as const,
          tool_use_id: t.id,
          content: result,
        };
      })
    );
    apiMessages.push({ role: "user", content: toolResults });
  }

  if (Object.keys(usage).length === 0) {
    usage = { input_tokens: 0, output_tokens: 0 };
  }

  return {
    text: fullText,
    usage,
    toolsUsed: toolsUsed.length ? toolsUsed : undefined,
  };
}

// ============================================================================
// SSE Stream Reader
// ============================================================================

interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface StreamRound {
  toolUses: ToolUse[];
  contentBlocks: unknown[];
  usage: Record<string, unknown>;
}

/** Read one round of SSE, calling onTextDelta for each text chunk. */
async function readToolStream(
  res: Response,
  onTextDelta: ((delta: string) => void | Promise<void>) | undefined,
  signal?: AbortSignal
): Promise<StreamRound> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Record<string, unknown> = {};

  const contentBlocks: unknown[] = [];
  let current: {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    inputJson?: string;
  } | null = null;

  const processLine = async (line: string) => {
    if (!line.startsWith("data: ")) return;
    const raw = line.slice(6);
    if (raw === "[DONE]" || raw === "") return;
    try {
      const ev = JSON.parse(raw);
      switch (ev.type) {
        case "content_block_start": {
          const b = ev.content_block;
          if (b.type === "text") {
            current = { type: "text", text: "" };
          } else if (b.type === "tool_use") {
            current = {
              type: "tool_use",
              id: b.id,
              name: b.name,
              inputJson: "",
            };
          } else {
            current = null; // ignore web_search_tool_result etc.
          }
          break;
        }
        case "content_block_delta": {
          if (!current) break;
          if (ev.delta?.type === "text_delta" && current.type === "text") {
            current.text += ev.delta.text;
            await onTextDelta?.(ev.delta.text);
          } else if (
            ev.delta?.type === "input_json_delta" &&
            current.type === "tool_use"
          ) {
            current.inputJson += ev.delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          if (!current) break;
          if (current.type === "text") {
            contentBlocks.push({ type: "text", text: current.text });
          } else if (current.type === "tool_use") {
            try {
              const input = JSON.parse(current.inputJson || "{}");
              contentBlocks.push({
                type: "tool_use",
                id: current.id,
                name: current.name,
                input,
              });
            } catch {
              /* invalid tool JSON */
            }
          }
          current = null;
          break;
        }
        case "message_start": {
          if (ev.message?.usage) usage = { ...usage, ...ev.message.usage };
          break;
        }
        case "message_delta": {
          if (ev.usage) usage = { ...usage, ...ev.usage };
          break;
        }
      }
    } catch {
      // ignore parse errors
    }
  };

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) await processLine(line);
    }
    for (const line of buffer.split("\n")) await processLine(line);
  } catch (err) {
    if (!(err instanceof Error && err.name === "AbortError")) throw err;
  }

  const toolUses: ToolUse[] = contentBlocks
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => ({ id: b.id, name: b.name, input: b.input }));

  return { toolUses, contentBlocks, usage };
}

/** Sum numeric usage fields across rounds. */
function mergeUsage(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...a };
  for (const [key, val] of Object.entries(b)) {
    if (typeof val === "number" && typeof result[key] === "number") {
      result[key] = (result[key] as number) + val;
    } else {
      result[key] = val;
    }
  }
  return result;
}
