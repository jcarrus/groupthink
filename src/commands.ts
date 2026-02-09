/**
 * Command handlers for /generate, /summarize, /post-to-channel, /branch, /branch-with-summary.
 *
 * These handlers validate the request and trigger a Workflow for async processing.
 * The actual LLM work is done durably by the workflow (no timeout!).
 */
import { InteractionResponseType } from "discord-interactions";
import type { Env } from "./index";
import type { WorkflowParams } from "./workflow";
import {
  getChannel,
  createChannel,
  createThread,
  getAllMessages,
  sendMessage,
} from "./discord";

// ============================================================================
// Utility Functions
// ============================================================================

const isThread = (channelType: number): boolean =>
  channelType === 11 || channelType === 12;

/** Skip token-usage lines (e.g. "-# (total: 1,500 tokens · ...)") when copying to a branch. */
const isTokenUsageMessage = (content: string): boolean =>
  !!content?.trim().startsWith("-# (") &&
  (content.includes("tokens") || content.includes("remaining"));

// ============================================================================
// /generate Command Handler
// ============================================================================

export async function handleGenerateCommand(
  interaction: any,
  env: Env,
): Promise<Response> {
  const channelId = interaction.channel_id;
  const channelType = interaction.channel?.type ?? 0;
  const inThread = isThread(channelType);

  console.log(`\n========== /generate REQUEST ==========`);
  console.log(`Location: ${inThread ? "THREAD" : "CHANNEL"}`);
  console.log(`Channel: ${channelId} (type: ${channelType})`);
  console.log(`========================================\n`);

  const options = (interaction.data?.options ?? []) as Array<{
    name: string;
    value: string;
  }>;
  const instruction =
    options.find((o) => o.name === "instruction")?.value?.trim() || undefined;
  const invokingUsername =
    interaction.member?.user?.username ?? interaction.user?.username;

  const params: WorkflowParams = {
    type: "chat",
    channelId,
    interactionToken: interaction.token,
    appId: env.DISCORD_APP_ID,
    isThread: inThread,
    ...(instruction && { instruction }),
    ...(instruction && invokingUsername && { invokingUsername }),
  };

  await env.GROUPTHINK_WORKFLOW.create({ params });
  console.log("Workflow triggered");

  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}

// ============================================================================
// /set-model Command Handler
// ============================================================================

export async function handleSetModelCommand(
  interaction: any,
  _env: Env,
): Promise<Response> {
  const options = (interaction.data?.options ?? []) as Array<{
    name: string;
    value: string;
  }>;
  const model = options
    .find((o: { name: string }) => o.name === "model")
    ?.value?.toLowerCase();
  if (model !== "haiku" && model !== "sonnet" && model !== "opus") {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Model must be haiku, sonnet, or opus.", flags: 64 },
    });
  }
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `-# model: ${model}` },
  });
}

// ============================================================================
// /mcp Command Handler — posts URL + optional auth into thread for /generate to use
// ============================================================================

export async function handleMcpCommand(
  interaction: any,
  env: Env,
): Promise<Response> {
  const options = (interaction.data?.options ?? []) as Array<{
    name: string;
    value: string;
  }>;
  const url = options.find((o) => o.name === "url")?.value?.trim();
  const auth = options.find((o) => o.name === "auth")?.value?.trim();
  if (!url) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Provide a URL: `/mcp url:https://your-mcp-server.com`",
        flags: 64,
      },
    });
  }
  const lines = [`-# mcp: ${url}`];
  if (auth) lines.push(`-# mcp-auth: ${auth}`);
  if (!auth && env.PUBLIC_URL) {
    const link = `${env.PUBLIC_URL}/oauth/start?channel_id=${interaction.channel_id}&mcp_url=${encodeURIComponent(url)}`;
    lines.push("", `[Connect your account](${link})`);
  }
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: lines.join("\n") },
  });
}

// ============================================================================
// /summarize Command Handler
// ============================================================================

export async function handleSummarizeCommand(
  interaction: any,
  env: Env,
): Promise<Response> {
  const channelId = interaction.channel_id;
  const channelType = interaction.channel?.type ?? 0;

  console.log(`\n========== /summarize REQUEST ==========`);
  console.log(`Channel: ${channelId} (type: ${channelType})`);
  console.log(`=========================================\n`);

  // Only allow in channels, not threads
  if (isThread(channelType)) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content:
          "The /summarize command can only be used in channels, not threads.",
        flags: 64,
      },
    });
  }

  // Trigger workflow for durable async processing
  const params: WorkflowParams = {
    type: "summarize",
    channelId,
    interactionToken: interaction.token,
    appId: env.DISCORD_APP_ID,
  };

  await env.GROUPTHINK_WORKFLOW.create({ params });
  console.log("Workflow triggered");

  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}

