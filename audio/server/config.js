import { getSetting, setSetting } from './db.js';

const DEFAULTS = {
  'llm.base_url': 'https://api.openai.com/v1',
  'llm.api_key': '',
  'llm.model': 'gpt-4o-mini',
  'asr.base_url': 'https://api.openai.com/v1',
  'asr.api_key': '',
  'asr.model': 'whisper-1',
  'asr.language': 'zh',
  'asr.diarization': 'auto',
  'embed.base_url': 'https://api.openai.com/v1',
  'embed.api_key': '',
  'embed.model': '',
  'app.max_upload_mb': '500',
};

const ENV_MAP = {
  'llm.base_url': ['LLM_BASE_URL'],
  'llm.api_key': ['LLM_API_KEY'],
  'llm.model': ['LLM_MODEL'],
  'asr.base_url': ['ASR_BASE_URL'],
  'asr.api_key': ['ASR_API_KEY'],
  'asr.model': ['ASR_MODEL'],
  'embed.base_url': ['EMBED_BASE_URL'],
  'embed.api_key': ['EMBED_API_KEY'],
  'embed.model': ['EMBED_MODEL'],
};

export function cfg(key) {
  const stored = getSetting(key, '');
  if (stored) return stored;
  for (const envName of ENV_MAP[key] || []) {
    if (process.env[envName]) return process.env[envName];
  }
  return DEFAULTS[key] ?? '';
}

export function isLlmConfigured() {
  return Boolean(cfg('llm.api_key') && cfg('llm.base_url') && cfg('llm.model'));
}

export function isAsrConfigured() {
  return Boolean(cfg('asr.api_key') && cfg('asr.base_url') && cfg('asr.model'));
}

export function isEmbedConfigured() {
  return Boolean(cfg('embed.api_key') && cfg('embed.base_url') && cfg('embed.model'));
}

const MASK = '••••••••';

export function publicSettings() {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const value = cfg(key);
    out[key] = key.endsWith('api_key') ? (value ? MASK : '') : value;
  }
  out['_env'] = Object.fromEntries(
    Object.entries(ENV_MAP).map(([key, [envName]]) => [key, Boolean(process.env[envName])]),
  );
  return out;
}

export function saveSettings(patch) {
  for (const [key, rawValue] of Object.entries(patch || {})) {
    if (!Object.hasOwn(DEFAULTS, key)) continue;
    const value = String(rawValue ?? '').trim();
    if (key.endsWith('api_key') && value === MASK) continue;
    setSetting(key, value);
  }
}

export function providerConfig(kind) {
  return {
    baseUrl: cfg(`${kind}.base_url`).replace(/\/+$/, ''),
    apiKey: cfg(`${kind}.api_key`),
    model: cfg(`${kind}.model`),
  };
}
