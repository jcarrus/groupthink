/**
 * Discord API helpers.
 * All Discord REST calls go through here.
 */

const DISCORD_API = "https://discord.com/api/v10";

/** Make authenticated Discord API request */
export async function discordFetch(
  endpoint: string,
  token: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(`${DISCORD_API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

/** Create a thread from a message */
export async function createThread(
  channelId: string,
  messageId: string,
  name: string,
  token: string
): Promise<{ id: string }> {
  const res = await discordFetch(
    `/channels/${channelId}/messages/${messageId}/threads`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ name, auto_archive_duration: 1440 }), // 24h archive
    }
  );
  return res.json();
}

/** Create a thread without a starter message (for branching) */
export async function createThreadWithoutMessage(
  channelId: string,
  name: string,
  token: string
): Promise<{ id: string }> {
  // Type 11 = public thread
  const res = await discordFetch(`/channels/${channelId}/threads`, token, {
    method: "POST",
    body: JSON.stringify({ name, auto_archive_duration: 1440, type: 11 }),
  });
  return res.json();
}

/** Send a message to a channel/thread */
export async function sendMessage(
  channelId: string,
  content: string,
  token: string,
): Promise<{ id: string }> {
  const res = await discordFetch(`/channels/${channelId}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(
      `sendMessage failed: ${res.status} — ${body} (content: ${content.slice(0, 80)})`,
    );
    throw new Error(`Discord sendMessage ${res.status}: ${body}`);
  }
  return res.json();
}

/** Send a message with file attachments */
export async function sendMessageWithFiles(
  channelId: string,
  content: string,
  files: Array<{ name: string; content: string }>,
  token: string
): Promise<{ id: string }> {
  console.log(
    `sendMessageWithFiles: ${files.length} files, content length ${content.length}`
  );

  const formData = new FormData();

  // Add the JSON payload
  formData.append("payload_json", JSON.stringify({ content }));

  // Add files
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    console.log(`  File ${i}: ${file.name} (${file.content.length} chars)`);
    const blob = new Blob([file.content], { type: "text/plain" });
    formData.append(`files[${i}]`, blob, file.name);
  }

  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
      },
      body: formData,
    }
  );

  const result = await res.json();
  console.log(
    `sendMessageWithFiles response:`,
    JSON.stringify(result).slice(0, 200)
  );
  return result as { id: string };
}

/** Discord embed object */
export interface Embed {
  author?: { name: string; icon_url?: string };
  description?: string;
  color?: number;
}

/** Send a message with an embed */
export async function sendEmbed(
  channelId: string,
  embed: Embed,
  token: string
): Promise<{ id: string }> {
  const res = await discordFetch(`/channels/${channelId}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ embeds: [embed] }),
  });
  return res.json();
}

/** Get user's avatar URL */
export function getAvatarUrl(
  userId: string,
  avatarHash?: string
): string | undefined {
  if (!avatarHash) return undefined;
  const ext = avatarHash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}`;
}

/** Discord reaction info */
export interface DiscordReaction {
  emoji: { name: string; id?: string };
  count: number;
}

/** Discord message attachment (from API) */
export interface DiscordAttachment {
  id: string;
  filename: string;
  url: string;
  size: number;
  content_type?: string;
}

/** Discord message with author info */
export interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string; avatar?: string; bot?: boolean };
  reactions?: DiscordReaction[];
  attachments?: DiscordAttachment[];
}

/** Get messages from a channel/thread (up to 100, ordered newest first) */
export async function getMessages(
  channelId: string,
  token: string,
  limit = 100
): Promise<DiscordMessage[]> {
  const res = await discordFetch(
    `/channels/${channelId}/messages?limit=${limit}`,
    token
  );
  return res.json();
}

