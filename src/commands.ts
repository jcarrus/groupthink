/**
 * Command handlers for /chat.
 * 
 * Three modes:
 * 1. /chat <message> in channel → post message, create thread, Claude responds in thread
 * 2. /chat in thread → fetch history, Claude continues conversation
 * 3. /chat in channel (no message) → read recent messages, Claude summarizes and starts thread
 */
import { InteractionResponseType } from 'discord-interactions';
import type { Env } from './index';
import { 
  sendMessage, getMessages, getAllMessages, editOriginalResponse, 
  deleteOriginalResponse, createThread, getChannel, getMessage,
  type DiscordMessage 
} from './discord';
import { chat, type Message } from './claude';

const MAX_MESSAGE_LENGTH = 2000;

// ============================================================================
// Utility Functions
// ============================================================================

const truncate = (text: string): string =>
  text.length <= MAX_MESSAGE_LENGTH ? text : text.slice(0, MAX_MESSAGE_LENGTH - 3) + '...';

const isThread = (channelType: number): boolean =>
  channelType === 11 || channelType === 12;

const parseMessageLink = (content: string): { channelId: string; messageId: string } | null => {
  const match = content.match(/https:\/\/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/);
  return match ? { channelId: match[1], messageId: match[2] } : null;
};

// ============================================================================
// Thread History Utilities
// ============================================================================

/** Get a thread's starter message from its parent channel */
async function getThreadStarter(threadId: string, token: string): Promise<DiscordMessage | null> {
  const channel = await getChannel(threadId, token);
  if (!channel.parent_id) return null;
  
  try {
    // Thread ID equals starter message ID
    return await getMessage(channel.parent_id, threadId, token);
  } catch {
    return null;
  }
}

/** Check if messages indicate a branched thread, return branch info */
function detectBranch(messages: DiscordMessage[]): { originalChannelId: string; branchPointMessageId: string } | null {
  for (const msg of messages.slice(0, 5)) {
    if (msg.content?.startsWith('Branched from ')) {
      const linkInfo = parseMessageLink(msg.content);
      if (linkInfo) {
        return { originalChannelId: linkInfo.channelId, branchPointMessageId: linkInfo.messageId };
      }
    }
  }
  return null;
}

/** 
 * Get full thread history, recursively resolving branches.
 * Returns chronological messages from the root conversation through all branch points.
 */
async function getFullThreadHistory(threadId: string, token: string, depth = 0): Promise<DiscordMessage[]> {
  if (depth > 10) {
    console.log(`⚠️ Max branch depth reached`);
    return [];
  }
  
  const [starter, messages] = await Promise.all([
    getThreadStarter(threadId, token),
    getAllMessages(threadId, token),
  ]);
  
  const chronological = messages.reverse();
  const withStarter = starter?.content ? [starter, ...chronological] : chronological;
  
  // Check if this thread is itself a branch
  const branchInfo = detectBranch(withStarter);
  if (!branchInfo) {
    return withStarter;
  }
  
  // Recursively get the parent branch's history
  console.log(`  ↳ Branch depth ${depth + 1}: resolving ${branchInfo.originalChannelId}`);
  const parentHistory = await getFullThreadHistory(branchInfo.originalChannelId, token, depth + 1);
  
  // Find branch point and truncate parent history
  const branchPointIndex = parentHistory.findIndex(m => m.id === branchInfo.branchPointMessageId);
  const relevantParent = branchPointIndex >= 0 
    ? parentHistory.slice(0, branchPointIndex + 1)
    : parentHistory;
  
  // Filter out "Branched from" and starter messages from this branch
  const thisBranchMessages = withStarter.filter(m => 
    !m.content?.startsWith('Branched from ') && m.id !== starter?.id
  );
  
  return [...relevantParent, ...thisBranchMessages];
}

// ============================================================================
// Conversation Conversion
// ============================================================================

type UserMap = Map<string, string>;

