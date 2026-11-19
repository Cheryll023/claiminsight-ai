import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { q, jsonParse, nowIso, uid, UPLOAD_DIR, TMP_DIR, deleteRecordingFile } from './db.js';
import { sendJson, sendError, readJson, streamToFile, serveStatic, serveAudio, serializeSse, HttpError } from './http.js';
import { parseRecordingName, normalizeCaseCode, isAudioFile, isZipName, extOf, formatDuration } from './filename.js';
import { buildGroups, classifySync, startClassification, summarizeGroups, isClassifying } from './classify.js';
import { listZipEntries, readZipEntry } from './zip.js';
import { probeDuration } from './audio.js';
import { enqueueCase } from './pipeline.js';
import { recoverInterrupted, queueStats } from './pipeline.js';
import { publicSettings, saveSettings, isLlmConfigured, isAsrConfigured, isEmbedConfigured } from './config.js';
import { testLlm } from './llm.js';
import { testAsr } from './asr.js';
import { ingestDocument, searchKnowledge, kbStats, invalidateIndex } from './kb.js';
import { answerQuestion, loadConversation, saveMessage } from './qa.js';
import { deepAnalyzeClaim } from './analysis.js';
import { computeBatchInsights } from './insights.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 1024) * 1024 * 1024;

/* ---------------- 路由 ---------------- */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:([a-zA-Z]+)/g, (_m, key) => {
        keys.push(key);
        return '([^/]+)';
      }) +
      '$',
  );
  routes.push({ method, regex, keys, handler });
}

/* ---------------- 概览 ---------------- */

route('GET', '/api/dashboard', async (req, res) => {
  const caseCount = q.get('SELECT COUNT(*) AS c FROM cases')?.c || 0;
  const readyCount = q.get("SELECT COUNT(*) AS c FROM cases WHERE status = 'ready'")?.c || 0;
  const pendingCount = q.get("SELECT COUNT(*) AS c FROM cases WHERE status = 'pending'")?.c || 0;
  const processingCount = q.get("SELECT COUNT(*) AS c FROM cases WHERE status IN ('queued','processing')")?.c || 0;
  const failedCount = q.get("SELECT COUNT(*) AS c FROM cases WHERE status = 'failed'")?.c || 0;
  const recordingCount = q.get('SELECT COUNT(*) AS c FROM recordings')?.c || 0;
  const transcribedCount = q.get("SELECT COUNT(*) AS c FROM recordings WHERE status = 'transcribed'")?.c || 0;
  const transcribingCount = q.get("SELECT COUNT(*) AS c FROM recordings WHERE status = 'transcribing'")?.c || 0;
  const failedRecordingCount = q.get("SELECT COUNT(*) AS c FROM recordings WHERE status = 'failed'")?.c || 0;
  const unassignedCount = q.get('SELECT COUNT(*) AS c FROM recordings WHERE case_id IS NULL')?.c || 0;
  const durationSum = q.get("SELECT COALESCE(SUM(duration),0) AS s FROM recordings WHERE status = 'transcribed'")?.s || 0;
  const kb = kbStats();

  const recentCases = q.all(`
    SELECT c.*,
      (SELECT COUNT(*) FROM recordings r WHERE r.case_id = c.id) AS recording_count,
      (SELECT COALESCE(SUM(duration),0) FROM recordings r WHERE r.case_id = c.id) AS duration
    FROM cases c ORDER BY COALESCE(c.analysis_at, c.updated_at) DESC LIMIT 8
  `);
  const recentBatches = q.all(`
    SELECT b.*,
      (SELECT COUNT(*) FROM recordings r WHERE r.batch_id = b.id) AS file_count,
      (SELECT COUNT(DISTINCT case_id) FROM recordings r WHERE r.batch_id = b.id AND r.case_id IS NOT NULL) AS case_count
    FROM batches b ORDER BY b.created_at DESC LIMIT 4
  `);
  const activeJobs = q.all("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 6");
  const attention = q.all(`
    SELECT c.id, c.code, c.status, c.analysis_error, c.updated_at,
      (SELECT COUNT(*) FROM recordings r WHERE r.case_id = c.id AND r.status = 'failed') AS failed_recordings
    FROM cases c
    WHERE c.status = 'failed' OR c.analysis_error IS NOT NULL
       OR EXISTS (SELECT 1 FROM recordings r WHERE r.case_id = c.id AND r.status = 'failed')
    ORDER BY c.updated_at DESC LIMIT 6
  `);
  sendJson(res, 200, {
    stats: {
      cases: caseCount,
      ready: readyCount,
      pending: pendingCount,
      processing: processingCount,
      failed: failedCount,
      recordings: recordingCount,
      transcribed: transcribedCount,
      transcribing: transcribingCount,
      failedRecordings: failedRecordingCount,
      unassigned: unassignedCount,
      audioHours: Number((durationSum / 3600).toFixed(1)),
      kbDocs: kb.docs,
      kbChunks: kb.chunks,
    },
    recentCases: recentCases.map(mapCase),
    recentBatches,
    activeJobs,
    attention,
    ai: {
      llm: isLlmConfigured(),
      asr: isAsrConfigured(),
      embed: isEmbedConfigured(),
    },
    queue: queueStats(),
  });
});

