# GroupThink

A Discord bot for collaborative AI conversations using Claude. Conversations are stored in Discord channels/threads, with tools for managing context, branching discussions, and extracting insights.

## Commands

| Command | Where | What it does |
|---------|-------|--------------|
| `/generate` | Channel or Thread | Generate a Claude response using the conversation context |
| `/summarize` | Channel only | Create a summary checkpoint. Future `/generate` calls only include messages after this point |
| `/branch` | Channel or Thread | Create a copy of the current conversation. In a channel → new channel. In a thread → new thread |
| `/branch-with-summary` | Channel or Thread | Branch but start with a summary instead of full history |
| `/post-to-channel` | Thread only | Extract key insights from the thread and post them to the parent channel |

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
2. Use `/branch` to create a parallel conversation
3. Explore different directions in each branch

### Deep dive in a thread
1. Start a thread from a channel message
2. Discuss in the thread (inherits channel context)
3. Use `/post-to-channel` to share key insights back

### Branch with fresh start
1. Have a long conversation
2. Use `/branch-with-summary` to start a new channel/thread with just the essential context
3. Continue with a cleaner slate

## Context Rules

- **Channels**: Include all messages since the last `/summarize` marker
- **Threads**: Include parent channel context + all thread messages
- **Reactions**: Shown to Claude as `[Reactions: 👍 x3, ❤️ x2]`
- **Summaries**: The summary message itself is included as context

## File Attachments

Claude can create file attachments using XML tags:

```xml
<groupthink:file-attachment name="data.csv">
content here
</groupthink:file-attachment>
```

For long responses, Claude can split into multiple messages:

```xml
<groupthink:message-break/>
```

## Setup

1. Create a Discord bot and get credentials
2. Set secrets via `wrangler secret put`:
   - `DISCORD_PUBLIC_KEY`
   - `DISCORD_TOKEN`
   - `DISCORD_APP_ID`
   - `ANTHROPIC_API_KEY`
3. Deploy: `npx wrangler deploy`
4. Register commands: `bun run register`
5. Set your bot's Interactions Endpoint URL to the worker URL
