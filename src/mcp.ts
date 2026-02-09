/**
 * MCP client + config resolution.
 * - Minimal Streamable HTTP client (initialize, list tools, call tool)
 * - Config extraction from Discord messages (mcp/mcp-auth/mcp-oauth patterns)
 * - OAuth token resolution and refresh
 */

import { sendMessage, type DiscordMessage } from "./discord";
import {
  decryptOAuthPayload,
  encryptOAuthPayload,
  refreshOAuthTokens,
  type OAuthPayload,
} from "./oauth";

// ============================================================================
// MCP Client
// ============================================================================

const MCP_VERSION = "2025-06-18";

function mcpHeaders(auth?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_VERSION,
  };
  if (auth) h["Authorization"] = auth;
  return h;
}

/** POST a JSON-RPC message; parse JSON response or read first SSE event. */
async function mcpPost(
  url: string,
  auth: string | undefined,
  body: object,
  sessionId?: string
): Promise<object> {
  const headers = mcpHeaders(auth);
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 202) return {};
  const ct = res.headers.get("Content-Type") ?? "";
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data && data !== "[DONE]") {
          try {
            return JSON.parse(data) as object;
          } catch {
            // skip
          }
        }
      }
    }
    return {};
  }
  return res.json() as Promise<object>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  serverIndex: number;
}

/** Initialize MCP server; return session ID if present. */
export async function mcpInitialize(
  url: string,
  auth?: string
): Promise<{ sessionId?: string }> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: "groupthink", version: "1.0.0" },
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: mcpHeaders(auth),
    body: JSON.stringify(body),
  });
  const sessionId = res.headers.get("Mcp-Session-Id") ?? undefined;
  const contentType = res.headers.get("Content-Type") ?? "";
  console.log(
    `MCP init: url=${url} status=${res.status} contentType=${contentType.slice(0, 50)} sessionId=${sessionId ? "yes" : "no"}`
  );
  if (res.status === 401) {
    throw new Error(
      "MCP server requires OAuth (401). Connect your account via the link posted in the thread."
    );
  }

  const sendNotification = () =>
    fetch(url, {
      method: "POST",
      headers: {
        ...mcpHeaders(auth),
        ...(sessionId && { "Mcp-Session-Id": sessionId }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    }).catch(() => {});

  if (res.status === 202) {
    await sendNotification();
    return { sessionId };
  }

  const ct = res.headers.get("Content-Type") ?? "";
  let data: { result?: object; error?: { message?: string } } = {};
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const raw = line.slice(6).trim();
        if (raw && raw !== "[DONE]") {
          try {
            data = JSON.parse(raw);
            break;
          } catch {
            /* skip */
          }
        }
      }
    }
  } else {
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      console.error(
        `MCP init: JSON parse failed url=${url} status=${res.status} bodyPreview=${text.slice(0, 300)}`
      );
      throw new Error(`MCP init: ${res.status} ${res.statusText}`);
    }
  }
  if (data.error) {
    const msg =
      data.error.message ??
      (typeof data.error === "string" ? data.error : "Unknown error");
    console.error(`MCP init: server error url=${url} error=${msg}`);
    throw new Error(`MCP init: ${msg}`);
  }
  console.log(`MCP init: success url=${url}`);
  await sendNotification();
  return { sessionId };
}

/** List tools from one MCP server. */
export async function mcpListTools(
  url: string,
  auth: string | undefined,
  serverIndex: number,
  sessionId?: string
): Promise<McpTool[]> {
  const body = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const res = (await mcpPost(url, auth, body, sessionId)) as {
    result?: {
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>;
    };
    error?: { message: string };
  };
  if (res.error) {
    console.error(`MCP tools/list: url=${url} error=${res.error.message}`);
    throw new Error(`MCP tools/list: ${res.error.message}`);
  }
  const tools = res.result?.tools ?? [];
  console.log(
    `MCP tools/list: url=${url} count=${tools.length} names=${tools.map((t) => t.name).join(", ") || "(none)"}`
  );
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    serverIndex,
  }));
}

/** Call one tool. Returns text content from result. */
export async function mcpCallTool(
  url: string,
  auth: string | undefined,
  name: string,
  args: Record<string, unknown>,
  sessionId?: string
): Promise<string> {
  const body = {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name, arguments: args },
  };
  const res = (await mcpPost(url, auth, body, sessionId)) as {
    result?: {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    error?: { message: string };
  };
  if (res.error) return `Error: ${res.error.message}`;
  if (res.result?.isError) {
    const text =
      res.result.content?.find((c) => c.type === "text")?.text ?? "Tool error";
    return `Error: ${text}`;
  }
  return (
    (res.result?.content ?? [])
      .filter(
        (c): c is { type: "text"; text: string } =>
          c.type === "text" && typeof (c as { text?: string }).text === "string"
      )
      .map((c) => c.text)
      .join("\n") || ""
  );
}

