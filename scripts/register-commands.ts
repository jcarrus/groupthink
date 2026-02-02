/**
 * One-time script to register Discord slash commands.
 * Run with: bun run register
 * Reads credentials from .dev.vars automatically.
 */
import { readFileSync } from 'fs';

/** Parse .dev.vars file (KEY=value format) into env vars */
function loadDevVars() {
  try {
    const content = readFileSync('.dev.vars', 'utf-8');
    for (const line of content.split('\n')) {
      const [key, ...rest] = line.split('=');
      if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
    }
  } catch {
    // .dev.vars doesn't exist, rely on env vars
  }
}

const DISCORD_API = 'https://discord.com/api/v10';

/** Build commands with optional dev suffix */
function getCommands(isDev: boolean) {
  const suffix = isDev ? '-dev' : '';
  return [
    {
      name: `chat${suffix}`,
      description: 'Chat with Claude. In a thread: continues conversation. In channel: starts new thread.',
      options: [
        {
          name: 'message',
          description: 'Your message (optional in threads, required to start new conversation)',
          type: 3, // STRING
          required: false,
        },
      ],
    },
    {
      name: `Branch from here${suffix}`,
      type: 3, // MESSAGE command (right-click menu)
    },
  ];
}

async function registerCommands() {
  loadDevVars();
  const appId = process.env.DISCORD_APP_ID;
  const token = process.env.DISCORD_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  const clearGlobal = process.argv.includes('--clear-global');

  if (!appId || !token) {
    console.error('Missing DISCORD_APP_ID or DISCORD_TOKEN in .dev.vars or env');
    process.exit(1);
  }

  // Clear global commands if requested (fixes duplicate commands)
  if (clearGlobal) {
    console.log('Clearing global commands...');
    const res = await fetch(`${DISCORD_API}/applications/${appId}/commands`, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([]), // Empty array clears all
    });
    if (!res.ok) {
      console.error('Failed to clear global commands:', await res.text());
    } else {
      console.log('Global commands cleared.');
    }
  }

  // Guild-specific commands update instantly; global commands can take up to 1 hour
  const endpoint = guildId
    ? `${DISCORD_API}/applications/${appId}/guilds/${guildId}/commands`
    : `${DISCORD_API}/applications/${appId}/commands`;

  const isDev = !!guildId;
  const commands = getCommands(isDev);
  
  console.log(`Registering commands ${guildId ? `to guild ${guildId} (dev)` : 'globally'}...`);

  const res = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    console.error('Failed to register commands:', await res.text());
    process.exit(1);
  }

  const data = await res.json();
  console.log('Registered commands:', data);
}

registerCommands();
