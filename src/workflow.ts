/**
 * Cloudflare Workflow for processing LLM requests durably.
 * 
 * This runs without timeout limits, handling:
 * - Fetching Discord messages
 * - Calling Claude API
 * - Posting responses back to Discord
 */
import { WorkflowEntrypoint, WorkflowStep } from 'cloudflare:workers';
import type { WorkflowEvent } from 'cloudflare:workers';
import { 
  sendMessage, sendMessageWithFiles, getAllMessages, deleteOriginalResponse, 
  getChannel, createChannel, createThread, type DiscordMessage, type DiscordReaction 
} from './discord';
import { chat, type Message } from './claude';

// ============================================================================
// Workflow Parameters
// ============================================================================

export type JobType = 'chat' | 'summarize' | 'post-to-channel' | 'branch-with-summary';

interface BaseParams {
  type: JobType;
  channelId: string;
  interactionToken: string;
  appId: string;
}

interface ChatParams extends BaseParams {
  type: 'chat';
  isThread: boolean;
}

interface SummarizeParams extends BaseParams {
  type: 'summarize';
}

interface PostToChannelParams extends BaseParams {
  type: 'post-to-channel';
}

interface BranchWithSummaryParams extends BaseParams {
  type: 'branch-with-summary';
  isThread: boolean;
  guildId: string;
}

export type WorkflowParams = ChatParams | SummarizeParams | PostToChannelParams | BranchWithSummaryParams;

// ============================================================================
// Environment (secrets available to workflow)
// ============================================================================

export interface WorkflowEnv {
  DISCORD_TOKEN: string;
  DISCORD_APP_ID: string;
  ANTHROPIC_API_KEY: string;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_MESSAGE_LENGTH = 2000;
const SUMMARY_MARKER = '--- Summary so far ---';
const MAX_CONTEXT_TOKENS = 200000;

// Claude Sonnet 4.5 pricing (per million tokens)
const INPUT_PRICE_PER_M = 3.00;
const OUTPUT_PRICE_PER_M = 15.00;
const CACHE_READ_PRICE_PER_M = 0.30;
const CACHE_WRITE_PRICE_PER_M = 3.75;

// ============================================================================
// Utility Functions
// ============================================================================

const formatUsageInfo = (usage: Record<string, unknown>): string => {
  const inputTokens = (usage.input_tokens as number) || 0;
  const outputTokens = (usage.output_tokens as number) || 0;
  const cacheCreationTokens = (usage.cache_creation_input_tokens as number) || 0;
  const cacheReadTokens = (usage.cache_read_input_tokens as number) || 0;
  
  // Calculate costs
  const inputCost = (inputTokens / 1_000_000) * INPUT_PRICE_PER_M;
  const outputCost = (outputTokens / 1_000_000) * OUTPUT_PRICE_PER_M;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * CACHE_READ_PRICE_PER_M;
  const cacheWriteCost = (cacheCreationTokens / 1_000_000) * CACHE_WRITE_PRICE_PER_M;
  const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  
  // Context remaining
  const totalUsed = inputTokens + outputTokens;
  const remaining = MAX_CONTEXT_TOKENS - totalUsed;
  const percentUsed = ((totalUsed / MAX_CONTEXT_TOKENS) * 100).toFixed(1);
  
  // Build info string
  const parts: string[] = [];
  parts.push(`${remaining.toLocaleString()} tokens remaining (${percentUsed}% used)`);
  parts.push(`in: ${inputTokens.toLocaleString()}, out: ${outputTokens.toLocaleString()}`);
  
  if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
    parts.push(`cache: ${cacheReadTokens.toLocaleString()} read, ${cacheCreationTokens.toLocaleString()} write`);
  }
  
  parts.push(`$${totalCost.toFixed(4)}`);
  
  return `-# (${parts.join(' · ')})`;
};

const isSummaryMarker = (msg: DiscordMessage): boolean =>
  !!msg.author.bot && !!msg.content?.startsWith(SUMMARY_MARKER);

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