/** Fetch tools from all servers; merge into one list. Returns oauthRequired for servers that returned 401. */
export async function fetchAllMcpTools(
  servers: Array<{ url: string; auth?: string }>
): Promise<{
  tools: McpTool[];
  sessions: (string | undefined)[];
  oauthRequired?: string[];
}> {
  const allTools: McpTool[] = [];
  const sessions: (string | undefined)[] = [];
  const oauthRequired: string[] = [];
  console.log(
    `MCP fetchAllMcpTools: ${servers.length} server(s) ${servers.map((s) => s.url + (s.auth ? " (auth)" : " (no auth)")).join(", ")}`
  );
  for (let i = 0; i < servers.length; i++) {
    const { url, auth } = servers[i];
    try {
      const { sessionId } = await mcpInitialize(url, auth);
      sessions.push(sessionId);
      const list = await mcpListTools(url, auth, i, sessionId);
      allTools.push(...list);
      console.log(`MCP server ${i} ${url}: ${list.length} tools`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`MCP server ${i} FAILED url=${url} error=${errMsg}`);
      if (e instanceof Error && e.message.includes("OAuth (401)"))
        oauthRequired.push(url);
      sessions.push(undefined);
    }
  }
  console.log(
    `MCP fetchAllMcpTools: done total=${allTools.length} tools from ${servers.length} servers`
  );
  return {
    tools: allTools,
    sessions,
    oauthRequired: oauthRequired.length ? oauthRequired : undefined,
  };
}

// ============================================================================
// MCP Config Extraction from Discord Messages
// ============================================================================

export interface McpServer {
  url: string;
  auth?: string;
}

const MCP_LINE_PATTERN = /^-# mcp:\s*(.+)$/m;
const MCP_AUTH_LINE_PATTERN = /^-# mcp-auth:\s*(.+)$/m;
const MCP_OAUTH_BLOB_PATTERN = /-# mcp-oauth:\s*([A-Za-z0-9_-]+)/g;

/** Extract MCP server config from messages (URL + optional auth). */
export function getMcpConfigFromMessages(
  messages: DiscordMessage[]
): McpServer[] {
  const servers: McpServer[] = [];
  for (const msg of messages) {
    const content = msg.content ?? "";
    const mcpMatch = content.match(MCP_LINE_PATTERN);
    if (!mcpMatch) continue;
    const url = mcpMatch[1].trim();
    const authMatch = content.match(MCP_AUTH_LINE_PATTERN);
    servers.push({ url, auth: authMatch ? authMatch[1].trim() : undefined });
  }
  return servers;
}

/** Normalize MCP URL for matching (strip query, hash, trailing slashes). */
function normalizeMcpUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.toString();
  } catch {
    return url;
  }
}

/** Get latest OAuth payload per normalized URL from messages (decrypt mcp-oauth blobs). */
async function getOAuthPayloadsFromMessages(
  messages: DiscordMessage[],
  encryptionKey: string
): Promise<Map<string, OAuthPayload>> {
  const map = new Map<string, OAuthPayload>();
  for (const msg of messages) {
    const content = msg.content ?? "";
    let m: RegExpExecArray | null;
    MCP_OAUTH_BLOB_PATTERN.lastIndex = 0;
    while ((m = MCP_OAUTH_BLOB_PATTERN.exec(content)) !== null) {
      const blob = m[1].trim();
      let payload = await decryptOAuthPayload(blob, encryptionKey);
      if (!payload && blob.endsWith("_")) {
        payload = await decryptOAuthPayload(blob.slice(0, -1), encryptionKey);
      }
      if (payload) map.set(normalizeMcpUrl(payload.mcp_url), payload);
    }
  }
  return map;
}

/** Resolve auth for servers: use mcp-auth if present, else decrypt mcp-oauth and refresh if expired. */
export async function resolveMcpServersWithOAuth(
  messages: DiscordMessage[],
  servers: McpServer[],
  env: { OAUTH_ENCRYPTION_KEY?: string; DISCORD_TOKEN: string },
  channelId: string
): Promise<McpServer[]> {
  if (!env.OAUTH_ENCRYPTION_KEY) return servers;
  const payloads = await getOAuthPayloadsFromMessages(
    messages,
    env.OAUTH_ENCRYPTION_KEY
  );
  const result: McpServer[] = [];
  const REFRESH_MARGIN_MS = 5 * 60 * 1000;

  for (const s of servers) {
    if (s.auth) {
      result.push(s);
      continue;
    }
    const payload = payloads.get(normalizeMcpUrl(s.url));
    if (!payload) {
      result.push({ url: s.url });
      continue;
    }
    let accessToken = payload.access_token;
    if (
      payload.expires_at <= Date.now() + REFRESH_MARGIN_MS &&
      payload.refresh_token
    ) {
      try {
        const tokens = await refreshOAuthTokens(
          payload.refresh_token,
          {
            authorization_endpoint: "",
            token_endpoint: payload.token_endpoint,
          },
          payload.client_id,
          payload.client_secret
        );
        accessToken = tokens.access_token;
        const newPayload: OAuthPayload = {
          ...payload,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token ?? payload.refresh_token,
          expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        };
        const blob = await encryptOAuthPayload(
          newPayload,
          env.OAUTH_ENCRYPTION_KEY!
        );
        await sendMessage(
          channelId,
          `-# oauth refreshed · mcp-oauth: ${blob}`,
          env.DISCORD_TOKEN
        );
      } catch (e) {
        console.error("OAuth refresh failed:", e);
      }
    }
    result.push({ url: s.url, auth: `Bearer ${accessToken}` });
  }
  return result;
}
