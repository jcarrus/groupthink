/**
 * HTTP GET handlers for OAuth start and callback.
 * Tokens are posted as encrypted mcp-oauth blob into the Discord thread.
 */

import { sendMessage } from "./discord";
import {
  discoverOAuthMetadata,
  registerClient,
  generatePKCE,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  encryptOAuthPayload,
  encryptStatePayload,
  decryptStatePayload,
  type OAuthPayload,
  type OAuthMetadata,
} from "./oauth";

export interface OAuthEnv {
  DISCORD_TOKEN: string;
  OAUTH_ENCRYPTION_KEY: string;
}

/** GET /oauth/start?channel_id=...&mcp_url=... */
export async function handleOAuthStart(
  request: Request,
  env: OAuthEnv,
  baseUrl: string,
): Promise<Response> {
  const url = new URL(request.url);
  const channelId = url.searchParams.get("channel_id");
  const mcpUrl = url.searchParams.get("mcp_url");
  if (!channelId || !mcpUrl) {
    return new Response("Missing channel_id or mcp_url", { status: 400 });
  }

  try {
    const metadata = await discoverOAuthMetadata(mcpUrl);
    const redirectUri = `${baseUrl}/oauth/callback`;
    const { client_id, client_secret } = await registerClient(
      metadata,
      redirectUri,
    );
    const { code_verifier, code_challenge } = await generatePKCE();
    const statePayload = {
      code_verifier,
      channel_id: channelId,
      mcp_url: mcpUrl,
      client_id,
      client_secret: client_secret ?? undefined,
      token_endpoint: metadata.token_endpoint,
      exp: Date.now() + 10 * 60 * 1000,
    };
    const state = await encryptStatePayload(
      statePayload,
      env.OAUTH_ENCRYPTION_KEY,
    );
    const authUrl = buildAuthorizationUrl(
      metadata,
      client_id,
      redirectUri,
      code_challenge,
      state,
    );
    return Response.redirect(authUrl, 302);
  } catch (e) {
    console.error("OAuth start failed:", e);
    return new Response(
      `OAuth start failed: ${e instanceof Error ? e.message : String(e)}`,
      { status: 500 },
    );
  }
}

/** GET /oauth/callback?code=...&state=... */
export async function handleOAuthCallback(
  request: Request,
  env: OAuthEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) {
    return htmlResponse(
      `OAuth error: ${error}. You can close this and try again from Discord.`,
      400,
    );
  }
  if (!code || !state) {
    return htmlResponse(
      "Missing code or state. Try the link from Discord again.",
      400,
    );
  }

  const pending = await decryptStatePayload(state, env.OAUTH_ENCRYPTION_KEY);
  if (!pending) {
    return htmlResponse(
      "This link has expired or is invalid. Get a new link from Discord and try again.",
      400,
    );
  }

  try {
    const metadata: OAuthMetadata = {
      authorization_endpoint: "",
      token_endpoint: pending.token_endpoint,
    };
    const redirectUri = `${new URL(request.url).origin}/oauth/callback`;
    const tokens = await exchangeCodeForTokens(
      code,
      pending.code_verifier,
      metadata,
      pending.client_id,
      pending.client_secret,
      redirectUri,
    );
    const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
    const payload: OAuthPayload = {
      mcp_url: pending.mcp_url,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      token_endpoint: pending.token_endpoint,
      client_id: pending.client_id,
      client_secret: pending.client_secret,
    };
    const blob = await encryptOAuthPayload(payload, env.OAUTH_ENCRYPTION_KEY);
    const message = `OAuth connected. -# mcp-oauth: ${blob}`;
    await sendMessage(pending.channel_id, message, env.DISCORD_TOKEN);
    return htmlResponse(
      "Connected! You can close this tab and return to Discord.",
    );
  } catch (e) {
    console.error("OAuth callback failed:", e);
    return htmlResponse(
      `Token exchange failed: ${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }
}

function htmlResponse(body: string, status = 200): Response {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OAuth</title></head><body><p>${escapeHtml(body)}</p></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
