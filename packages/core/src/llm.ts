/**
 * Minimal OpenAI-compatible chat client. Provider-agnostic: point
 * `NEBULA_LLM_BASE_URL` at any compatible endpoint and swap models with
 * `NEBULA_LLM_MODEL` — no code changes.
 */

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function llmConfigFromEnv(): LlmConfig {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for LLM-backed agents');
  }
  return {
    apiKey,
    baseUrl: process.env.NEBULA_LLM_BASE_URL?.trim() || 'https://api.openai.com/v1',
    model: process.env.NEBULA_LLM_MODEL?.trim() || 'gpt-4o-mini',
  };
}

export async function chat(config: LlmConfig, messages: ChatMessage[]): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model: config.model, messages, temperature: 0.2 }),
  });
  if (!response.ok) {
    throw new Error(`LLM request failed: HTTP ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM returned no content');
  }
  return content;
}

/** Chat with `response_format: json_object`, parsed into `T`. */
export async function chatJson<T>(config: LlmConfig, messages: ChatMessage[]): Promise<T> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) {
    throw new Error(`LLM request failed: HTTP ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM returned no content');
  }
  return JSON.parse(content) as T;
}