/** Parse LLM response for artifacts and message breaks */
function parseResponse(text: string): ParsedResponse {
  const artifacts: Artifact[] = [];
  
  console.log(`Parsing response of length ${text.length}`);
  
  // Extract XML-style file attachments
  const artifactRegex = /<groupthink:file-attachment\s+name="([^"]+)">([\s\S]*?)<\/groupthink:file-attachment>/g;
  let cleanedText = text.replace(artifactRegex, (_, filename, content) => {
    console.log(`Found artifact: ${filename} (${content.length} chars)`);
    artifacts.push({ name: filename.trim(), content: content.trim() });
    return ''; // Remove artifact from main text
  });
  
  console.log(`Found ${artifacts.length} artifacts`);
  
  // Split by message breaks
  const messages = cleanedText
    .split(/<groupthink:message-break\s*\/?>/)
    .map(m => m.trim())
    .filter(m => m.length > 0);
  
  console.log(`Split into ${messages.length} message parts`);
  
  // If no explicit breaks but text is too long, split smartly
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
    let splitIndex = remaining.lastIndexOf('\n\n', maxLen);
    
    // If no paragraph break, try single newline
    if (splitIndex === -1 || splitIndex < maxLen / 2) {
      splitIndex = remaining.lastIndexOf('\n', maxLen);
    }
    
    // If no newline, try sentence end
    if (splitIndex === -1 || splitIndex < maxLen / 2) {
      const sentenceEnd = remaining.slice(0, maxLen).match(/.*[.!?]\s/);
      splitIndex = sentenceEnd ? sentenceEnd[0].length : -1;
    }
    
    // Last resort: hard cut at space
    if (splitIndex === -1 || splitIndex < maxLen / 2) {
      splitIndex = remaining.lastIndexOf(' ', maxLen);
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

## Guidelines
- Reference thought leaders when relevant. Your job is to provide a best-in-class response, but also to open the door to further discussion.
- Be brief and to the point like William Strunk.
- Stay focused on the essence of the conversation like Greg McKeown.

## Message Format
- Messages from users are prefixed with their username in brackets like [username].
- Reactions are shown as [Reactions: 👍 x3, ❤️ x2] - these indicate agreement, appreciation, or emphasis.
- When addressing a user by name, use @username naturally in conversation.

## Discord Formatting (use these!)
- **bold** for emphasis
- *italic* for subtle emphasis  
- __underline__ for important terms
- ~~strikethrough~~ for corrections
- \`inline code\` for technical terms
- \`\`\`language for code blocks\`\`\`
- > for single-line quotes
- >>> for multi-line block quotes
- Bullet points and numbered lists work fine

## DO NOT USE
- Markdown tables (they don't render in Discord)
- Headers with # (they don't render)
- Complex nested formatting

## Response Structure
If your response is long, you can split it into multiple messages using:
<groupthink:message-break/>

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

const DOCUMENT_SYSTEM_PROMPT = `You are a helpful assistant that extracts critical insights from Discord thread discussions.

Your task is to identify and summarize:
1. Key insights and learnings
2. Important decisions made
3. Solutions discovered
4. Any conclusions or recommendations

Format the output as a clear, actionable summary that would be valuable to someone who didn't participate in the thread. Be concise but capture all essential information.`;

// ============================================================================
// Context Collection
// ============================================================================

async function getChannelContext(channelId: string, token: string): Promise<DiscordMessage[]> {
  const messages = await getAllMessages(channelId, token);
  console.log(`getAllMessages returned ${messages.length} messages`);
  
  const chronological = messages.reverse();
  
  // Find the most recent summary marker and INCLUDE it (it contains important context)
  let startIndex = 0;
  for (let i = chronological.length - 1; i >= 0; i--) {
    if (isSummaryMarker(chronological[i])) {
      console.log(`Found summary marker at index ${i}, including it and everything after`);
      startIndex = i;  // Include the summary itself
      break;
    }
  }
  
  const result = chronological.slice(startIndex);
  console.log(`Returning ${result.length} messages after filtering`);
  return result;
}

async function getThreadContext(threadId: string, token: string): Promise<DiscordMessage[]> {
  const threadInfo = await getChannel(threadId, token);
  const parentChannelId = threadInfo.parent_id;
  
  if (!parentChannelId) {
    const threadMessages = await getAllMessages(threadId, token);
    return threadMessages.reverse();
  }
  
  const [channelMessages, threadMessages] = await Promise.all([
    getChannelContext(parentChannelId, token),
    getAllMessages(threadId, token),
  ]);
  
  return [...channelMessages, ...threadMessages.reverse()];
}

// ============================================================================
// Conversation Conversion
// ============================================================================

type UserMap = Map<string, string>;

/** Format reactions for display */
function formatReactions(reactions?: DiscordReaction[]): string {
  if (!reactions || reactions.length === 0) return '';
  const parts = reactions.map(r => `${r.emoji.name} x${r.count}`);
  return `\n[Reactions: ${parts.join(', ')}]`;
}

function toConversation(
  messages: DiscordMessage[], 
  botUsername = 'GroupThink'
): { conversation: Message[]; userMap: UserMap } {
  const conversation: Message[] = [];
  const userMap: UserMap = new Map();
  
  for (const msg of messages) {
    if (!msg.content?.trim()) continue;
    
    // Include summary markers as system context (user role so Claude sees it)
    if (isSummaryMarker(msg)) {
      conversation.push({ 
        role: 'user', 
        content: `[Previous conversation summary]:\n${msg.content}` 
      });
      continue;
    }
    
    const parsed = parseMessageRole(msg, botUsername);
    if (!parsed) continue;
    
    const { role, content, userId, username } = parsed;
    
    // Add reactions to the content if present
    const contentWithReactions = content + formatReactions(msg.reactions);
    
    if (userId) userMap.set(userId, userId);
    if (username) userMap.set(username.toLowerCase(), msg.author.id);
    
    const last = conversation[conversation.length - 1];
    if (last?.role === role) {
      last.content += '\n' + contentWithReactions;
    } else {
      conversation.push({ role, content: contentWithReactions });
    }
  }
  
  while (conversation.length > 0 && conversation[0].role !== 'user') {
    conversation.shift();
  }
  
  if (conversation.length > 0 && conversation[conversation.length - 1].role === 'assistant') {
    conversation.push({ role: 'user', content: '[System]: Please continue the conversation.' });
  }
  
  return { conversation, userMap };
}

function parseMessageRole(
  msg: DiscordMessage, 
  botUsername: string
): { role: 'user' | 'assistant'; content: string; userId?: string; username?: string } | null {
  const content = msg.content;
  
  if (!content?.trim()) return null;
  
  if (content.startsWith('-# (') && (content.includes('tokens') || content.includes('remaining'))) {
    return null;
  }
  
  const userMentionMatch = content.match(/^<@(\d+)>:\s*([\s\S]*)$/);
  if (msg.author.bot && userMentionMatch) {
    return { role: 'user', content: userMentionMatch[2], userId: userMentionMatch[1] };
  }
  
  if (msg.author.bot && msg.author.username === botUsername) {
    return { role: 'assistant', content };
  }
  
  if (msg.author.bot) {
    return { role: 'user', content: `[${msg.author.username}]: ${content}` };
  }
  
  return { 
    role: 'user', 
    content: `[${msg.author.username}]: ${content}`,
    username: msg.author.username 
  };
}

const convertMentions = (text: string, userMap: UserMap): string =>
  text.replace(/@(\w+)/g, (match, username) => {
    const userId = userMap.get(username.toLowerCase());
    return userId ? `<@${userId}>` : match;
  });

// ============================================================================
// The Workflow
// ============================================================================

export class GroupThinkWorkflow extends WorkflowEntrypoint<WorkflowEnv, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    console.log(`Starting workflow: ${params.type} for channel ${params.channelId}`);

    try {
      switch (params.type) {
        case 'chat':
          await this.processChat(params, step);
          break;
        case 'summarize':
          await this.processSummarize(params, step);
          break;
        case 'post-to-channel':
          await this.processPostToChannel(params, step);
          break;
        case 'branch-with-summary':
          await this.processBranchWithSummary(params, step);
          break;
      }
    } catch (err) {
      console.error('Workflow error:', err);
      // Try to send error message
      await step.do('send-error', async () => {
        await sendMessage(params.channelId, `❌ Error: ${err}`, this.env.DISCORD_TOKEN);
        await deleteOriginalResponse(params.appId, params.interactionToken);
      });
      throw err;
    }
  }

  private async processChat(params: ChatParams, step: WorkflowStep) {
    // Step 1: Fetch messages (serialize for durability)
    const messagesJson = await step.do('fetch-messages', async () => {
      const msgs = params.isThread
        ? await getThreadContext(params.channelId, this.env.DISCORD_TOKEN)
        : await getChannelContext(params.channelId, this.env.DISCORD_TOKEN);
      return JSON.stringify(msgs);
    });

    const messages: DiscordMessage[] = JSON.parse(messagesJson);
    console.log(`Fetched ${messages.length} messages`);

    // Step 2: Convert to conversation
    const { conversation, userMap } = toConversation(messages);
    
    if (conversation.length === 0) {
      await step.do('send-empty-response', async () => {
        await sendMessage(params.channelId, 'No conversation history found.', this.env.DISCORD_TOKEN);
        await deleteOriginalResponse(params.appId, params.interactionToken);
      });
      return;
    }

    // Step 3: Call Claude (serialize for durability)
    const responseJson = await step.do('call-claude', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'linear' }
    }, async () => {
      const { text, usage } = await chat(conversation, this.env.ANTHROPIC_API_KEY, CHAT_SYSTEM_PROMPT);
      return JSON.stringify({ text, usage, userMap: Object.fromEntries(userMap) });
    });

    // Step 4: Post response to Discord
    await step.do('post-response', async () => {
      const { text, usage, userMap: userMapObj } = JSON.parse(responseJson) as { 
        text: string; 
        usage: Record<string, number>; 
        userMap: Record<string, string> 
      };
      const userMapRestored = new Map(Object.entries(userMapObj));
      const tokenInfo = formatUsageInfo(usage);
      
      // Parse response for artifacts and message breaks
      const { messages: msgParts, artifacts } = parseResponse(text);
      
      // Send each message part
      for (let i = 0; i < msgParts.length; i++) {
        const part = convertMentions(msgParts[i], userMapRestored);
        
        // Attach artifacts to the last message
        if (i === msgParts.length - 1 && artifacts.length > 0) {
          await sendMessageWithFiles(params.channelId, part, artifacts, this.env.DISCORD_TOKEN);
        } else {
          await sendMessage(params.channelId, part, this.env.DISCORD_TOKEN);
        }
      }
      
      // Send token info
      await sendMessage(params.channelId, tokenInfo, this.env.DISCORD_TOKEN);
      await deleteOriginalResponse(params.appId, params.interactionToken);
    });

    console.log('Chat workflow completed');
  }

  private async processSummarize(params: SummarizeParams, step: WorkflowStep) {
    // Step 1: Fetch messages (serialize for durability)
    const messagesJson = await step.do('fetch-messages', async () => {
      const msgs = await getChannelContext(params.channelId, this.env.DISCORD_TOKEN);
      return JSON.stringify(msgs);
    });

    const messages: DiscordMessage[] = JSON.parse(messagesJson);
    const { conversation } = toConversation(messages);
    
    if (conversation.length === 0) {
      await step.do('send-empty-response', async () => {
        await sendMessage(params.channelId, 'No conversation to summarize.', this.env.DISCORD_TOKEN);
        await deleteOriginalResponse(params.appId, params.interactionToken);
      });
      return;
    }

    // Step 2: Call Claude to summarize (serialize for durability)
    const responseJson = await step.do('call-claude', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'linear' }
    }, async () => {
      const summaryPrompt: Message[] = [
        { 
          role: 'user', 
          content: `Please summarize the following conversation:\n\n${conversation.map(m => `${m.role}: ${m.content}`).join('\n\n')}`
        }
      ];
      const result = await chat(summaryPrompt, this.env.ANTHROPIC_API_KEY, SUMMARIZE_SYSTEM_PROMPT);
      return JSON.stringify(result);
    });

    // Step 3: Post summary (use smart splitting for long summaries)
    await step.do('post-response', async () => {
      const { text, usage } = JSON.parse(responseJson) as { text: string; usage: Record<string, number> };
      const summaryMessage = `${SUMMARY_MARKER}\n${text}`;
      const tokenInfo = formatUsageInfo(usage);
      
      // Split if too long
      const parts = splitLongMessage(summaryMessage);
      for (const part of parts) {
        await sendMessage(params.channelId, part, this.env.DISCORD_TOKEN);
      }
      
      await sendMessage(params.channelId, tokenInfo, this.env.DISCORD_TOKEN);
      await deleteOriginalResponse(params.appId, params.interactionToken);
    });

    console.log('Summarize workflow completed');
  }

  private async processPostToChannel(params: PostToChannelParams, step: WorkflowStep) {
    // Step 1: Get thread info (serialize for durability)
    const threadInfoJson = await step.do('get-thread-info', async () => {
      const info = await getChannel(params.channelId, this.env.DISCORD_TOKEN);
      return JSON.stringify(info);
    });

    const threadInfo = JSON.parse(threadInfoJson) as { parent_id?: string; name?: string };
    const parentChannelId = threadInfo.parent_id;
    
    if (!parentChannelId) {
      await step.do('send-error-response', async () => {
        await sendMessage(params.channelId, 'Could not find parent channel.', this.env.DISCORD_TOKEN);
        await deleteOriginalResponse(params.appId, params.interactionToken);
      });
      return;
    }

    // Step 2: Fetch thread messages (serialize for durability)
    const messagesJson = await step.do('fetch-messages', async () => {
      const threadMessages = await getAllMessages(params.channelId, this.env.DISCORD_TOKEN);
      return JSON.stringify(threadMessages.reverse());
    });

    const messages: DiscordMessage[] = JSON.parse(messagesJson);
    const { conversation } = toConversation(messages);
    
    if (conversation.length === 0) {
      await step.do('send-empty-response', async () => {
        await sendMessage(params.channelId, 'No conversation to post.', this.env.DISCORD_TOKEN);
        await deleteOriginalResponse(params.appId, params.interactionToken);
      });
      return;
    }

    // Step 3: Call Claude to extract insights (serialize for durability)
    const responseJson = await step.do('call-claude', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'linear' }
    }, async () => {
      const documentPrompt: Message[] = [
        { 
          role: 'user', 
          content: `Please extract the critical insights from this thread discussion:\n\n${conversation.map(m => `${m.role}: ${m.content}`).join('\n\n')}`
        }
      ];
      const result = await chat(documentPrompt, this.env.ANTHROPIC_API_KEY, DOCUMENT_SYSTEM_PROMPT);
      return JSON.stringify(result);
    });

    // Step 4: Post to parent channel (use smart splitting for long documents)
    await step.do('post-response', async () => {
      const { text, usage } = JSON.parse(responseJson) as { text: string; usage: Record<string, number> };
      const threadName = threadInfo.name || 'thread';
      const documentMessage = `📋 **Insights from "${threadName}"**\n\n${text}`;
      const tokenInfo = formatUsageInfo(usage);
      
      // Split if too long
      const parts = splitLongMessage(documentMessage);
      for (const part of parts) {
        await sendMessage(parentChannelId, part, this.env.DISCORD_TOKEN);
      }
      
      await sendMessage(parentChannelId, tokenInfo, this.env.DISCORD_TOKEN);
      await deleteOriginalResponse(params.appId, params.interactionToken);
    });

    console.log('Post-to-channel workflow completed');
  }

  private async processBranchWithSummary(params: BranchWithSummaryParams, step: WorkflowStep) {
    // Step 1: Fetch messages (serialize for durability)
    const messagesJson = await step.do('fetch-messages', async () => {
      const msgs = params.isThread
        ? await getThreadContext(params.channelId, this.env.DISCORD_TOKEN)
        : await getChannelContext(params.channelId, this.env.DISCORD_TOKEN);
      return JSON.stringify(msgs);
    });

    const messages: DiscordMessage[] = JSON.parse(messagesJson);
    const { conversation } = toConversation(messages);
    
    if (conversation.length === 0) {
      await step.do('send-empty-response', async () => {
        await sendMessage(params.channelId, 'No conversation to branch.', this.env.DISCORD_TOKEN);
        await deleteOriginalResponse(params.appId, params.interactionToken);
      });
      return;
    }

    // Step 2: Get channel info for naming (serialize for durability)
    const channelInfoJson = await step.do('get-channel-info', async () => {
      const info = await getChannel(params.channelId, this.env.DISCORD_TOKEN);
      return JSON.stringify(info);
    });

    const channelInfo = JSON.parse(channelInfoJson) as { parent_id?: string; name?: string };

    // Step 3: Call Claude to summarize (serialize for durability)
    const responseJson = await step.do('call-claude', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'linear' }
    }, async () => {
      const summaryPrompt: Message[] = [
        { 
          role: 'user', 
          content: `Please create a concise summary of this conversation that captures all essential context needed to continue the discussion:\n\n${conversation.map(m => `${m.role}: ${m.content}`).join('\n\n')}`
        }
      ];
      const result = await chat(summaryPrompt, this.env.ANTHROPIC_API_KEY, SUMMARIZE_SYSTEM_PROMPT);
      return JSON.stringify(result);
    });

    // Step 4: Create new channel/thread with summary
    await step.do('create-branch', async () => {
      const { text, usage } = JSON.parse(responseJson) as { text: string; usage: Record<string, number> };
      const tokenInfo = formatUsageInfo(usage);
      const summaryMessage = `${SUMMARY_MARKER}\n${text}`;
      
      if (params.isThread) {
        // In a thread: create a new thread in the parent channel
        const parentChannelId = channelInfo.parent_id;
        
        if (!parentChannelId) {
          await sendMessage(params.channelId, 'Could not find parent channel for this thread.', this.env.DISCORD_TOKEN);
          await deleteOriginalResponse(params.appId, params.interactionToken);
          return;
        }
        
        // Create a starter message for the new thread
        const starterMsg = await sendMessage(parentChannelId, `**Branch with summary from "${channelInfo.name || 'thread'}"**`, this.env.DISCORD_TOKEN);
        const newThread = await createThread(parentChannelId, starterMsg.id, `Branch of ${channelInfo.name || 'thread'}`, this.env.DISCORD_TOKEN);
        
        // Post summary to new thread
        const parts = splitLongMessage(summaryMessage);
        for (const part of parts) {
          await sendMessage(newThread.id, part, this.env.DISCORD_TOKEN);
        }
        await sendMessage(newThread.id, tokenInfo, this.env.DISCORD_TOKEN);
        
        await sendMessage(params.channelId, `Created new branch with summary: <#${newThread.id}>`, this.env.DISCORD_TOKEN);
      } else {
        // In a channel: create a new channel in the same category
        const newChannel = await createChannel(
          params.guildId,
          `branch-of-${channelInfo.name || 'channel'}`,
          channelInfo.parent_id,
          this.env.DISCORD_TOKEN
        );
        
        // Post summary to new channel
        const parts = splitLongMessage(summaryMessage);
        for (const part of parts) {
          await sendMessage(newChannel.id, part, this.env.DISCORD_TOKEN);
        }
        await sendMessage(newChannel.id, tokenInfo, this.env.DISCORD_TOKEN);
        
        await sendMessage(params.channelId, `Created new branch with summary: <#${newChannel.id}>`, this.env.DISCORD_TOKEN);
      }
      
      await deleteOriginalResponse(params.appId, params.interactionToken);
    });

    console.log('Branch-with-summary workflow completed');
  }
}
