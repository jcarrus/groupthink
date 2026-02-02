/**
 * Branch command - creates a new thread from a specific message in conversation.
 * User right-clicks a message -> "Branch from here" -> new thread with history up to that point.
 */
import { InteractionResponseType } from 'discord-interactions';
import type { Env } from './index';
import { createThread, sendMessage, editOriginalResponse, deleteOriginalResponse, getChannel } from './discord';

/**
 * Handle "Branch from here" message command.
 * Creates a new thread with conversation history up to the selected message.
 */
export function handleBranchCommand(interaction: any, env: Env, ctx: ExecutionContext): Response {
  const targetMessageId = interaction.data?.target_id;
  const channelId = interaction.channel_id;
  
  if (!targetMessageId || !channelId) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'Could not find the target message.', flags: 64 },
    });
  }

  ctx.waitUntil((async () => {
    try {
      // Get channel info to find parent (if we're in a thread, branch from parent)
      const channel = await getChannel(channelId, env.DISCORD_TOKEN);
      const parentChannelId = channel.parent_id ?? channelId;
      const isFromThread = !!channel.parent_id;
      
      // Get user who initiated the branch
      const userId = interaction.member?.user?.id ?? interaction.user?.id;
      
      // Build message link to the branch point
      // Format: https://discord.com/channels/guildId/channelId/messageId
      const guildId = interaction.guild_id;
      const branchPointLink = `https://discord.com/channels/${guildId}/${channelId}/${targetMessageId}`;
      
      // 1. Create starter message in parent channel: "@user's branch of #thread"
      const originalThreadLink = isFromThread ? `<#${channelId}>` : 'this channel';
      const starterContent = `<@${userId}>'s branch of ${originalThreadLink}`;
      const starterMsg = await sendMessage(parentChannelId, starterContent, env.DISCORD_TOKEN);
      
      // 2. Create thread from that message
      const threadName = `Branch of ${channel.name || 'conversation'}`;
      const newThread = await createThread(parentChannelId, starterMsg.id, threadName, env.DISCORD_TOKEN);
      
      // 3. First message in new thread: "Branched from <link to message>"
      await sendMessage(newThread.id, `Branched from ${branchPointLink}`, env.DISCORD_TOKEN);
      
      // 4. Post in OLD thread: "@user branched from <link> in <new thread>"
      const notifyContent = `<@${userId}> branched from [this message](${branchPointLink}) in <#${newThread.id}>`;
      await sendMessage(channelId, notifyContent, env.DISCORD_TOKEN);
      
      // Delete the deferred response
      await deleteOriginalResponse(env.DISCORD_APP_ID, interaction.token);
    } catch (err) {
      await editOriginalResponse(env.DISCORD_APP_ID, interaction.token, `Error: ${err}`);
    }
  })());

  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: 64 }, // Ephemeral
  });
}
