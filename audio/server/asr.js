import fs from 'node:fs';
import path from 'node:path';
import { cfg, isAsrConfigured, providerConfig } from './config.js';
import { splitForAsr } from './audio.js';
import { AiError, chatJson } from './llm.js';

const MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  amr: 'audio/amr',
  wma: 'audio/x-ms-wma',
  webm: 'audio/webm',
};

async function callTranscription(filePath, responseFormat) {
  const conf = providerConfig('asr');
  const buf = await fs.promises.readFile(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const form = new FormData();
  form.append('file', new Blob([buf], { type: MIME_BY_EXT[ext] || 'application/octet-stream' }), path.basename(filePath));
  form.append('model', conf.model);
  form.append('response_format', responseFormat);
  if (cfg('asr.language')) form.append('language', cfg('asr.language'));
  if (responseFormat === 'diarized_json') form.append('chunking_strategy', 'auto');

  const res = await fetch(`${conf.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${conf.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(900000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 500);
    try {
      msg = JSON.parse(text)?.error?.message || msg;
    } catch {
      /* ignore */
    }
    const err = new AiError(`语音转写失败（HTTP ${res.status}）：${msg}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function normalizeSegments(raw, offset = 0) {
  const out = [];
  if (Array.isArray(raw.segments) && raw.segments.length) {
    raw.segments.forEach((seg, i) => {
      const text = String(seg.text ?? '').trim();
      if (!text) return;
      out.push({
        start: (Number(seg.start) || 0) + offset,
        end: (Number(seg.end) || Number(seg.start) || 0) + offset,
        speaker: seg.speaker != null ? String(seg.speaker) : '',
        text,
        idx: i,
      });
    });
    return out;
  }
  const text = String(raw.text ?? '').trim();
  if (!text) return out;
  const parts = text.split(/(?<=[。！？!?；;])|\n+/).map((s) => s.trim()).filter(Boolean);
  let cursor = offset;
  for (const part of parts) {
    const weight = Math.max(1.2, part.length / 4.2);
    out.push({ start: cursor, end: cursor + weight, speaker: '', text: part, idx: out.length });
    cursor += weight;
  }
  return out;
}

/**
 * 对录音执行转写。返回 { segments, duration, diarized, model, roleSource, notes }
 */
export async function transcribeRecording(rec, onProgress = () => {}) {
  if (!isAsrConfigured()) {
    throw new AiError('尚未配置语音转写服务，请前往「系统设置」填写 ASR API Key 与模型');
  }
  const diarMode = cfg('asr.diarization') || 'auto';
  const model = cfg('asr.model');
  const wantsDiarization = diarMode === 'on' || (diarMode === 'auto' && /diarize/i.test(model));
  const notes = [];

  const { chunks, cleanup } = splitForAsr(rec.stored_path, 20 * 1024 * 1024);
  const segments = [];
  let diarized = false;
  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      onProgress(Math.round((i / chunks.length) * 80) + 5, `正在转写第 ${i + 1}/${chunks.length} 段`);
      let raw;
      let formatUsed = wantsDiarization ? 'diarized_json' : 'verbose_json';
      try {
        raw = await callTranscription(chunk.path, formatUsed);
        if (formatUsed === 'diarized_json') diarized = true;
      } catch (err) {
        if (err.status !== 400 && err.status !== 422) throw err;
        notes.push(`服务不支持 ${formatUsed}，已回退到 verbose_json`);
        formatUsed = 'verbose_json';
        try {
          raw = await callTranscription(chunk.path, formatUsed);
        } catch (err2) {
          notes.push('服务不支持 verbose_json，已回退为纯文本转写');
          raw = await callTranscription(chunk.path, 'json');
        }
      }
      const segs = normalizeSegments(raw, chunk.offset || 0);
      if (raw.segments?.some((s) => s.speaker != null)) diarized = true;
      segments.push(...segs);
    }
  } finally {
    cleanup();
  }

  if (!segments.length) {
    throw new AiError('转写结果为空，请确认录音内容是否有效（静音或格式异常）');
  }

  // 重新编号
  segments.forEach((s, i) => {
    s.idx = i;
    s.start = Math.max(0, Number(s.start.toFixed(2)));
    s.end = Math.max(s.start + 0.2, Number(s.end.toFixed(2)));
  });

  let roleSource = 'diarization';
  if (diarized && segments.some((s) => s.speaker)) {
    const mapping = await mapSpeakersToRoles(segments).catch(() => null);
    if (mapping) {
      for (const seg of segments) {
        seg.role = mapping[seg.speaker] || 'unknown';
      }
      roleSource = 'diarization+llm';
    } else {
      segments.forEach((s) => (s.role = 'unknown'));
      roleSource = 'diarization';
    }
  } else {
    const roles = await inferRolesFromText(segments).catch(() => null);
    if (roles) {
      segments.forEach((s, i) => (s.role = roles[i] || 'unknown'));
      roleSource = 'llm';
      notes.push('转写服务未返回说话人分离结果，当前说话人角色由 AI 依据内容推断，建议人工复核');
    } else {
      segments.forEach((s) => (s.role = 'unknown'));
      roleSource = 'none';
      notes.push('未能获取说话人信息，请手动标注理赔专员与客户');
    }
  }

  const duration = segments.length ? segments[segments.length - 1].end : null;
  return { segments, duration, diarized, model, roleSource, notes };
}

async function mapSpeakersToRoles(segments) {
  const bySpeaker = new Map();
  for (const seg of segments) {
    if (!seg.speaker) continue;
    if (!bySpeaker.has(seg.speaker)) bySpeaker.set(seg.speaker, []);
    if (bySpeaker.get(seg.speaker).length < 6) bySpeaker.get(seg.speaker).push(seg.text.slice(0, 120));
  }
  if (bySpeaker.size < 2) {
    const only = [...bySpeaker.keys()][0];
    return only ? { [only]: 'agent' } : {};
  }
  const payload = [...bySpeaker.entries()].map(([speaker, samples]) => ({ speaker, samples }));
  const result = await chatJson([
    {
      role: 'system',
      content:
        '你是保险理赔通话分析助手。请判断每个说话人属于「理赔专员(agent)」还是「客户(customer)」。理赔专员通常主动介绍身份、询问事故信息、说明理赔流程与材料要求；客户通常陈述事故经过、表达诉求或不满。只输出 JSON。',
    },
    {
      role: 'user',
      content: `说话人样本：\n${JSON.stringify(payload, null, 2)}\n\n输出格式：{"mapping":{"说话人标识":"agent 或 customer"}}`,
    },
  ], { temperature: 0 });
  const mapping = result?.mapping || result;
  const clean = {};
  for (const key of bySpeaker.keys()) {
    const v = String(mapping?.[key] || '').toLowerCase();
    clean[key] = v.includes('agent') || v.includes('专员') ? 'agent' : v.includes('customer') || v.includes('客户') ? 'customer' : 'unknown';
  }
  return clean;
}

async function inferRolesFromText(segments) {
  const roles = new Array(segments.length).fill('unknown');
  const batchSize = 32;
  for (let start = 0; start < segments.length; start += batchSize) {
    const batch = segments.slice(start, start + batchSize);
    const lines = batch
      .map((s, i) => `${i}. ${s.text.replace(/\s+/g, ' ').slice(0, 150)}`)
      .join('\n');
    let result;
    try {
      result = await chatJson([
        {
          role: 'system',
          content:
            '你是保险理赔通话的角色标注助手。请把每条语句标注为 agent（理赔专员）或 customer（客户）。判断依据：主动询问、说明流程、承诺跟进、介绍身份多为 agent；陈述事故、提诉求、表达情绪多为 customer。无法判断时用 unknown。只输出 JSON。',
        },
        {
          role: 'user',
          content: `语句列表：\n${lines}\n\n输出格式：{"roles":["agent","customer",...]}(长度必须为 ${batch.length})`,
        },
      ], { temperature: 0 });
    } catch {
      continue;
    }
    const list = Array.isArray(result?.roles) ? result.roles : [];
    list.forEach((r, i) => {
      const v = String(r).toLowerCase();
      roles[start + i] = v.startsWith('agent') || v.includes('专员') ? 'agent' : v.startsWith('customer') || v.includes('客户') ? 'customer' : 'unknown';
    });
  }
  return roles.some((r) => r !== 'unknown') ? roles : null;
}

function silentWav(seconds = 1) {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export async function testAsr() {
  if (!isAsrConfigured()) throw new AiError('语音转写服务未配置完整');
  const tmp = path.join(process.env.TMPDIR || '/tmp', `asr-test-${Date.now()}.wav`);
  fs.writeFileSync(tmp, silentWav(1));
  try {
    const raw = await callTranscription(tmp, 'verbose_json').catch(async (err) => {
      if (err.status === 400 || err.status === 422) return callTranscription(tmp, 'json');
      throw err;
    });
    return `连接成功，模型返回：${String(raw.text || '').slice(0, 40) || '(空)'}`;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