/** Get ALL messages from a channel/thread by paginating (ordered newest first) */
export async function getAllMessages(
  channelId: string,
  token: string,
  maxMessages = 500
): Promise<DiscordMessage[]> {
  const allMessages: DiscordMessage[] = [];
  let beforeId: string | undefined;

  while (allMessages.length < maxMessages) {
    const endpoint = beforeId
      ? `/channels/${channelId}/messages?limit=100&before=${beforeId}`
      : `/channels/${channelId}/messages?limit=100`;
    console.log(`Fetching messages: ${endpoint}`);
    const res = await discordFetch(endpoint, token);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Discord API ${res.status}: ${JSON.stringify(data)}`);
    }
    const batch = Array.isArray(data) ? data : [];
    console.log(`Got batch of ${batch.length} messages:`);
    [...batch.slice(0, 2), ...batch.slice(-2)].forEach((msg) => {
      console.log(
        `  [${msg.author.username}${msg.author.bot ? " (bot)" : ""}]: ${msg.content?.slice(0, 100)}`
      );
    });

    if (batch.length === 0) break;

    allMessages.push(...batch);
    beforeId = batch[batch.length - 1].id;

    if (batch.length < 100) break; // No more messages
  }

  console.log(`Total messages fetched: ${allMessages.length}`);
  return allMessages;
}

/** Get messages before a specific message ID (for branching) */
export async function getMessagesBefore(
  channelId: string,
  beforeId: string,
  token: string,
  limit = 100
): Promise<DiscordMessage[]> {
  const res = await discordFetch(
    `/channels/${channelId}/messages?limit=${limit}&before=${beforeId}`,
    token
  );
  return res.json();
}

/** Get the original interaction response message, or null if deleted/404. */
export async function getOriginalResponse(
  appId: string,
  interactionToken: string,
  token: string
): Promise<unknown | null> {
  const res = await discordFetch(
    `/webhooks/${appId}/${interactionToken}/messages/@original`,
    token,
    { method: "GET" }
  );
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

/** Edit the original interaction response (after deferring) */
export async function editOriginalResponse(
  appId: string,
  interactionToken: string,
  content: string,
  token: string
): Promise<void> {
  await discordFetch(
    `/webhooks/${appId}/${interactionToken}/messages/@original`,
    token,
    {
      method: "PATCH",
      body: JSON.stringify({ content }),
    }
  );
}

/** Delete the original interaction response */
export async function deleteOriginalResponse(
  appId: string,
  interactionToken: string
): Promise<void> {
  await fetch(
    `${DISCORD_API}/webhooks/${appId}/${interactionToken}/messages/@original`,
    {
      method: "DELETE",
    }
  );
}

/** Send a followup message to an interaction */
export async function sendFollowup(
  appId: string,
  interactionToken: string,
  content: string
): Promise<{ id: string }> {
  const res = await fetch(
    `${DISCORD_API}/webhooks/${appId}/${interactionToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }
  );
  return res.json();
}

/** Get channel info */
export async function getChannel(
  channelId: string,
  token: string
): Promise<{ id: string; parent_id?: string; type: number; name?: string }> {
  const res = await discordFetch(`/channels/${channelId}`, token);
  return res.json();
}

/** Create a new text channel in a guild */
export async function createChannel(
  guildId: string,
  name: string,
  parentId: string | undefined,
  token: string
): Promise<{ id: string; name: string }> {
  const body: any = { name, type: 0 }; // type 0 = text channel
  if (parentId) body.parent_id = parentId;

  const res = await discordFetch(`/guilds/${guildId}/channels`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Get a specific message by ID */
export async function getMessage(
  channelId: string,
  messageId: string,
  token: string
): Promise<DiscordMessage> {
  const res = await discordFetch(
    `/channels/${channelId}/messages/${messageId}`,
    token
  );
  return res.json();
}

const PLAIN_TEXT_EXT =
  /\.(txt|md|json|csv|log|xml|yaml|yml|html|htm|rst|tex|adoc)$/i;
const MAX_ATTACHMENT_CHARS = 80_000; // ~20K tokens
const MAX_ATTACHMENT_BYTES = 100_000;

/** Fetch attachment URL and return body as text if plain-text and within size limit. Returns '' on skip/failure. */
export async function fetchPlainTextAttachment(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "GroupThink/1.0" },
    });
    if (!res.ok) return "";
    const cl = res.headers.get("Content-Length");
    if (cl && parseInt(cl, 10) > MAX_ATTACHMENT_BYTES) return "";
    const ct = res.headers.get("Content-Type") ?? "";
    if (
      ct &&
      !ct.startsWith("text/") &&
      !ct.includes("json") &&
      !ct.includes("xml")
    )
      return "";
    const text = await res.text();
    return text.slice(0, MAX_ATTACHMENT_CHARS);
  } catch {
    return "";
  }
}

/** True if attachment is likely plain text (by extension or content_type). */
export function isPlainTextAttachment(att: DiscordAttachment): boolean {
  if (
    att.content_type?.startsWith("text/") ||
    att.content_type === "application/json" ||
    att.content_type === "application/xml"
  )
    return true;
  return PLAIN_TEXT_EXT.test(att.filename);
}