// ============================================================================
// /post-to-channel Command Handler (formerly /document)
// ============================================================================

export async function handlePostToChannelCommand(
  interaction: any,
  env: Env,
): Promise<Response> {
  const channelId = interaction.channel_id;
  const channelType = interaction.channel?.type ?? 0;

  console.log(`\n========== /post-to-channel REQUEST ==========`);
  console.log(`Channel: ${channelId} (type: ${channelType})`);
  console.log(`================================================\n`);

  // Only allow in threads
  if (!isThread(channelType)) {
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "The /post-to-channel command can only be used in threads.",
        flags: 64,
      },
    });
  }

  // Trigger workflow for durable async processing
  const params: WorkflowParams = {
    type: "post-to-channel",
    channelId,
    interactionToken: interaction.token,
    appId: env.DISCORD_APP_ID,
  };

  await env.GROUPTHINK_WORKFLOW.create({ params });
  console.log("Workflow triggered");

  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}

// ============================================================================
// Branch (message context menu) Handler
// ============================================================================

export async function handleBranchCommand(
  interaction: any,
  env: Env,
): Promise<Response> {
  const channelId = interaction.channel_id;
  const channelType = interaction.channel?.type ?? 0;
  const inThread = isThread(channelType);
  const targetMessageId = interaction.data?.target_id;

  console.log(`\n========== Branch REQUEST ==========`);
  console.log(`Location: ${inThread ? "THREAD" : "CHANNEL"}`);
  console.log(`Channel: ${channelId}, target message: ${targetMessageId}`);
  console.log(`====================================\n`);

  try {
    const allMessages = await getAllMessages(channelId, env.DISCORD_TOKEN);
    const chronological = allMessages.reverse();
    // Copy only messages up to and including the right-clicked message
    const upToIndex = targetMessageId
      ? chronological.findIndex((m) => m.id === targetMessageId)
      : chronological.length - 1;
    const messagesToCopy =
      upToIndex >= 0 ? chronological.slice(0, upToIndex + 1) : chronological;

    if (inThread) {
      const channel = await getChannel(channelId, env.DISCORD_TOKEN);
      const parentChannelId = channel.parent_id;

      if (!parentChannelId) {
        return Response.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "Could not find parent channel for this thread.",
            flags: 64,
          },
        });
      }

      const starterMsg = await sendMessage(
        parentChannelId,
        `**Branch created from thread**`,
        env.DISCORD_TOKEN,
      );
      const newThread = await createThread(
        parentChannelId,
        starterMsg.id,
        `Branch of ${channel.name || "thread"}`,
        env.DISCORD_TOKEN,
      );

      for (const msg of messagesToCopy) {
        if (msg.content && !isTokenUsageMessage(msg.content)) {
          await sendMessage(
            newThread.id,
            `**${msg.author?.username || "Unknown"}**: ${msg.content}`,
            env.DISCORD_TOKEN,
          );
        }
      }

      return Response.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `Created new branch: <#${newThread.id}>` },
      });
    } else {
      const channel = await getChannel(channelId, env.DISCORD_TOKEN);
      const guildId = interaction.guild_id;

      const newChannel = await createChannel(
        guildId,
        `branch-of-${channel.name || "channel"}`,
        channel.parent_id,
        env.DISCORD_TOKEN,
      );

      for (const msg of messagesToCopy) {
        if (msg.content && !isTokenUsageMessage(msg.content)) {
          await sendMessage(
            newChannel.id,
            `**${msg.author?.username || "Unknown"}**: ${msg.content}`,
            env.DISCORD_TOKEN,
          );
        }
      }

      return Response.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `Created new branch: <#${newChannel.id}>` },
      });
    }
  } catch (error) {
    console.error("Branch error:", error);
    return Response.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `Error creating branch: ${error}`, flags: 64 },
    });
  }
}

// ============================================================================
// Branch with summary (message context menu) Handler
// ============================================================================

export async function handleBranchWithSummaryCommand(
  interaction: any,
  env: Env,
): Promise<Response> {
  const channelId = interaction.channel_id;
  const channelType = interaction.channel?.type ?? 0;
  const inThread = isThread(channelType);

  console.log(`\n========== /branch-with-summary REQUEST ==========`);
  console.log(`Location: ${inThread ? "THREAD" : "CHANNEL"}`);
  console.log(`Channel: ${channelId} (type: ${channelType})`);
  console.log(`===================================================\n`);

  // Trigger workflow for durable async processing (needs LLM for summary)
  const params: WorkflowParams = {
    type: "branch-with-summary",
    channelId,
    interactionToken: interaction.token,
    appId: env.DISCORD_APP_ID,
    isThread: inThread,
    guildId: interaction.guild_id,
  };

  await env.GROUPTHINK_WORKFLOW.create({ params });
  console.log("Workflow triggered");

  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });
}