/* ---------------- 批次与上传 ---------------- */

route('POST', '/api/batches', async (req, res) => {
  const body = await readJson(req);
  const name = String(body.name || '').trim() || `上传批次 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  const id = uid();
  q.run('INSERT INTO batches(id, name, created_at, status) VALUES(?,?,?,?)', id, name, nowIso(), 'uploading');
  sendJson(res, 200, { id, name });
});

route('GET', '/api/batches', async (req, res) => {
  const rows = q.all(`
    SELECT b.*,
      (SELECT COUNT(*) FROM recordings r WHERE r.batch_id = b.id) AS file_count,
      (SELECT COUNT(DISTINCT case_id) FROM recordings r WHERE r.batch_id = b.id AND r.case_id IS NOT NULL) AS case_count,
      (SELECT COUNT(*) FROM recordings r WHERE r.batch_id = b.id AND r.status = 'failed') AS failed_count
    FROM batches b ORDER BY b.created_at DESC
  `);
  sendJson(res, 200, { batches: rows });
});

route('GET', '/api/batches/:id', async (req, res, { id }) => {
  const batch = q.get('SELECT * FROM batches WHERE id = ?', id);
  if (!batch) throw new HttpError(404, '批次不存在');
  const recordings = q.all('SELECT * FROM recordings WHERE batch_id = ? ORDER BY sort_index ASC, created_at ASC', id);
  const cases = q.all('SELECT * FROM cases WHERE batch_id = ? ORDER BY code ASC', id);
  const groups = buildGroups(recordings);
  sendJson(res, 200, {
    batch,
    classify: {
      status: batch.classify_status || 'idle',
      message: batch.classify_message || '',
      at: batch.classify_at || null,
      running: isClassifying(id),
      summary: summarizeGroups(groups),
      contentAvailable: isAsrConfigured() && isLlmConfigured(),
    },
    recordings: recordings.map((r) => ({
      ...r,
      transcript_json: undefined,
      content_hints: undefined,
      has_transcript: Boolean(r.transcript_json),
    })),
    cases: cases.map((c) => ({
      ...mapCase(c),
      recordingCount: recordings.filter((r) => r.case_id === c.id).length,
      job: q.get('SELECT * FROM jobs WHERE ref_id = ? ORDER BY created_at DESC LIMIT 1', c.id) || null,
    })),
    groups,
    insights: computeBatchInsights(cases),
  });
});

route('PUT', '/api/batches/:id/files', async (req, res, { id }) => {
  const batch = q.get('SELECT id FROM batches WHERE id = ?', id);
  if (!batch) throw new HttpError(404, '批次不存在');
  const url = new URL(req.url, 'http://localhost');
  const filename = decodeURIComponent(url.searchParams.get('name') || '');
  const index = Number(url.searchParams.get('index') || 0);
  if (!filename) throw new HttpError(400, '缺少文件名');
  if (!isAudioFile(filename)) throw new HttpError(400, `不支持的音频格式：${filename}`);

  const storedName = `${uid()}.${extOf(filename)}`;
  const dir = path.join(UPLOAD_DIR, id);
  const storedPath = path.join(dir, storedName);
  const size = await streamToFile(req, storedPath, { maxBytes: MAX_UPLOAD });
  if (!size) {
    await fsp.rm(storedPath, { force: true });
    throw new HttpError(400, '上传内容为空');
  }
  const parsed = parseRecordingName(filename);
  const recId = uid();
  const duration = probeDuration(storedPath);
  q.run(
    `INSERT INTO recordings(id, batch_id, filename, stored_path, size, format, duration, rec_date, rec_type, employee_id, status, needs_review, sort_index, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    recId,
    id,
    filename,
    storedPath,
    size,
    extOf(filename),
    duration,
    parsed.date,
    parsed.recType,
    parsed.employeeId,
    'uploaded',
    parsed.caseCode ? 0 : 1,
    index,
    nowIso(),
  );
  sendJson(res, 200, { id: recId, size, parsed });
});

