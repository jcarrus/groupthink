/**
 * One-time script to register Discord slash commands.
 * Run with: bun run register
 * Reads credentials from .dev.vars automatically.
 */
import { readFileSync } from "fs";

/** Parse .dev.vars file (KEY=value format) into env vars */
function loadDevVars() {
  try {
    const content = readFileSync(".dev.vars", "utf-8");
    for (const line of content.split("\n")) {
      const [key, ...rest] = line.split("=");
      if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
    }
  } catch {
    // .dev.vars doesn't exist, rely on env vars
  }
}

const DISCORD_API = "https://discord.com/api/v10";

/** Build commands with optional dev suffix. Slash commands (type 1) and message context menus (type 3). */
function getCommands(isDev: boolean) {
  const suffix = isDev ? "-dev" : "";
  return [
    // Slash commands (type 1 = CHAT_INPUT, default)
    {
      name: `generate${suffix}`,
      description:
        "Generate a response from Claude using channel/thread context.",
      options: [
        {
          name: "instruction",
          type: 3,
          description:
            'Optional instruction for this response (e.g. "keep it brief")',
          required: false,
        },
      ],
    },
    {
      name: `summarize${suffix}`,
      description:
        "Create a summary checkpoint. Future /generate calls only use messages after this.",
    },
    {
      name: `post-to-channel${suffix}`,
      description:
        "Post critical insights from this thread to the parent channel.",
    },
    {
      name: `set-model${suffix}`,
      description:
        "Set the model for /generate in this channel or thread (default: sonnet).",
      options: [
        {
          name: "model",
          type: 3,
          description: "Model to use",
          required: true,
          choices: [
            { name: "Haiku", value: "haiku" },
            { name: "Sonnet", value: "sonnet" },
            { name: "Opus", value: "opus" },
          ],
        },
      ],
    },
    {
      name: `mcp${suffix}`,
      description:
        "Add an MCP server for /generate in this channel/thread (URL + optional auth).",
      options: [
        {
          name: "url",
          type: 3,
          description: "MCP server URL (e.g. https://mcp.example.com)",
          required: true,
        },
        {
          name: "auth",
          type: 3,
          description: "Authorization header value (e.g. Bearer sk-...)",
          required: false,
        },
      ],
    },
    // Message context menus (type 3 = MESSAGE) – right‑click a message → Apps
    { name: `Branch${suffix}`, type: 3 },
    { name: `Branch with summary${suffix}`, type: 3 },
  ];
}

/** Default guild IDs to register when using --all-guilds (override with DISCORD_GUILD_IDS) */
const DEFAULT_GUILD_IDS = [
  "1330361967298347139",
  "1020400136851046491",
  "1469121589068038227",
];

async function registerToGuild(
  appId: string,
  token: string,
  guildId: string,
  isProd: boolean,
): Promise<void> {
  const endpoint = `${DISCORD_API}/applications/${appId}/guilds/${guildId}/commands`;
  const isDev = !isProd;
  const commands = getCommands(isDev);
  const modeLabel = isProd ? "prod" : "dev";
  console.log(`Registering ${modeLabel} commands to guild ${guildId}...`);
  const res = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    throw new Error(`Failed: ${await res.text()}`);
  }
  console.log(`  OK (${(await res.json()).length} commands)`);
}

async function registerCommands() {
  loadDevVars();
  const appId = process.env.DISCORD_APP_ID;
  const token = process.env.DISCORD_TOKEN;
  const guildIdFromEnv = process.env.DISCORD_GUILD_ID;
  const clearGlobal = process.argv.includes("--clear-global");
  const isProd = process.argv.includes("--prod");
  const allGuilds = process.argv.includes("--all-guilds");

  // --all-guilds: register prod commands to each guild in DISCORD_GUILD_IDS (or default list)
  if (allGuilds) {
    if (!appId || !token) {
      console.error("Missing DISCORD_APP_ID or DISCORD_TOKEN");
      process.exit(1);
    }
    const ids = (process.env.DISCORD_GUILD_IDS ?? DEFAULT_GUILD_IDS.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      console.error("No guild IDs (set DISCORD_GUILD_IDS or use default)");
      process.exit(1);
    }
    for (const guildId of ids) {
      await registerToGuild(appId, token, guildId, true);
    }
    return;
  }

  const guildArg = process.argv.find((arg) => arg.startsWith("--guild="));
  const guildId = guildArg ? guildArg.split("=")[1] : guildIdFromEnv;

  if (!appId || !token) {
    console.error(
      "Missing DISCORD_APP_ID or DISCORD_TOKEN in .dev.vars or env",
    );
    process.exit(1);
  }

  if (clearGlobal) {
    console.log("Clearing global commands...");
    const res = await fetch(`${DISCORD_API}/applications/${appId}/commands`, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([]),
    });
    if (!res.ok) {
      console.error("Failed to clear global commands:", await res.text());
    } else {
      console.log("Global commands cleared.");
    }
  }

  const endpoint = guildId
    ? `${DISCORD_API}/applications/${appId}/guilds/${guildId}/commands`
    : `${DISCORD_API}/applications/${appId}/commands`;

  const isDev = !!guildId && !isProd;
  const commands = getCommands(isDev);
  const modeLabel = isProd ? "prod" : guildId ? "dev" : "global";
  console.log(
    `Registering commands ${guildId ? `to guild ${guildId} (${modeLabel})` : "globally"}...`,
  );

  const res = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    console.error("Failed to register commands:", await res.text());
    process.exit(1);
  }

  const data = await res.json();
  console.log("Registered commands:", data);
}

registerCommands();