/** Convert Discord messages to Claude conversation format */
function toConversation(
  messages: DiscordMessage[], 
  botUsername = 'TreeChat'
): { conversation: Message[]; userMap: UserMap } {
  const conversation: Message[] = [];
  const userMap: UserMap = new Map();
  
  for (const msg of messages) {
    if (!msg.content?.trim()) continue;
    
    const parsed = parseMessageRole(msg, botUsername);
    if (!parsed) continue;
    
    const { role, content, userId, username } = parsed;
    
    // Track user IDs for mention conversion
    if (userId) userMap.set(userId, userId);
    if (username) userMap.set(username.toLowerCase(), msg.author.id);
    
    // Merge consecutive assistant messages
    const last = conversation[conversation.length - 1];
    if (last?.role === role && role === 'assistant') {
      last.content += '\n' + content;
    } else {
      conversation.push({ role, content });
    }
  }
  
  // Claude requires conversation to start with user
  if (conversation[0]?.role !== 'user') conversation.shift();
  
  return { conversation, userMap };
}

/** Parse a single message to determine role and content */
function parseMessageRole(
  msg: DiscordMessage, 
  botUsername: string
): { role: 'user' | 'assistant'; content: string; userId?: string; username?: string } | null {
  const content = msg.content;
  
  // Bot message with user mention prefix: "<@123>: message"
  const userMentionMatch = content.match(/^<@(\d+)>:\s*([\s\S]*)$/);
  if (msg.author.bot && userMentionMatch) {
    return { role: 'user', content: userMentionMatch[2], userId: userMentionMatch[1] };
  }
  
  // Legacy Mode 3 starter: "Working on "request" for username..."
  const workingOnMatch = content.match(/^Working on "(.+?)"(?:\.{3})? for (\w+)/);
  if (msg.author.bot && workingOnMatch) {
    return { role: 'user', content: `[${workingOnMatch[2]}]: ${workingOnMatch[1]}` };
  }
  
  // Bot message with bot name prefix: "**BotName**: message"
  const botMentionMatch = content.match(/^\*\*(.+?)\*\*:\s*([\s\S]*)$/);
  if (msg.author.bot && botMentionMatch && botMentionMatch[1] === botUsername) {
    return { role: 'assistant', content: botMentionMatch[2] };
  }
  
  // Regular bot message
  if (msg.author.bot) {
    return { role: 'assistant', content };
  }
  
  // Regular user message
  return { 
    role: 'user', 
    content: `[${msg.author.username}]: ${content}`,
    username: msg.author.username 
  };
}

/** Convert @username mentions in response to Discord <@id> format */
const convertMentions = (text: string, userMap: UserMap): string =>
  text.replace(/@(\w+)/g, (match, username) => {
    const userId = userMap.get(username.toLowerCase());
    return userId ? `<@${userId}>` : match;
  });

// ============================================================================
// Logging Utilities
// ============================================================================

function logThreadMessages(messages: DiscordMessage[], label: string) {
  console.log(`\n--- ${label} (${messages.length} total) ---`);
  for (const m of messages) {
    const icon = m.author.bot ? '🤖' : '👤';
    const preview = m.content?.slice(0, 60) || '(empty)';
    console.log(`  [${m.id}] ${icon} ${m.author.username}: "${preview}"`);
  }
}

function logConversation(conversation: Message[]) {
  console.log(`\n--- SENDING TO CLAUDE (${conversation.length} messages) ---`);
  for (let i = 0; i < conversation.length; i++) {
    const role = conversation[i].role === 'user' ? '👤 USER' : '🤖 ASST';
    const preview = conversation[i].content.slice(0, 100);
    const ellipsis = conversation[i].content.length > 100 ? '...' : '';
    console.log(`  [${i}] ${role}: "${preview}${ellipsis}"`);
  }
}

function logUsage(usage: Record<string, unknown>) {
  console.log(`\n--- USAGE ---`);
  console.log(JSON.stringify(usage));
}

// ============================================================================
// Command Handlers
// ============================================================================

const SYSTEM_PROMPT = `You are a helpful assistant in a Discord chat with a group of highly intelligent and knowledgeable individuals.

- Reference thought leaders when relevant. Your job is to provide a best-in-class response, but also to open the door to further discussion.
- Be brief and to the point like William Strunk.
- Stay focused on the essence of the conversation like Greg McKeown.

Messages from users are prefixed with their username in brackets like [username]. When addressing a user by name, use @username naturally in conversation (e.g., "Sure @justin, here's..." or "Great question @sarah!").`;

