# GroupThink

A Discord bot for collaborative AI conversations using Claude. Conversations are stored in Discord channels/threads, with tools for managing context, branching discussions, and extracting insights.

**GitHub Repo**: https://github.com/jcarrus/groupthink  
**Worker URL**: https://groupthink.carrus-justin.workers.dev  
**Model**: Claude Sonnet 4.5 (claude-sonnet-4-5)

## Commands

| Command                                | Where             | What it does                                                                                       |
| -------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| `/generate`                            | Channel or Thread | Generate a Claude response using the conversation context                                          |
| `/summarize`                           | Channel only      | Create a summary checkpoint. Future `/generate` calls only include messages after this point       |
| **Branch** (context menu)              | Channel or Thread | Right‑click a message → Apps → **Branch**. Copy the full conversation to a new channel/thread      |
| **Branch with summary** (context menu) | Channel or Thread | Right‑click a message → Apps → **Branch with summary**. New channel/thread with summarized context |
| `/post-to-channel`                     | Thread only       | Extract key insights from the thread and post them to the parent channel                           |

## User Flows

### Basic conversation

1. Create a channel for your topic
2. Add background info, have a discussion
3. Use `/generate` to get Claude's input

### Long-running conversation

1. Have a conversation in a channel
2. When context gets long, use `/summarize` to checkpoint
3. Continue the conversation - Claude only sees the summary + new messages

### Exploring alternatives

1. Have a conversation, reach a decision point
2. Right‑click a message → Apps → **Branch** to create a parallel conversation
3. Explore different directions in each branch

### Deep dive in a thread

1. Start a thread from a channel message
2. Discuss in the thread (inherits channel context)
3. Use `/post-to-channel` to share key insights back

### Branch with fresh start

1. Have a long conversation
2. Right‑click a message → Apps → **Branch with summary** to start a new channel/thread with just the essential context
3. Continue with a cleaner slate

## Context Rules

- **Channels**: Include all messages since the last `/summarize` marker
- **Threads**: Include parent channel context + all thread messages
- **Reactions**: Shown to Claude as `[Reactions: 👍 x3, ❤️ x2]`
- **Summaries**: The summary message itself is included as context
- **Token info**: Messages starting with `-# (` containing usage stats are filtered out

## File Attachments

Claude can create file attachments using XML tags:

```xml
<groupthink:file-attachment name="data.csv">
content here
</groupthink:file-attachment>
```

For long responses, Claude can split into multiple messages by putting three dashes on their own line: `---`

## Usage Reporting

After each response, the bot posts usage stats:

```
-# (198,500 tokens remaining (0.8% used) · in: 1,200, out: 300 · cache: 800 read, 400 write · $0.0082)
```

**Pricing** (Claude Sonnet 4.5):

- Input: $3.00 / million tokens
- Output: $15.00 / million tokens
- Cache read: $0.30 / million tokens
- Cache write: $3.75 / million tokens

## Architecture

- **Cloudflare Worker**: Handles Discord webhook verification and interaction routing
- **Cloudflare Workflows**: Durable execution for LLM calls (no timeout limits)
- **Discord API**: Message fetching, sending, channel/thread creation

### Key Files

| File                           | Purpose                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `src/index.ts`                 | Worker entry point, Discord signature verification, command routing |
| `src/workflow.ts`              | `GroupThinkWorkflow` class - durable LLM processing                 |
| `src/commands.ts`              | Command handlers that trigger workflows                             |
| `src/discord.ts`               | Discord API helpers (messages, channels, threads)                   |
| `src/claude.ts`                | Claude API client with prompt caching                               |
| `scripts/register-commands.ts` | Discord slash command registration                                  |
| `wrangler.toml`                | Cloudflare Worker configuration                                     |

## Setup

### Prerequisites

- Node.js / Bun
- Cloudflare account
- Discord bot application
- Anthropic API key

### 1. Clone and install

```bash
git clone https://github.com/jcarrus/groupthink.git
cd groupthink
bun install
```

### 2. Create `.dev.vars` for local development

```
DISCORD_APP_ID=your_app_id
DISCORD_TOKEN=your_bot_token
DISCORD_PUBLIC_KEY=your_public_key
ANTHROPIC_API_KEY=your_anthropic_key
DISCORD_GUILD_ID=your_dev_guild_id  # Optional, for dev commands
```

### 3. Set production secrets

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_APP_ID
npx wrangler secret put ANTHROPIC_API_KEY
```

### 4. Deploy

```bash
npx wrangler deploy
```

### 5. Register commands

**Dev commands** (with `-dev` suffix, instant update):

```bash
bun run register
```

**Prod commands** (no suffix, to specific guild):

```bash
bun run scripts/register-commands.ts --guild=GUILD_ID --prod
```

**Clear global commands** (if duplicates appear):

```bash
bun run scripts/register-commands.ts --clear-global
```

### 6. Configure Discord

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application
3. Set **Interactions Endpoint URL** to: `https://groupthink.carrus-justin.workers.dev`
4. Invite bot to servers using OAuth2 URL with `bot` and `applications.commands` scopes

**Bot invite URL**:

```
https://discord.com/api/oauth2/authorize?client_id=1467624683133472924&permissions=2147485696&scope=bot%20applications.commands
```

## Development

### Local testing

```bash
npx wrangler dev
```

### Tail logs

```bash
npx wrangler tail
```

### Project structure

```
groupthink/
├── src/
│   ├── index.ts        # Worker entry, routing
│   ├── workflow.ts     # Durable LLM workflow
│   ├── commands.ts     # Command handlers
│   ├── discord.ts      # Discord API helpers
│   └── claude.ts       # Claude API client
├── scripts/
│   └── register-commands.ts
├── wrangler.toml       # Worker config
├── .dev.vars           # Local secrets (gitignored)
└── package.json
```

## Registered Guilds

Commands are currently registered to:

- `1330361967298347139` (dev guild, has both `-dev` and prod commands)
- `1020400136851046491` (prod commands)

## Notes

- The project was renamed from `treechat` to `groupthink`
- Local folder is still `/home/justin/Repos/treechat` but GitHub repo is `groupthink`
- Bot display name is set in Discord Developer Portal, not in code
- When renaming the worker, secrets need to be re-added (they don't migrate)
