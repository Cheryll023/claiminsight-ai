import { q, jsonParse, nowIso, uid } from './db.js';
import { transcribeRecording } from './asr.js';
import { analyzeCase, saveReport } from './analysis.js';
import { isLlmConfigured } from './config.js';

const queue = [];
const activeCases = new Set();
let running = 0;
const CONCURRENCY = 2;

function createJob(caseRow) {
  const id = uid();
  q.run(
    'INSERT INTO jobs(id, type, ref_id, label, status, progress, message, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    id,
    'case',
    caseRow.id,
    `案件 ${caseRow.code}`,
    'queued',
    0,
    '排队中',
    nowIso(),
    nowIso(),
  );
  return id;
}

function updateJob(id, patch) {
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${key} = ?`);
    params.push(value);
  }
  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  q.run(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, ...params);
}

export function enqueueCase(caseId, { reanalyze = false } = {}) {
  const caseRow = q.get('SELECT * FROM cases WHERE id = ?', caseId);
  if (!caseRow) throw new Error('案件不存在');
  if (activeCases.has(caseId)) return { queued: false, reason: '该案件正在处理中' };
  if (!isLlmConfigured()) return { queued: false, reason: '尚未配置大模型服务' };

  const jobId = createJob(caseRow);
  q.run('UPDATE cases SET status = ?, updated_at = ? WHERE id = ?', 'queued', nowIso(), caseId);
  queue.push({ caseId, jobId, reanalyze });
  activeCases.add(caseId);
  pump();
  return { queued: true, jobId };
}

export function requeueCase(caseId) {
  return enqueueCase(caseId, { reanalyze: true });
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const task = queue.shift();
    running++;
    execute(task)
      .catch((err) => {
        console.error('[pipeline]', err);
      })
      .finally(() => {
        running--;
        activeCases.delete(task.caseId);
        pump();
      });
  }
}

async function execute({ caseId, jobId }) {
  const caseRow = q.get('SELECT * FROM cases WHERE id = ?', caseId);
  if (!caseRow) return;
  updateJob(jobId, { status: 'running', progress: 2, message: '开始处理' });
  q.run('UPDATE cases SET status = ?, analysis_error = NULL, updated_at = ? WHERE id = ?', 'processing', nowIso(), caseId);

  const recordings = q.all(
    'SELECT * FROM recordings WHERE case_id = ? ORDER BY sort_index ASC, created_at ASC',
    caseId,
  );
  if (!recordings.length) {
    failCase(caseId, jobId, '该案件下没有录音');
    return;
  }

  const total = recordings.length;
  let done = 0;
  let failedCount = recordings.filter((r) => r.status === 'failed').length;

  for (const rec of recordings) {
    if (rec.status === 'transcribed' && rec.transcript_json) {
      done++;
      continue;
    }
    q.run('UPDATE recordings SET status = ?, progress = 0, error = NULL WHERE id = ?', 'transcribing', rec.id);
    const label = `${done + 1}/${total} ${rec.filename}`;
    updateJob(jobId, { progress: 5 + Math.round((done / total) * 60), message: `转写 ${label}` });
    try {
      const result = await transcribeRecording(rec, (p, message) => {
        q.run('UPDATE recordings SET progress = ? WHERE id = ?', p, rec.id);
        updateJob(jobId, {
          progress: 5 + Math.round(((done + p / 100) / total) * 60),
          message: `${label} · ${message || '转写中'}`,
        });
      });
      q.run(
        'UPDATE recordings SET status = ?, progress = 100, duration = ?, transcript_json = ?, speaker_map_json = ?, error = NULL WHERE id = ?',
        'transcribed',
        result.duration,
        JSON.stringify({
          segments: result.segments,
          model: result.model,
          diarized: result.diarized,
          roleSource: result.roleSource,
          notes: result.notes,
        }),
        JSON.stringify({ roleSource: result.roleSource }),
        rec.id,
      );
      rec.status = 'transcribed';
      rec.transcript_json = 'x';
      done++;
    } catch (err) {
      failedCount++;
      q.run('UPDATE recordings SET status = ?, error = ?, progress = 0 WHERE id = ?', 'failed', err.message, rec.id);
      updateJob(jobId, { message: `${rec.filename} 转写失败：${err.message}` });
      done++;
    }
  }

  const transcripts = q.all(
    "SELECT * FROM recordings WHERE case_id = ? AND status = 'transcribed' AND transcript_json IS NOT NULL ORDER BY sort_index ASC, created_at ASC",
    caseId,
  );
  if (!transcripts.length) {
    failCase(caseId, jobId, `全部录音转写失败（${failedCount} 个），请检查语音服务配置后重试`);
    return;
  }

  updateJob(jobId, { progress: 70, message: '正在生成案件分析报告' });
  try {
    const report = await analyzeCase(caseRow, transcripts, (p, message) => {
      updateJob(jobId, { progress: 70 + Math.round(p * 0.28), message });
    });
    report.meta.failedRecordings = failedCount;
    saveReport(caseId, report);
    updateJob(jobId, { status: 'done', progress: 100, message: '分析完成' });
  } catch (err) {
    q.run(
      'UPDATE cases SET status = ?, analysis_error = ?, updated_at = ? WHERE id = ?',
      'failed',
      err.message,
      nowIso(),
      caseId,
    );
    updateJob(jobId, { status: 'failed', progress: 100, message: `分析失败：${err.message}` });
  }
}

function failCase(caseId, jobId, message) {
  q.run('UPDATE cases SET status = ?, analysis_error = ?, updated_at = ? WHERE id = ?', 'failed', message, nowIso(), caseId);
  updateJob(jobId, { status: 'failed', progress: 100, message });
}

export function recoverInterrupted() {
  q.run("UPDATE recordings SET status = 'uploaded', progress = 0 WHERE status = 'transcribing'");
  q.run("UPDATE cases SET status = 'failed', analysis_error = '上次处理被中断（服务重启），请重新处理' WHERE status IN ('processing','queued')");
  q.run("UPDATE jobs SET status = 'failed', message = '服务重启导致中断' WHERE status IN ('queued','running')");
}

export function queueStats() {
  return { active: activeCases.size, queued: queue.length };
}