export function handleChatCommand(interaction: any, env: Env, ctx: ExecutionContext): Response {
  const userMessage = interaction.data?.options?.find((o: any) => o.name === 'message')?.value as string | undefined;
  const channelId = interaction.channel_id;
  const channelType = interaction.channel?.type ?? 0;
  
  const mode = userMessage ? 'MODE 1: New conversation' 
    : isThread(channelType) ? 'MODE 2: Continue thread'
    : 'MODE 3: Channel summary';
  
  console.log(`\n========== /chat REQUEST ==========`);
  console.log(mode);
  console.log(`Channel: ${channelId} (type: ${channelType})`);
  if (userMessage) console.log(`Message: "${userMessage.slice(0, 100)}"`);
  console.log(`===================================\n`);

  ctx.waitUntil((async () => {
    try {
      if (userMessage) {
        await handleNewConversation(userMessage, channelId, interaction, env);
      } else if (isThread(channelType)) {
        await handleThreadContinuation(channelId, interaction, env);
      } else {
        await handleChannelSummary(channelId, interaction, env);
      }
    } catch (err) {
      console.error('Error:', err);
      await editOriginalResponse(env.DISCORD_APP_ID, interaction.token, `Error: ${err}`);
    }
  })());

  return Response.json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
}

/** Mode 1: New conversation with explicit prompt */
async function handleNewConversation(userMessage: string, channelId: string, interaction: any, env: Env) {
  const starterMsg = await sendMessage(channelId, userMessage, env.DISCORD_TOKEN);
  const threadName = truncate(userMessage).slice(0, 50);
  const thread = await createThread(channelId, starterMsg.id, threadName, env.DISCORD_TOKEN);
  
  const { text, usage } = await chat([{ role: 'user', content: userMessage }], env.ANTHROPIC_API_KEY);
  logUsage(usage);
  
  await sendMessage(thread.id, truncate(text), env.DISCORD_TOKEN);
  await deleteOriginalResponse(env.DISCORD_APP_ID, interaction.token);
}

/** Mode 2: Continue existing thread conversation */
async function handleThreadContinuation(channelId: string, interaction: any, env: Env) {
  console.log(`\n--- FETCHING THREAD HISTORY ---`);
  
  // Get full history (recursively resolves branches)
  const history = await getFullThreadHistory(channelId, env.DISCORD_TOKEN);
  
  logThreadMessages(history, 'FULL HISTORY');
  
  // Convert to Claude format
  const { conversation, userMap } = toConversation(history);
  
  if (conversation.length === 0) {
    console.log(`\n❌ No conversation after processing`);
    await editOriginalResponse(env.DISCORD_APP_ID, interaction.token, 'No conversation history found.');
    return;
  }
  
  logConversation(conversation);
  
  // Get Claude's response
  const { text, usage } = await chat(conversation, env.ANTHROPIC_API_KEY, SYSTEM_PROMPT);
  logUsage(usage);
  
  console.log(`\n--- CLAUDE RESPONSE ---`);
  console.log(`"${text.slice(0, 200)}${text.length > 200 ? '...' : ''}"`);
  
  const response = convertMentions(text, userMap);
  await sendMessage(channelId, truncate(response), env.DISCORD_TOKEN);
  await deleteOriginalResponse(env.DISCORD_APP_ID, interaction.token);
  
  console.log(`\n✅ Response posted`);
}

/** Mode 3: Respond to recent channel message, start thread */
async function handleChannelSummary(channelId: string, interaction: any, env: Env) {
  const messages = await getMessages(channelId, env.DISCORD_TOKEN, 15);
  const lastUserMessage = messages.reverse().filter(m => !m.author.bot).pop();
  
  if (!lastUserMessage?.content) {
    await editOriginalResponse(env.DISCORD_APP_ID, interaction.token, 'No recent user messages found.');
    return;
  }
  
  const userRequest = lastUserMessage.content;
  const userId = lastUserMessage.author.id;
  
  // Post user's request as thread starter (preserves context for continuation)
  const starterMsg = await sendMessage(channelId, `<@${userId}>: ${userRequest}`, env.DISCORD_TOKEN);
  const thread = await createThread(channelId, starterMsg.id, truncate(userRequest).slice(0, 50), env.DISCORD_TOKEN);
  
  const { text, usage } = await chat([{ role: 'user', content: userRequest }], env.ANTHROPIC_API_KEY);
  logUsage(usage);
  
  await sendMessage(thread.id, truncate(text), env.DISCORD_TOKEN);
  await deleteOriginalResponse(env.DISCORD_APP_ID, interaction.token);
}
