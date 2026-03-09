import type { ProviderConfig, ChatMessage } from '../types/studio';

export interface AIRequest {
  messages: ChatMessage[];
  system: string;
  signal?: AbortSignal;
  onStream?: (chunk: string) => void;
  modelOverride?: string;
}

export interface AIResponse {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
}

// Default endpoints per provider type
const DEFAULT_ENDPOINTS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
};

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.4',
};

/** Send a chat completion request to the configured provider */
export async function sendAIRequest(
  provider: ProviderConfig,
  request: AIRequest,
): Promise<AIResponse> {
  const { type, apiKey, baseUrl, modelId } = provider;
  const model = request.modelOverride || modelId || DEFAULT_MODELS[type] || 'default';

  // Anthropic uses a different API shape
  const isAnthropicFormat = type === 'anthropic';

  let url: string;
  let headers: Record<string, string>;
  let body: unknown;

  if (isAnthropicFormat) {
    url = baseUrl || DEFAULT_ENDPOINTS.anthropic;
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    body = {
      model,
      max_tokens: 16384,
      system: request.system,
      messages: request.messages.map((m) => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
      })),
    };
  } else {
    // OpenAI-compatible format (works with OpenAI, OpenRouter, Ollama, LM Studio, etc.)
    url = baseUrl || DEFAULT_ENDPOINTS[type] || 'http://localhost:11434/v1/chat/completions';
    headers = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    body = {
      model,
      max_tokens: 16384,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: request.signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`AI request failed (${resp.status}): ${text}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  try {
    data = await resp.json();
  } catch {
    throw new Error(`AI response was not valid JSON`);
  }

  if (isAnthropicFormat) {
    return {
      content: data.content?.[0]?.text ?? '',
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
    };
  } else {
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}