route('POST', '/api/batches/:id/zip', async (req, res, { id }) => {
  const batch = q.get('SELECT id FROM batches WHERE id = ?', id);
  if (!batch) throw new HttpError(404, '批次不存在');
  const url = new URL(req.url, 'http://localhost');
  const filename = decodeURIComponent(url.searchParams.get('name') || 'upload.zip');
  const tmpPath = path.join(TMP_DIR, `${uid()}.zip`);
  const size = await streamToFile(req, tmpPath, { maxBytes: MAX_UPLOAD });
  try {
    const buf = await fsp.readFile(tmpPath);
    if (!isZipName(filename) && !/^PK/.test(buf.toString('latin1', 0, 2))) {
      throw new HttpError(400, '文件不是有效的 ZIP 压缩包');
    }
    const entries = listZipEntries(buf);
    const audioEntries = entries.filter(
      (e) => !e.isDir && isAudioFile(e.name) && !/(^|\/)__MACOSX\//.test(e.name) && !/\._/.test(path.basename(e.name)),
    );
    if (!audioEntries.length) throw new HttpError(400, 'ZIP 中未找到音频文件');
    const dir = path.join(UPLOAD_DIR, id);
    await fsp.mkdir(dir, { recursive: true });
    const baseIndex = q.get('SELECT COUNT(*) AS c FROM recordings WHERE batch_id = ?', id)?.c || 0;
    let idx = 0;
    const skipped = [];
    const created = [];
    for (const entry of audioEntries) {
      if (entry.encrypted) {
        skipped.push({ name: entry.name, reason: '压缩包内文件已加密' });
        continue;
      }
      const flatName = path.basename(entry.name);
      try {
        const data = readZipEntry(buf, entry);
        const storedPath = path.join(dir, `${uid()}.${extOf(flatName)}`);
        await fsp.writeFile(storedPath, data);
        const parsed = parseRecordingName(flatName);
        const recId = uid();
        q.run(
          `INSERT INTO recordings(id, batch_id, filename, stored_path, size, format, duration, rec_date, rec_type, employee_id, status, needs_review, sort_index, created_at, source_path)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          recId,
          id,
          flatName,
          storedPath,
          data.length,
          extOf(flatName),
          probeDuration(storedPath),
          parsed.date,
          parsed.recType,
          parsed.employeeId,
          'uploaded',
          parsed.caseCode ? 0 : 1,
          baseIndex + idx,
          nowIso(),
          entry.name,
        );
        created.push({ id: recId, name: flatName, size: data.length });
        idx++;
      } catch (err) {
        skipped.push({ name: entry.name, reason: err.message });
      }
    }
    sendJson(res, 200, { added: created.length, files: created, skipped, totalEntries: entries.length });
  } finally {
    await fsp.rm(tmpPath, { force: true });
  }
});

/* 分层识别：文件名 → 目录结构 → 录音内容，异步执行 */
route('POST', '/api/batches/:id/classify', async (req, res, { id }) => {
  const batch = q.get('SELECT id FROM batches WHERE id = ?', id);
  if (!batch) throw new HttpError(404, '批次不存在');
  const body = await readJson(req).catch(() => ({}));
  const result = startClassification(id, { reset: Boolean(body?.reset) });
  if (!result.started) throw new HttpError(409, result.reason || '无法启动识别');
  sendJson(res, 200, { started: true });
});

/* 兼容旧调用：仅按文件名与目录结构同步归类 */
route('POST', '/api/batches/:id/group', async (req, res, { id }) => {
  const recordings = q.all('SELECT id FROM recordings WHERE batch_id = ?', id);
  if (!recordings.length) throw new HttpError(400, '批次中还没有录音文件');
  const { groups } = classifySync(id);
  sendJson(res, 200, { groups });
});

/* 人工指定录音归属（移动分组时持久化） */
route('POST', '/api/recordings/:id/assign', async (req, res, { id }) => {
  const rec = q.get('SELECT * FROM recordings WHERE id = ?', id);
  if (!rec) throw new HttpError(404, '录音不存在');
  const body = await readJson(req);
  const code = normalizeCaseCode(String(body?.code || '').trim());
  if (!code) throw new HttpError(400, '缺少案件编号');
  q.run(
    'UPDATE recordings SET match_code = ?, match_source = ?, match_confidence = ?, needs_review = 0 WHERE id = ?',
    code,
    'manual',
    'high',
    id,
  );
  sendJson(res, 200, { ok: true, code });
});

route('POST', '/api/batches/:id/confirm', async (req, res, { id }) => {
  const batch = q.get('SELECT * FROM batches WHERE id = ?', id);
  if (!batch) throw new HttpError(404, '批次不存在');
  const body = await readJson(req);
  const groups = Array.isArray(body.groups) ? body.groups : [];
  if (!groups.length) throw new HttpError(400, '没有需要确认的案件分组');

  const codes = new Set();
  for (const group of groups) {
    const code = normalizeCaseCode(String(group.code || '').trim());
    if (!code) throw new HttpError(400, '存在未填写案件编号的分组');
    if (codes.has(code)) throw new HttpError(400, `案件编号重复：${code}`);
    codes.add(code);
    if (!Array.isArray(group.recordingIds) || !group.recordingIds.length) {
      throw new HttpError(400, `案件 ${code} 没有关联录音`);
    }
  }

  // 清理该批次此前自动生成的案件（重新确认场景）
  const existing = q.all('SELECT id FROM cases WHERE batch_id = ?', id);
  for (const c of existing) {
    const used = q.get('SELECT COUNT(*) AS c FROM recordings WHERE case_id = ? AND batch_id = ?', c.id, id);
    if (used?.c) q.run('UPDATE recordings SET case_id = NULL WHERE case_id = ? AND batch_id = ?', c.id, id);
    q.run('DELETE FROM cases WHERE id = ?', c.id);
  }

  const createdCases = [];
  for (const group of groups) {
    const caseId = uid();
    const code = normalizeCaseCode(group.code);
    const employeeId = String(group.employeeId || '').trim();
    q.run(
      'INSERT INTO cases(id, batch_id, code, employee_id, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
      caseId,
      id,
      code,
      employeeId,
      'queued',
      nowIso(),
      nowIso(),
    );
    for (const recId of group.recordingIds) {
      q.run(
        'UPDATE recordings SET case_id = ?, employee_id = ?, needs_review = 0, status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ? AND batch_id = ?',
        caseId,
        employeeId,
        'failed',
        'uploaded',
        recId,
        id,
      );
    }
    createdCases.push({ id: caseId, code });
  }
  q.run('UPDATE batches SET status = ? WHERE id = ?', 'confirmed', id);

  let queued = 0;
  for (const c of createdCases) {
    const result = enqueueCase(c.id);
    if (result.queued) {
      queued += 1;
    } else {
      q.run(
        "UPDATE cases SET status = 'pending', analysis_error = ?, updated_at = ? WHERE id = ?",
        result.reason || '未能启动分析',
        nowIso(),
        c.id,
      );
    }
  }
  sendJson(res, 200, { cases: createdCases, queued });
});

route('DELETE', '/api/batches/:id', async (req, res, { id }) => {
  const recordings = q.all('SELECT * FROM recordings WHERE batch_id = ?', id);
  for (const rec of recordings) deleteRecordingFile(rec);
  const cases = q.all('SELECT id FROM cases WHERE batch_id = ?', id);
  for (const c of cases) {
    q.run('DELETE FROM messages WHERE case_id = ?', c.id);
    q.run('DELETE FROM cases WHERE id = ?', c.id);
  }
  q.run('DELETE FROM recordings WHERE batch_id = ?', id);
  q.run('DELETE FROM batches WHERE id = ?', id);
  sendJson(res, 200, { ok: true });
});

/* ---------------- 录音 ---------------- */

route('GET', '/api/recordings/:id', async (req, res, { id }) => {
  const rec = q.get('SELECT * FROM recordings WHERE id = ?', id);
  if (!rec) throw new HttpError(404, '录音不存在');
  sendJson(res, 200, {
    ...rec,
    transcript: jsonParse(rec.transcript_json, null),
    case: rec.case_id ? q.get('SELECT id, code, status FROM cases WHERE id = ?', rec.case_id) : null,
  });
});

route('GET', '/api/recordings/:id/audio', async (req, res, { id }) => {
  const rec = q.get('SELECT * FROM recordings WHERE id = ?', id);
  if (!rec) throw new HttpError(404, '录音不存在');
  const url = new URL(req.url, 'http://localhost');
  serveAudio(req, res, rec.stored_path, url.searchParams.get('download') ? rec.filename : null);
});

route('PATCH', '/api/recordings/:id', async (req, res, { id }) => {
  const rec = q.get('SELECT * FROM recordings WHERE id = ?', id);
  if (!rec) throw new HttpError(404, '录音不存在');
  const body = await readJson(req);
  const fields = [];
  const params = [];
  for (const key of ['rec_type', 'rec_date', 'employee_id', 'filename']) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(String(body[key] || ''));
    }
  }
  if (body.caseId !== undefined) {
    const targetCase = body.caseId ? q.get('SELECT * FROM cases WHERE id = ?', body.caseId) : null;
    if (body.caseId && !targetCase) throw new HttpError(404, '目标案件不存在');
    fields.push('case_id = ?', 'needs_review = 0');
    params.push(body.caseId || null);
    if (targetCase && targetCase.batch_id !== rec.batch_id) {
      fields.push('batch_id = ?');
      params.push(targetCase.batch_id);
    }
  }
  if (!fields.length) throw new HttpError(400, '没有需要更新的字段');
  params.push(id);
  q.run(`UPDATE recordings SET ${fields.join(', ')} WHERE id = ?`, ...params);

  // 归属变化后，源案件若已无录音则删除，目标案件标记为需重新分析
  if (body.caseId !== undefined && rec.case_id && rec.case_id !== body.caseId) {
    const left = q.get('SELECT COUNT(*) AS c FROM recordings WHERE case_id = ?', rec.case_id);
    if (!left?.c) {
      q.run('DELETE FROM messages WHERE case_id = ?', rec.case_id);
      q.run('DELETE FROM cases WHERE id = ?', rec.case_id);
    } else {
      q.run("UPDATE cases SET status = 'ready', updated_at = ? WHERE id = ?", nowIso(), rec.case_id);
    }
  }
  if (body.caseId) {
    q.run("UPDATE cases SET status = CASE WHEN status = 'processing' THEN status ELSE 'pending' END, updated_at = ? WHERE id = ?", nowIso(), body.caseId);
  }
  sendJson(res, 200, { ok: true });
});

route('PATCH', '/api/recordings/:id/transcript', async (req, res, { id }) => {
  const rec = q.get('SELECT * FROM recordings WHERE id = ?', id);
  if (!rec) throw new HttpError(404, '录音不存在');
  const transcript = jsonParse(rec.transcript_json, null);
  if (!transcript) throw new HttpError(400, '该录音还没有转写结果');
  const body = await readJson(req);

  if (body.speaker && body.role) {
    // 整段说话人角色修正
    const from = String(body.speaker);
    transcript.segments = transcript.segments.map((s) => (s.speaker === from ? { ...s, role: body.role } : s));
    transcript.notes = [...(transcript.notes || []), `人工修正说话人 ${from} 为 ${roleLabel(body.role)}`];
    transcript.roleSource = 'manual';
  } else if (Array.isArray(body.segments)) {
    const map = new Map(body.segments.map((s) => [Number(s.idx), s.role]));
    transcript.segments = transcript.segments.map((s) => (map.has(s.idx) ? { ...s, role: map.get(s.idx) } : s));
    transcript.roleSource = 'manual';
  } else if (Array.isArray(body.fullSegments)) {
    transcript.segments = body.fullSegments.map((s, i) => ({
      idx: i,
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      speaker: s.speaker || '',
      role: s.role || 'unknown',
      text: String(s.text || ''),
    }));
    transcript.roleSource = 'manual';
  } else {
    throw new HttpError(400, '未提供可更新的转写内容');
  }
  q.run('UPDATE recordings SET transcript_json = ? WHERE id = ?', JSON.stringify(transcript), id);
  if (rec.case_id) {
    q.run("UPDATE cases SET status = CASE WHEN status IN ('processing','queued') THEN status ELSE 'pending' END, updated_at = ? WHERE id = ?", nowIso(), rec.case_id);
  }
  sendJson(res, 200, { ok: true, transcript });
});

route('POST', '/api/recordings/:id/retry', async (req, res, { id }) => {
  const rec = q.get('SELECT * FROM recordings WHERE id = ?', id);
  if (!rec) throw new HttpError(404, '录音不存在');
  if (!rec.case_id) throw new HttpError(400, '请先确认该录音的案件归属');
  q.run("UPDATE recordings SET status = 'uploaded', error = NULL, progress = 0 WHERE id = ?", id);
  const result = enqueueCase(rec.case_id, { reanalyze: true });
  if (!result.queued) throw new HttpError(400, result.reason);
  sendJson(res, 200, { ok: true, jobId: result.jobId });
});

route('DELETE', '/api/recordings/:id', async (req, res, { id }) => {
  const rec = q.get('SELECT * FROM recordings WHERE id = ?', id);
  if (!rec) throw new HttpError(404, '录音不存在');
  deleteRecordingFile(rec);
  q.run('DELETE FROM recordings WHERE id = ?', id);
  if (rec.case_id) {
    const left = q.get('SELECT COUNT(*) AS c FROM recordings WHERE case_id = ?', rec.case_id);
    if (!left?.c) {
      q.run('DELETE FROM messages WHERE case_id = ?', rec.case_id);
      q.run('DELETE FROM cases WHERE id = ?', rec.case_id);
    }
  }
  sendJson(res, 200, { ok: true });
});

function roleLabel(role) {
  return role === 'agent' ? '理赔专员' : role === 'customer' ? '客户' : '未知';
}

/* ---------------- 案件 ---------------- */

function mapCase(row) {
  const report = row.report_json ? jsonParse(row.report_json, null) : null;
  const summary = report?.summary || {};
  const claims = Array.isArray(report?.claims) ? report.claims : [];
  const claimEscalations = claims.reduce((s, c) => s + (c.dispute?.escalation?.length || 0), 0);
  return {
    id: row.id,
    code: row.code,
    batchId: row.batch_id,
    employeeId: row.employee_id,
    status: row.status,
    error: row.analysis_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    analysisAt: row.analysis_at,
    recordingCount: row.recording_count ?? undefined,
    duration: row.duration ?? undefined,
    summary:
      summary.mainClaim ||
      summary.overview ||
      summary.customerDemands ||
      summary.events ||
      summary.background ||
      '',
    claimCount: claims.length,
    escalationCount: claimEscalations,
    riskCount: Array.isArray(report?.riskSignals)
      ? report.riskSignals.length
      : Array.isArray(report?.risks)
        ? report.risks.length
        : 0,
  };
}

route('GET', '/api/cases', async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const status = url.searchParams.get('status') || '';
  const keyword = (url.searchParams.get('q') || '').trim();
  const params = [];
  let where = '1=1';
  if (status) {
    where += ' AND c.status = ?';
    params.push(status);
  }
  if (keyword) {
    where += ' AND (c.code LIKE ? OR c.employee_id LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const rows = q.all(
    `SELECT c.*,
      (SELECT COUNT(*) FROM recordings r WHERE r.case_id = c.id) AS recording_count,
      (SELECT COALESCE(SUM(duration),0) FROM recordings r WHERE r.case_id = c.id) AS duration
     FROM cases c WHERE ${where} ORDER BY c.updated_at DESC`,
    ...params,
  );
  sendJson(res, 200, { cases: rows.map((r) => ({ ...mapCase(r), duration: r.duration })) });
});

route('GET', '/api/cases/:id', async (req, res, { id }) => {
  const caseRow = q.get('SELECT * FROM cases WHERE id = ?', id);
  if (!caseRow) throw new HttpError(404, '案件不存在');
  const recordings = q.all('SELECT * FROM recordings WHERE case_id = ? ORDER BY sort_index ASC, created_at ASC', id);
  const messages = q.all('SELECT * FROM messages WHERE case_id = ? ORDER BY created_at ASC', id);
  const job = q.get("SELECT * FROM jobs WHERE ref_id = ? ORDER BY created_at DESC LIMIT 1", id);
  sendJson(res, 200, {
    case: mapCase(caseRow),
    report: jsonParse(caseRow.report_json, null),
    recordings: recordings.map((r) => ({
      id: r.id,
      filename: r.filename,
      size: r.size,
      format: r.format,
      duration: r.duration,
      recDate: r.rec_date,
      recType: r.rec_type,
      employeeId: r.employee_id,
      status: r.status,
      progress: r.progress,
      error: r.error,
      segmentCount: jsonParse(r.transcript_json, { segments: [] }).segments?.length || 0,
      roleSource: jsonParse(r.transcript_json, {})?.roleSource || null,
      notes: jsonParse(r.transcript_json, {})?.notes || [],
    })),
    messages: messages.map((m) => ({ ...m, citations: jsonParse(m.citations_json, null) })),
    job,
    ai: { llm: isLlmConfigured(), asr: isAsrConfigured() },
  });
});

route('POST', '/api/cases/:id/analyze', async (req, res, { id }) => {
  const caseRow = q.get('SELECT * FROM cases WHERE id = ?', id);
  if (!caseRow) throw new HttpError(404, '案件不存在');
  const result = enqueueCase(id, { reanalyze: true });
  if (!result.queued) throw new HttpError(400, result.reason);
  sendJson(res, 200, { ok: true, jobId: result.jobId });
});

/* 针对单条客户诉求直接做 AI 深度分析，无需重复输入案件背景 */
route('POST', '/api/cases/:id/claims/:claimId/analyze', async (req, res, { id, claimId }) => {
  if (!isLlmConfigured()) throw new HttpError(400, '大模型尚未配置，暂时无法生成深度分析');
  const caseRow = q.get('SELECT * FROM cases WHERE id = ?', id);
  if (!caseRow) throw new HttpError(404, '案件不存在');
  const report = jsonParse(caseRow.report_json, null);
  const claims = Array.isArray(report?.claims) ? report.claims : [];
  const claim = claims.find((c) => c.id === claimId) || claims[Number(claimId)];
  if (!claim) throw new HttpError(404, '未找到该客户诉求');
  const recordings = q.all("SELECT * FROM recordings WHERE case_id = ? AND status = 'transcribed' ORDER BY sort_index ASC", id);
  if (!recordings.length) throw new HttpError(400, '该案件还没有可用的转写内容');

  const deepDive = await deepAnalyzeClaim({ caseRow, recordings, claim });
  claim.deepDive = deepDive;
  report.evidence = collectDeepEvidence(report);
  q.run('UPDATE cases SET report_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(report), nowIso(), id);
  sendJson(res, 200, { claimId: claim.id, deepDive });
});

function collectDeepEvidence(report) {
  const evidence = Array.isArray(report.evidence) ? report.evidence.slice() : [];
  const seen = new Set(evidence.map((e) => `${e.recordingId}-${e.start}-${e.quote}`));
  for (const claim of report.claims || []) {
    for (const point of claim.deepDive?.points || []) {
      for (const ev of point.evidence || []) {
        if (!ev?.verified) continue;
        const key = `${ev.recordingId}-${ev.start}-${ev.quote}`;
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push(ev);
      }
    }
  }
  return evidence;
}

route('DELETE', '/api/cases/:id', async (req, res, { id }) => {
  const recordings = q.all('SELECT * FROM recordings WHERE case_id = ?', id);
  for (const rec of recordings) deleteRecordingFile(rec);
  q.run('DELETE FROM recordings WHERE case_id = ?', id);
  q.run('DELETE FROM messages WHERE case_id = ?', id);
  q.run('DELETE FROM cases WHERE id = ?', id);
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/cases/:id/messages', async (req, res, { id }) => {
  const rows = q.all('SELECT * FROM messages WHERE case_id = ? ORDER BY created_at ASC', id);
  sendJson(res, 200, { messages: rows.map((m) => ({ ...m, citations: jsonParse(m.citations_json, null) })) });
});

route('DELETE', '/api/cases/:id/messages', async (req, res, { id }) => {
  q.run('DELETE FROM messages WHERE case_id = ?', id);
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/cases/:id/chat', async (req, res, { id }) => {
  const caseRow = q.get('SELECT * FROM cases WHERE id = ?', id);
  if (!caseRow) throw new HttpError(404, '案件不存在');
  const body = await readJson(req);
  const question = String(body.question || '').trim();
  if (!question) throw new HttpError(400, '问题不能为空');

  const recordings = q.all("SELECT * FROM recordings WHERE case_id = ? AND status = 'transcribed'", id);
  if (!recordings.length) throw new HttpError(400, '该案件还没有可用的转写内容');

  const sse = serializeSse(res);
  const history = loadConversation(id);
  saveMessage(id, 'user', question);

  try {
    const { answer, citations } = await answerQuestion({
      caseRow,
      recordings,
      question,
      history,
      onMeta: (meta) => sse.send('meta', meta),
      onDelta: (delta) => sse.send('delta', { text: delta }),
    });
    saveMessage(id, 'assistant', answer, citations);
    sse.send('done', { ok: true });
  } catch (err) {
    saveMessage(id, 'assistant', `（回答失败）${err.message}`);
    sse.send('error', { message: err.message });
  } finally {
    sse.end();
  }
});

/* ---------------- 知识库 ---------------- */

route('GET', '/api/kb/docs', async (req, res) => {
  const docs = q.all('SELECT id, name, ext, size, status, error, chunks, created_at FROM kb_docs ORDER BY created_at DESC');
  sendJson(res, 200, { docs, stats: kbStats(), embed: isEmbedConfigured() });
});

route('POST', '/api/kb/docs', async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json')) {
    const body = await readJson(req);
    const name = String(body.name || '').trim() || '粘贴的文本资料.txt';
    const text = String(body.text || '');
    if (text.trim().length < 20) throw new HttpError(400, '文本内容过短');
    const result = await ingestDocument({ name, text, pastedText: text });
    sendJson(res, 200, result);
    return;
  }
  const name = decodeURIComponent(url.searchParams.get('name') || '');
  if (!name) throw new HttpError(400, '缺少文件名');
  const tmpPath = path.join(TMP_DIR, `${uid()}-${path.basename(name)}`);
  const size = await streamToFile(req, tmpPath, { maxBytes: 100 * 1024 * 1024 });
  try {
    const buffer = await fsp.readFile(tmpPath);
    const result = await ingestDocument({ name, buffer, size });
    sendJson(res, 200, result);
  } finally {
    await fsp.rm(tmpPath, { force: true });
  }
});

route('GET', '/api/kb/docs/:id', async (req, res, { id }) => {
  const doc = q.get('SELECT * FROM kb_docs WHERE id = ?', id);
  if (!doc) throw new HttpError(404, '文档不存在');
  const chunks = q.all('SELECT id, idx, title, text FROM kb_chunks WHERE doc_id = ? ORDER BY idx ASC LIMIT 60', id);
  sendJson(res, 200, { doc: { ...doc, text: undefined, textLength: doc.text?.length || 0 }, chunks });
});

route('DELETE', '/api/kb/docs/:id', async (req, res, { id }) => {
  q.run('DELETE FROM kb_chunks WHERE doc_id = ?', id);
  q.run('DELETE FROM kb_docs WHERE id = ?', id);
  invalidateIndex();
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/kb/search', async (req, res) => {
  const body = await readJson(req);
  const query = String(body.query || '').trim();
  if (!query) throw new HttpError(400, '检索内容不能为空');
  const hits = await searchKnowledge(query, Number(body.topK) || 6);
  sendJson(res, 200, { hits });
});

/* ---------------- 设置 ---------------- */

route('GET', '/api/settings', async (req, res) => {
  sendJson(res, 200, {
    settings: publicSettings(),
    status: { llm: isLlmConfigured(), asr: isAsrConfigured(), embed: isEmbedConfigured() },
  });
});

route('PUT', '/api/settings', async (req, res) => {
  const body = await readJson(req);
  saveSettings(body);
  invalidateIndex();
  sendJson(res, 200, { ok: true, status: { llm: isLlmConfigured(), asr: isAsrConfigured(), embed: isEmbedConfigured() } });
});

route('POST', '/api/settings/test', async (req, res) => {
  const body = await readJson(req);
  const kind = String(body.kind || '');
  try {
    if (kind === 'llm') {
      const reply = await testLlm();
      sendJson(res, 200, { ok: true, message: `大模型连接正常，模型回复：${reply}` });
      return;
    }
    if (kind === 'asr') {
      const message = await testAsr();
      sendJson(res, 200, { ok: true, message });
      return;
    }
    throw new HttpError(400, '未知的测试类型');
  } catch (err) {
    sendJson(res, 200, { ok: false, message: err.message });
  }
});

route('GET', '/api/jobs', async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const active = url.searchParams.get('active');
  const rows = active
    ? q.all("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at DESC")
    : q.all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 30');
  sendJson(res, 200, { jobs: rows });
});

/* ---------------- 服务 ---------------- */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.regex.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        await r.handler(req, res, params);
        return;
      }
      sendError(res, 404, '接口不存在');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, '方法不允许');
      return;
    }
    const safePath = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    let filePath = path.join(PUBLIC_DIR, safePath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      sendError(res, 403, '禁止访问');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }
    if (!serveStatic(res, filePath)) sendError(res, 404, '页面不存在');
  } catch (err) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, err);
    sendError(res, status, err.message || '服务器内部错误');
  } finally {
    if (url.pathname.startsWith('/api/') && Date.now() - started > 5000) {
      console.log(`[slow] ${req.method} ${url.pathname} ${Date.now() - started}ms`);
    }
  }
});

recoverInterrupted();
server.listen(PORT, () => {
  console.log(`保险理赔录音智能分析服务已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${path.join(ROOT, 'data')}`);
});
