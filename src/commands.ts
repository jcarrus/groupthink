/**
 * Command handlers for /generate, /summarize, /post-to-channel, /branch, /branch-with-summary.
 * 
 * These handlers validate the request and trigger a Workflow for async processing.
 * The actual LLM work is done durably by the workflow (no timeout!).
 */
import { InteractionResponseType } from 'discord-interactions';
import type { Env } from './index';
import type { WorkflowParams } from './workflow';
import { getChannel, createChannel, createThread, getAllMessages, sendMessage } from './discord';

// ============================================================================
// Utility Functions
// ============================================================================

const isThread = (channelType: number): boolean =>
  channelType === 11 || channelType === 12;

// ============================================================================
// /generate Command Handler
// ============================================================================

export async function handleGenerateCommand(interaction: any, env: Env): Promise<Response> {
  const channelId = interaction.channel_id;
  const channelType = interaction.channel?.type ?? 0;
  const inThread = isThread(channelType);
  
  console.log(`\n========== /generate REQUEST ==========`);
  console.log(`Location: ${inThread ? 'THREAD' : 'CHANNEL'}`);
  console.log(`Channel: ${channelId} (type: ${channelType})`);
  console.log(`========================================\n`);

  // Trigger workflow for durable async processing
  const params: WorkflowParams = {
    type: 'chat',
    channelId,
    interactionToken: interaction.token,
    appId: env.DISCORD_APP_ID,
    isThread: inThread,
  };
  
  await env.GROUPTHINK_WORKFLOW.create({ params });
  console.log('Workflow triggered');

  return Response.json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
}

// ============================================================================
// /summarize Command Handler
// ============================================================================

export async function handleSummarizeCommand(interaction: any, env: Env): Promise<Response> {
  const channelId = interaction.channel_id;
  const channelType = interaction.channel?.type ?? 0;
  
  console.log(`\n========== /summarize REQUEST ==========`);
  console.log(`Channel: ${channelId} (type: ${channelType})`);
  console.log(`=========================================\n`);

  // Only allow in channels, not threads
  if (isThread(channelType)) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'The /summarize command can only be used in channels, not threads.', flags: 64 }
    });
  }

  // Trigger workflow for durable async processing
  const params: WorkflowParams = {
    type: 'summarize',
    channelId,
    interactionToken: interaction.token,
    appId: env.DISCORD_APP_ID,
  };
  
  await env.GROUPTHINK_WORKFLOW.create({ params });
  console.log('Workflow triggered');

  return Response.json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
}

// ============================================================================
// /post-to-channel Command Handler (formerly /document)
// ============================================================================

export async function handlePostToChannelCommand(interaction: any, env: Env): Promise<Response> {
  const channelId = interaction.channel_id;
  const channelType = interaction.channel?.type ?? 0;
  
  console.log(`\n========== /post-to-channel REQUEST ==========`);
  console.log(`Channel: ${channelId} (type: ${channelType})`);
  console.log(`================================================\n`);

  // Only allow in threads
  if (!isThread(channelType)) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'The /post-to-channel command can only be used in threads.', flags: 64 }
    });
  }

  // Trigger workflow for durable async processing
  const params: WorkflowParams = {
    type: 'post-to-channel',
    channelId,
    interactionToken: interaction.token,
    appId: env.DISCORD_APP_ID,
  };
  
  await env.GROUPTHINK_WORKFLOW.create({ params });
  console.log('Workflow triggered');

  return Response.json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
}

// ============================================================================
// /branch Command Handler
// ============================================================================

export async function handleBranchCommand(interaction: any, env: Env): Promise<Response> {
  const channelId = interaction.channel_id;
  const channelType = interaction.channel?.type ?? 0;
  const inThread = isThread(channelType);
  
  console.log(`\n========== /branch REQUEST ==========`);
  console.log(`Location: ${inThread ? 'THREAD' : 'CHANNEL'}`);
  console.log(`Channel: ${channelId} (type: ${channelType})`);
  console.log(`======================================\n`);

  try {
    // Get all messages from current channel/thread
    const messages = await getAllMessages(channelId, env.DISCORD_TOKEN);
    
    if (inThread) {
      // In a thread: create a new thread in the parent channel
      const channel = await getChannel(channelId, env.DISCORD_TOKEN);
      const parentChannelId = channel.parent_id;
      
      if (!parentChannelId) {
        return Response.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: 'Could not find parent channel for this thread.', flags: 64 }
        });
      }
      
      // Create a new thread (need a message to start from)
      const starterMsg = await sendMessage(parentChannelId, `**Branch created from thread**`, env.DISCORD_TOKEN);
      const newThread = await createThread(parentChannelId, starterMsg.id, `Branch of ${channel.name || 'thread'}`, env.DISCORD_TOKEN);
      
      // Copy messages to new thread
      for (const msg of messages.reverse()) {
        if (msg.content) {
          await sendMessage(newThread.id, `**${msg.author?.username || 'Unknown'}**: ${msg.content}`, env.DISCORD_TOKEN);
        }
      }
      
      return Response.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `Created new branch: <#${newThread.id}>` }
      });
    } else {
      // In a channel: create a new channel in the same category
      const channel = await getChannel(channelId, env.DISCORD_TOKEN);
      const guildId = interaction.guild_id;
      
      const newChannel = await createChannel(
        guildId,
        `branch-of-${channel.name || 'channel'}`,
        channel.parent_id, // same category
        env.DISCORD_TOKEN
      );
      
      // Copy messages to new channel
      for (const msg of messages.reverse()) {
        if (msg.content) {
          await sendMessage(newChannel.id, `**${msg.author?.username || 'Unknown'}**: ${msg.content}`, env.DISCORD_TOKEN);
        }
      }
      
      return Response.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `Created new branch: <#${newChannel.id}>` }
      });
    }
  } catch (error) {
    console.error('Branch error:', error);
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `Error creating branch: ${error}`, flags: 64 }
    });
  }
}

// ============================================================================
// /branch-with-summary Command Handler
// ============================================================================

export async function handleBranchWithSummaryCommand(interaction: any, env: Env): Promise<Response> {
  const channelId = interaction.channel_id;
  const channelType = interaction.channel?.type ?? 0;
  const inThread = isThread(channelType);
  
  console.log(`\n========== /branch-with-summary REQUEST ==========`);
  console.log(`Location: ${inThread ? 'THREAD' : 'CHANNEL'}`);
  console.log(`Channel: ${channelId} (type: ${channelType})`);
  console.log(`===================================================\n`);

  // Trigger workflow for durable async processing (needs LLM for summary)
  const params: WorkflowParams = {
    type: 'branch-with-summary',
    channelId,
    interactionToken: interaction.token,
    appId: env.DISCORD_APP_ID,
    isThread: inThread,
    guildId: interaction.guild_id,
  };
  
  await env.GROUPTHINK_WORKFLOW.create({ params });
  console.log('Workflow triggered');

  return Response.json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
}
