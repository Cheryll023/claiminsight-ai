import { cfg, isLlmConfigured, providerConfig } from './config.js';

export class AiError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'AiError';
    this.detail = detail;
  }
}

function headersFor(conf) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${conf.apiKey}`,
  };
}

async function readError(res) {
  const text = await res.text().catch(() => '');
  try {
    const data = JSON.parse(text);
    return data?.error?.message || data?.message || text.slice(0, 500);
  } catch {
    return text.slice(0, 500) || `HTTP ${res.status}`;
  }
}

export async function chat(messages, options = {}) {
  if (!isLlmConfigured()) {
    throw new AiError('尚未配置大模型服务，请前往「系统设置」填写 LLM API Key 与模型名称');
  }
  const conf = providerConfig('llm');
  const body = {
    model: options.model || conf.model,
    messages,
    temperature: options.temperature ?? 0.2,
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  if (options.responseFormat) body.response_format = options.responseFormat;
  if (options.stop) body.stop = options.stop;

  let res;
  try {
    res = await fetch(`${conf.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headersFor(conf),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeout ?? 300000),
    });
  } catch (err) {
    throw new AiError(`无法访问大模型服务：${err.message}`, String(err));
  }
  if (!res.ok) {
    throw new AiError(`大模型调用失败（HTTP ${res.status}）：${await readError(res)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? '';
  return { text, usage: data?.usage || null, model: data?.model || body.model };
}

export async function chatJson(messages, options = {}) {
  const ask = async (extra) => {
    const { text } = await chat(
      extra ? [...messages, { role: 'user', content: extra }] : messages,
      { ...options, responseFormat: options.noJsonMode ? undefined : { type: 'json_object' }, temperature: options.temperature ?? 0.1 },
    );
    return { text, parsed: parseJsonLoose(text) };
  };
  let result = await ask(null);
  if (result.parsed === undefined) {
    result = await ask('你上一次的输出不是合法 JSON。请只输出一个合法的 JSON 对象，不要包含解释、Markdown 代码块或多余文本。');
  }
  if (result.parsed === undefined) {
    throw new AiError('模型返回内容无法解析为 JSON，请更换模型或稍后重试', result.text.slice(0, 800));
  }
  return result.parsed;
}

export function parseJsonLoose(text) {
  if (!text) return undefined;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    /* continue */
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(s.slice(first, last + 1));
    } catch {
      /* continue */
    }
  }
  return undefined;
}

export async function streamChat(messages, onDelta, options = {}) {
  if (!isLlmConfigured()) {
    throw new AiError('尚未配置大模型服务，请前往「系统设置」填写 LLM API Key 与模型名称');
  }
  const conf = providerConfig('llm');
  const body = {
    model: options.model || conf.model,
    messages,
    temperature: options.temperature ?? 0.3,
    stream: true,
  };
  const res = await fetch(`${conf.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headersFor(conf),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout ?? 300000),
  });
  if (!res.ok) throw new AiError(`大模型调用失败（HTTP ${res.status}）：${await readError(res)}`);

  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const data = JSON.parse(payload);
        const delta = data?.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        /* ignore malformed keep-alive */
      }
    }
  }
  return full;
}

export async function embedTexts(texts) {
  const conf = providerConfig('embed');
  if (!conf.apiKey || !conf.model) return null;
  const res = await fetch(`${conf.baseUrl}/embeddings`, {
    method: 'POST',
    headers: headersFor(conf),
    body: JSON.stringify({ model: conf.model, input: texts }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new AiError(`向量化调用失败（HTTP ${res.status}）：${await readError(res)}`);
  const data = await res.json();
  return (data.data || []).map((d) => d.embedding);
}

export async function testLlm() {
  const { text } = await chat([{ role: 'user', content: '回复两个字：正常' }], { maxTokens: 16, temperature: 0 });
  return text.trim().slice(0, 40) || '(空响应)';
}

export function llmModel() {
  return cfg('llm.model');
}
