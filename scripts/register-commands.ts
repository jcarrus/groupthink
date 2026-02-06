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
      name: `generate${suffix}`,
      description: 'Generate a response from Claude using channel/thread context.',
    },
    {
      name: `summarize${suffix}`,
      description: 'Create a summary checkpoint. Future /generate calls only use messages after this.',
    },
    {
      name: `post-to-channel${suffix}`,
      description: 'Post critical insights from this thread to the parent channel.',
    },
    {
      name: `branch${suffix}`,
      description: 'Copy the full conversation to a new channel/thread.',
    },
    {
      name: `branch-with-summary${suffix}`,
      description: 'Create a new channel/thread with a summarized context.',
    },
  ];
}

async function registerCommands() {
  loadDevVars();
  const appId = process.env.DISCORD_APP_ID;
  const token = process.env.DISCORD_TOKEN;
  const guildIdFromEnv = process.env.DISCORD_GUILD_ID;
  const clearGlobal = process.argv.includes('--clear-global');
  const isProd = process.argv.includes('--prod');
  
  // Allow passing guild ID as argument: --guild=123456789
  const guildArg = process.argv.find(arg => arg.startsWith('--guild='));
  const guildId = guildArg ? guildArg.split('=')[1] : guildIdFromEnv;

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

  // Use -dev suffix only if guild is set AND --prod flag is NOT used
  const isDev = !!guildId && !isProd;
  const commands = getCommands(isDev);
  
  const modeLabel = isProd ? 'prod' : (guildId ? 'dev' : 'global');
  console.log(`Registering commands ${guildId ? `to guild ${guildId} (${modeLabel})` : 'globally'}...`);

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
