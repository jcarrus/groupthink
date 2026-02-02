/**
 * Claude (Anthropic) API client.
 * Simple wrapper for the Messages API.
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';

export interface Message {
  role: 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
}

export interface ChatResponse {
  text: string;
  usage: Record<string, unknown>;
}

/** Add cache_control to the last message's last content part */
function withCaching(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  
  const result = messages.map(m => ({ ...m }));
  const lastMsg = result[result.length - 1];
  
  // Convert string content to array format with cache_control
  if (typeof lastMsg.content === 'string') {
    lastMsg.content = [{ type: 'text', text: lastMsg.content, cache_control: { type: 'ephemeral' } }];
  } else {
    // Add cache_control to last part
    const parts = [...lastMsg.content];
    const lastPart = { ...parts[parts.length - 1], cache_control: { type: 'ephemeral' } as const };
    parts[parts.length - 1] = lastPart;
    lastMsg.content = parts;
  }
  
  return result;
}

/** Send messages to Claude and get a response */
export async function chat(
  messages: Message[],
  apiKey: string,
  systemPrompt?: string
): Promise<ChatResponse> {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt ?? 'You are a helpful assistant in a Discord chat.',
      messages: withCaching(messages),
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Claude API error: ${res.status} ${error}`);
  }

  const data: { 
    content: Array<{ type: string; text: string }>;
    usage: Record<string, unknown>;
  } = await res.json();
  
  return {
    text: data.content[0]?.text ?? '',
    usage: data.usage,
  };
}
