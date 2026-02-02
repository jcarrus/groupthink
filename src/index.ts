/**
 * Discord LLM Bot - Cloudflare Worker
 * Handles Discord interactions via webhook, creates threads for Claude conversations.
 */
import nacl from 'tweetnacl';
import { InteractionType, InteractionResponseType } from 'discord-interactions';
import { handleChatCommand, handleThreadMessage } from './commands';
import { handleBranchCommand } from './branch';

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_TOKEN: string;
  DISCORD_APP_ID: string;
  ANTHROPIC_API_KEY: string;
}

/** Discord interaction payload (simplified, we only type what we use) */
interface Interaction {
  type: InteractionType;
  data?: {
    name?: string;
    options?: Array<{ name: string; value: string }>;
    target_id?: string; // For message commands
    resolved?: { messages?: Record<string, { id: string; content: string; author: { id: string } }> };
  };
  channel_id?: string;
  channel?: { id: string; parent_id?: string; type: number };
  token: string;
  id: string;
  member?: { user: { id: string } };
  user?: { id: string };
}

/** Convert hex string to Uint8Array */
function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Verify Discord request signature using tweetnacl (as per Discord docs) */
function verifyDiscordRequest(
  body: string,
  signature: string,
  timestamp: string,
  publicKey: string
): boolean {
  try {
    const message = new TextEncoder().encode(timestamp + body);
    const sig = hexToUint8Array(signature);
    const key = hexToUint8Array(publicKey);
    return nacl.sign.detached.verify(message, sig, key);
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Verify Discord signature
    const signature = request.headers.get('X-Signature-Ed25519');
    const timestamp = request.headers.get('X-Signature-Timestamp');
    const body = await request.text();
    
    // Debug logging
    console.log('Signature:', signature?.slice(0, 20) + '...');
    console.log('Timestamp:', timestamp);
    console.log('Body:', body.slice(0, 100));
    console.log('Public key:', env.DISCORD_PUBLIC_KEY);
    
    if (!signature || !timestamp || !verifyDiscordRequest(body, signature, timestamp, env.DISCORD_PUBLIC_KEY)) {
      console.log('Verification FAILED - returning 401');
      return new Response('Invalid signature', { status: 401 });
    }
    
    console.log('Verification PASSED');
    const interaction: Interaction = JSON.parse(body);
    console.log('Interaction type:', interaction.type);

    // Discord sends PING to verify endpoint (type 1)
    if (interaction.type === InteractionType.PING || interaction.type === 1) {
      console.log('Responding with PONG');
      return new Response(JSON.stringify({ type: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Slash commands and message commands (support both prod and dev names)
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      const commandName = interaction.data?.name;
      if (commandName === 'chat' || commandName === 'chat-dev') {
        return handleChatCommand(interaction, env, ctx);
      }
      if (commandName === 'Branch from here' || commandName === 'Branch from here-dev') {
        return handleBranchCommand(interaction, env, ctx);
      }
    }

    // Messages in threads (bot mentioned or thread the bot is in)
    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      // We don't use components, but leaving hook for future
    }

    return new Response('Unknown interaction', { status: 400 });
  },
};
