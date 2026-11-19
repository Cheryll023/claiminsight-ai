import { q, jsonParse, nowIso } from './db.js';
import { parseRecordingName, normalizeCaseCode } from './filename.js';
import { transcribeRecording } from './asr.js';
import { chatJson } from './llm.js';
import { isAsrConfigured, isLlmConfigured } from './config.js';

const GENERIC_DIR =
  /^(新建文件夹|未命名文件夹|录音|音频|录音文件|通话录音|录音资料|理赔|案件|案件资料|资料|工作|微信|桌面|下载|团队|team|users?|output|outputs|dist|tmp)$/i;

/* ================= 第二层：目录结构识别 ================= */

/**
 * 从压缩包内路径提取线索。目录越靠近文件优先级越高。
 * 支持：案件号/工号 显式前缀、CASE/CLM 案件号、纯数字工号、中文姓名目录。
 */
export function parseFolderHints(sourcePath) {
  if (!sourcePath) return null;
  const segs = String(sourcePath).replace(/\\/g, '/').split('/').filter(Boolean);
  segs.pop(); // 去掉文件名本身
  if (!segs.length) return null;

  const out = {
    caseCode: '',
    caseConfidence: '',
    employeeId: '',
    employeeName: '',
    date: '',
    pathLabel: segs.join(' / '),
  };

  for (let i = segs.length - 1; i >= 0; i--) {
    const raw = segs[i].replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
    if (!raw || /^\.+$/.test(raw)) continue;

    const explicitCase = raw.match(/(?:案件号|案件编号|案号|赔案号)[-_：:\s]*([A-Za-z0-9_-]{3,})/i);
    const prefixedCase = raw.match(/(?:^|[^A-Za-z0-9])((?:CASE|CLM|CLAIM|AJ|LB)[-_]?[A-Za-z0-9]{3,})/i);
    const explicitEmp = raw.match(/(?:工号|员工编号|员工号)[-_：:\s]*(\d{3,8})/);

    if (!out.caseCode) {
      if (explicitCase) {
        out.caseCode = normalizeCaseCode(explicitCase[1]);
        out.caseConfidence = 'high';
      } else if (prefixedCase) {
        out.caseCode = normalizeCaseCode(prefixedCase[1]);
        out.caseConfidence = 'high';
      }
    }

    if (!out.employeeId) {
      if (explicitEmp) {
        out.employeeId = explicitEmp[1];
      } else if (!prefixedCase && /^\d{4,6}$/.test(raw)) {
        out.employeeId = raw;
      } else {
        const inline = raw.match(/[\u4e00-\u9fa5]{0,4}[-_ ](\d{5,6})/);
        if (inline) out.employeeId = inline[1];
      }
    }

    if (!out.employeeName && /^[\u4e00-\u9fa5]{2,4}$/.test(raw) && !GENERIC_DIR.test(raw)) {
      out.employeeName = raw;
    }

    if (!out.date) {
      const d = raw.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/);
      if (d) out.date = `${d[1]}-${d[2]}-${d[3]}`;
    }
  }

  if (!out.caseCode && !out.employeeId && !out.employeeName) return null;
  return out;
}

/* ================= 线索合并 ================= */

const CONF_RANK = { high: 3, medium: 2, low: 1, '': 0 };

function lowerConf(a, b) {
  return (CONF_RANK[a] || 0) <= (CONF_RANK[b] || 0) ? a : b;
}

/** 合并文件名 / 目录 / 录音内容 / 人工四层线索，得出最终归属 */
export function resolveRecording(rec) {
  const filename = parseRecordingName(rec.filename || '');
  const folder = parseFolderHints(rec.source_path || '');
  const hints = jsonParse(rec.content_hints, null);
  const warnings = [];
  const candidates = [];

  // 人工指定优先级最高
  if (rec.match_source === 'manual' && rec.match_code) {
    return { code: rec.match_code, source: 'manual', confidence: 'high', candidates: [], warnings, folder, hints, filename };
  }

  let code = '';
  let source = '';
  let confidence = '';

  // 第一层：文件名
  if (filename.caseCode) {
    code = filename.caseCode;
    source = 'filename';
    confidence = 'high';
  }

  // 第二层：目录结构
  if (folder?.caseCode) {
    if (!code) {
      code = folder.caseCode;
      source = 'folder';
      confidence = folder.caseConfidence || 'high';
    } else if (folder.caseCode !== code) {
      confidence = 'low';
      warnings.push(`文件名案件号 ${code} 与目录案件号 ${folder.caseCode} 不一致，请确认`);
      candidates.push({ code: folder.caseCode, reason: '目录名称', score: 60 });
    }
  }

  // 第三层：录音内容（转写后由 LLM/规则提取，已落库）
  if (!code && hints?.caseCode) {
    code = hints.caseCode;
    source = 'content';
    confidence = hints.confidence === 'high' ? 'high' : 'medium';
  } else if (!code && rec.match_code && rec.match_source === 'content') {
    code = rec.match_code;
    source = 'content';
    confidence = rec.match_confidence || 'medium';
  }

  // 历史候选（内容识别未能定论时保留给人工）
  const storedCandidates = jsonParse(rec.match_candidates, []) || [];
  for (const c of storedCandidates) {
    if (!candidates.some((x) => x.code === c.code)) candidates.push(c);
  }

  if (!code) {
    if (filename.warnings?.length) warnings.push(...filename.warnings);
    if (!folder) warnings.push('文件名与目录中均未识别到案件编号');
  }

  return { code, source, confidence, candidates, warnings, folder, hints, filename };
}

/* ================= 分组 ================= */

function unknownSignature(rec, info) {
  const h = info.hints || {};
  if (h.policyNo) return { key: `policy:${h.policyNo}`, label: `保单 ${String(h.policyNo).slice(-4)}` };
  if (h.customerName) return { key: `cust:${h.customerName}`, label: `客户 ${h.customerName}` };
  const emp = info.folder?.employeeId || info.filename.employeeId || h.employeeId || '';
  if (emp) return { key: `emp:${emp}`, label: `工号 ${emp}` };
  if (info.folder?.employeeName) return { key: `empname:${info.folder.employeeName}`, label: info.folder.employeeName };
  return { key: `rec:${rec.id}`, label: '未识别' };
}

export function buildGroups(recordings) {
  const map = new Map();
  const sourceKeys = ['filename', 'folder', 'content', 'manual'];

  for (const rec of recordings) {
    const info = resolveRecording(rec);
    // 低置信度或存在冲突的录音单独隔离，避免影响同组其他已明确的录音
    const confident = Boolean(info.code) && info.confidence !== 'low';
    const sig = confident ? null : unknownSignature(rec, info);
    const key = confident ? `code:${info.code}` : `sig:${sig.key}`;

    if (!map.has(key)) {
      map.set(key, {
        code: confident ? info.code : '',
        signature: sig,
        employeeId: '',
        employeeName: '',
        confidence: confident ? info.confidence || 'high' : 'low',
        sources: Object.fromEntries(sourceKeys.map((s) => [s, 0])),
        warnings: new Set(),
        candidates: [],
        recordings: [],
      });
    }
    const group = map.get(key);

    if (confident) {
      group.confidence = lowerConf(group.confidence, info.confidence || 'high');
    } else if (info.code && !group.candidates.some((c) => c.code === info.code)) {
      group.candidates.unshift({
        code: info.code,
        score: 95,
        reason: info.source === 'folder' ? '目录名称' : '文件名',
      });
    }
    group.sources[info.source || 'filename'] = (group.sources[info.source || 'filename'] || 0) + 1;
    info.warnings.forEach((w) => group.warnings.add(w));
    for (const c of info.candidates) {
      if (!group.candidates.some((x) => x.code === c.code)) group.candidates.push(c);
    }
    if (!group.employeeId) group.employeeId = info.folder?.employeeId || info.filename.employeeId || info.hints?.employeeId || '';
    if (!group.employeeName) group.employeeName = info.folder?.employeeName || '';

    group.recordings.push({
      id: rec.id,
      filename: rec.filename,
      sourcePath: rec.source_path || '',
      folderPath: info.folder?.pathLabel || '',
      size: rec.size,
      duration: rec.duration,
      recDate: rec.rec_date || info.folder?.date || '',
      recType: rec.rec_type,
      status: rec.status,
      error: rec.error || '',
      caseId: rec.case_id || null,
      matchSource: info.source || '',
      matchConfidence: info.confidence || '',
      needsReview: !info.code || info.confidence === 'low',
      hints: info.hints
        ? {
            caseCode: info.hints.caseCode || '',
            policyNo: info.hints.policyNo || '',
            customerName: info.hints.customerName || '',
            customerDemand: info.hints.customerDemand || '',
            accidentSummary: info.hints.accidentSummary || '',
            keywords: info.hints.keywords || [],
          }
        : null,
    });
  }

  const groups = [...map.values()].map((g) => {
    const needsReview = !g.code || g.confidence === 'low' || g.recordings.some((r) => r.needsReview);
    return {
      code: g.code || `待确认-${g.signature?.label || '未识别'}`,
      autoCode: g.code || '',
      employeeId: g.employeeId || '',
      employeeName: g.employeeName || '',
      needsReview,
      confidence: needsReview ? 'low' : g.confidence,
      sources: g.sources,
      warnings: [...g.warnings],
      candidates: g.candidates.slice(0, 4),
      recordings: g.recordings.sort(
        (a, b) =>
          String(a.recDate || '').localeCompare(String(b.recDate || '')) ||
          String(a.filename).localeCompare(String(b.filename)),
      ),
    };
  });

  groups.sort((a, b) => {
    if (Boolean(a.autoCode) !== Boolean(b.autoCode)) return a.autoCode ? -1 : 1;
    return String(a.code).localeCompare(String(b.code));
  });
  return groups;
}

export function summarizeGroups(groups) {
  const recordings = groups.reduce((s, g) => s + g.recordings.length, 0);
  const pending = groups.filter((g) => g.needsReview).reduce((s, g) => s + g.recordings.length, 0);
  const sources = { filename: 0, folder: 0, content: 0, manual: 0 };
  for (const g of groups) {
    for (const [k, v] of Object.entries(g.sources)) sources[k] = (sources[k] || 0) + v;
  }
  return {
    groups: groups.length,
    resolvedGroups: groups.filter((g) => !g.needsReview).length,
    recordings,
    pending,
    sources,
  };
}

/* ================= 第三层：录音内容识别 ================= */

function transcriptText(rec) {
  const t = jsonParse(rec.transcript_json, null);
  const segs = Array.isArray(t?.segments) ? t.segments : [];
  return segs.map((s) => s.text).join('').replace(/\s+/g, '');
}

function regexHints(text) {
  const out = { caseCode: '', policyNo: '', employeeId: '', confidence: 'low', keywords: [] };
  const caseM = text.match(/(?:案件号|案件编号|案号|赔案号|理赔案号)[^A-Za-z0-9]{0,6}([A-Za-z0-9_-]{4,24})/);
  if (caseM) {
    out.caseCode = normalizeCaseCode(caseM[1]);
    out.confidence = 'high';
  }
  const policyM = text.match(/(?:保单号|保单编号)[^0-9A-Za-z]{0,6}([0-9A-Za-z-]{6,30})/);
  if (policyM) out.policyNo = policyM[1];
  const empM = text.match(/(?:工号|员工编号)[^0-9]{0,4}(\d{3,8})/);
  if (empM) out.employeeId = empM[1];
  return out;
}

export async function extractHints(text) {
  const base = regexHints(text);
  if (!isLlmConfigured() || !text) return base;
  const sample = text.length > 6000 ? `${text.slice(0, 3000)}……${text.slice(-3000)}` : text;
  try {
    const llm = await chatJson(
      [
        {
          role: 'system',
          content:
            '你是保险理赔录音归类助手。请从通话转写文本中提取可用于「案件归属识别」的结构化信息。只输出 JSON，不要解释。识别不到时用空字符串。',
        },
        {
          role: 'user',
          content: `通话转写：\n${sample}\n\n输出格式：{"caseCode":"案件号/案号","policyNo":"保单号","employeeId":"理赔专员工号","customerName":"客户姓名","customerDemand":"客户核心诉求","accidentDate":"事故/报案日期 YYYY-MM-DD","accidentSummary":"事故经过一句话","keywords":["可用于区分案件的 2-5 个关键词"],"confidence":"high|medium|low"}`,
        },
      ],
      { temperature: 0 },
    );
    const merged = {
      caseCode: base.caseCode || normalizeCaseCode(llm.caseCode || ''),
      policyNo: base.policyNo || String(llm.policyNo || '').trim(),
      employeeId: base.employeeId || String(llm.employeeId || '').trim(),
      customerName: String(llm.customerName || '').trim(),
      customerDemand: String(llm.customerDemand || '').trim(),
      accidentDate: String(llm.accidentDate || '').trim(),
      accidentSummary: String(llm.accidentSummary || '').trim(),
      keywords: Array.isArray(llm.keywords) ? llm.keywords.map(String).filter(Boolean).slice(0, 5) : [],
      confidence: base.caseCode ? 'high' : String(llm.confidence || 'low').toLowerCase(),
    };
    return merged;
  } catch {
    return base;
  }
}

/* ================= 候选匹配 ================= */

function scoreCandidates(rec, info, knownGroups) {
  const emp = info.folder?.employeeId || info.filename.employeeId || info.hints?.employeeId || '';
  const dates = new Set([info.filename.date, info.folder?.date].filter(Boolean));
  const scored = [];
  for (const g of knownGroups) {
    let score = 0;
    const reasons = [];
    if (emp && g.employeeId && emp === g.employeeId) {
      score += 50;
      reasons.push('工号一致');
    }
    if (reasonOverlap(info.hints?.keywords, g.keywords)) {
      score += 20;
      reasons.push('内容关键词相近');
    }
    if (dates.size && g.dates.some((d) => [...dates].some((x) => Math.abs(dateDiff(x, d)) <= 3))) {
      score += 15;
      reasons.push('日期接近');
    }
    if (score > 0) scored.push({ code: g.code, score, reason: reasons.join('、') });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 4);
}

function reasonOverlap(a = [], b = []) {
  if (!a.length || !b.length) return false;
  return a.some((x) => b.some((y) => x.includes(y) || y.includes(x)));
}

function dateDiff(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 999;
  return (ta - tb) / 86400000;
}

function knownGroupIndex(recordings) {
  const map = new Map();
  for (const rec of recordings) {
    const info = resolveRecording(rec);
    if (!info.code) continue;
    if (!map.has(info.code)) {
      map.set(info.code, {
        code: info.code,
        employeeId: info.folder?.employeeId || info.filename.employeeId || info.hints?.employeeId || '',
        keywords: [],
        dates: [],
      });
    }
    const g = map.get(info.code);
    if (!g.employeeId) {
      g.employeeId = info.folder?.employeeId || info.filename.employeeId || info.hints?.employeeId || '';
    }
    const d = rec.rec_date || info.filename.date || info.folder?.date;
    if (d) g.dates.push(d);
    if (info.hints?.keywords) g.keywords.push(...info.hints.keywords);
  }
  return [...map.values()];
}

/* ================= 编排 ================= */

const activeBatches = new Set();

export function isClassifying(batchId) {
  return activeBatches.has(batchId);
}

function setBatch(batchId, status, message) {
  q.run('UPDATE batches SET classify_status = ?, classify_message = ?, classify_at = ? WHERE id = ?', status, message, nowIso(), batchId);
}

function persist(rec, info) {
  q.run(
    'UPDATE recordings SET match_code = ?, match_source = ?, match_confidence = ?, match_candidates = ?, needs_review = ? WHERE id = ?',
    info.code || null,
    info.code ? info.source : null,
    info.code ? info.confidence : null,
    info.candidates?.length ? JSON.stringify(info.candidates) : null,
    !info.code || info.confidence === 'low' ? 1 : 0,
    rec.id,
  );
}

function loadRecordings(batchId) {
  return q.all('SELECT * FROM recordings WHERE batch_id = ? ORDER BY sort_index ASC, created_at ASC', batchId);
}

async function pool(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx], idx).catch(() => {});
    }
  });
  await Promise.all(workers);
}

/** 仅执行文件名 + 目录结构识别（同步，不触发语音转写） */
export function classifySync(batchId) {
  const recordings = loadRecordings(batchId);
  for (const rec of recordings) persist(rec, resolveRecording(rec));
  const groups = buildGroups(loadRecordings(batchId));
  return { groups, summary: summarizeGroups(groups) };
}

/**
 * 启动分层识别：文件名与目录结构立即完成，无法确定归属的录音再走语音转写 + 内容提取。
 * 识别过程异步执行，前端轮询批次状态。
 */
export function startClassification(batchId, { reset = false } = {}) {
  if (activeBatches.has(batchId)) return { started: false, reason: '识别进行中' };
  const batch = q.get('SELECT id FROM batches WHERE id = ?', batchId);
  if (!batch) return { started: false, reason: '批次不存在' };
  if (reset) {
    q.run("UPDATE recordings SET match_code = NULL, match_source = NULL, match_confidence = NULL, match_candidates = NULL, content_hints = NULL, needs_review = 1 WHERE batch_id = ? AND (match_source IS NULL OR match_source != 'manual')", batchId);
  }
  activeBatches.add(batchId);
  setBatch(batchId, 'running', '正在解析文件名与目录结构');
  runClassification(batchId)
    .catch((err) => {
      console.error('[classify]', err);
      setBatch(batchId, 'failed', `识别失败：${err.message}`);
    })
    .finally(() => activeBatches.delete(batchId));
  return { started: true };
}

async function runClassification(batchId) {
  // 第一层 + 第二层：文件名与目录结构
  let recordings = loadRecordings(batchId);
  for (const rec of recordings) {
    persist(rec, resolveRecording(rec));
  }

  // 第三层：录音内容识别（仅针对仍未确定归属的录音）
  let pending = loadRecordings(batchId).filter((r) => !resolveRecording(r).code);
  const canContent = pending.length > 0 && isAsrConfigured() && isLlmConfigured();
  if (canContent) {
    setBatch(batchId, 'running', `文件名与目录未能确定 ${pending.length} 段录音，正在通过录音内容识别`);
    let done = 0;
    await pool(pending, 2, async (rec) => {
      const before = done;
      done = before + 1;
      setBatch(batchId, 'running', `通过录音内容识别 ${done}/${pending.length}：${rec.filename}`);
      try {
        if (rec.status !== 'transcribed' || !rec.transcript_json) {
          q.run("UPDATE recordings SET status = 'transcribing', progress = 0, error = NULL WHERE id = ?", rec.id);
          const result = await transcribeRecording(rec, () => {});
          q.run(
            "UPDATE recordings SET status = 'transcribed', progress = 100, duration = ?, transcript_json = ?, speaker_map_json = ?, error = NULL WHERE id = ?",
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
          rec.transcript_json = '1';
        }
        const text = transcriptText(loadRecordings(batchId).find((r) => r.id === rec.id) || rec);
        const hints = await extractHints(text);
        q.run(
          'UPDATE recordings SET content_hints = ?, rec_date = COALESCE(rec_date, ?) WHERE id = ?',
          JSON.stringify(hints),
          hints.accidentDate || null,
          rec.id,
        );
        const fresh = q.get('SELECT * FROM recordings WHERE id = ?', rec.id);
        const info = resolveRecording({ ...fresh, content_hints: JSON.stringify(hints) });
        if (info.code) {
          persist(fresh, info);
          return;
        }
        const candidates = scoreCandidates(fresh, { ...info, hints }, knownGroupIndex(loadRecordings(batchId)));
        const strong = candidates[0] && candidates[0].score >= 90 ? candidates[0] : null;
        if (strong) {
          persist(fresh, { ...info, code: strong.code, source: 'content', confidence: 'medium', candidates: [] });
        } else {
          persist(fresh, { ...info, candidates });
        }
      } catch (err) {
        q.run("UPDATE recordings SET error = ?, status = CASE WHEN status = 'transcribing' THEN 'failed' ELSE status END WHERE id = ?", `内容识别失败：${err.message}`, rec.id);
      }
    });
  }

  // 汇总
  recordings = loadRecordings(batchId);
  const groups = buildGroups(recordings);
  const summary = summarizeGroups(groups);
  let message;
  if (!canContent && pending.length) {
    message = `已按文件名与目录识别 ${summary.groups} 组，${summary.pending} 段录音需确认（未配置语音或大模型，未做内容识别）`;
  } else if (summary.pending) {
    message = `自动识别 ${summary.groups - groups.filter((g) => g.needsReview).length} 个案件，${summary.pending} 段录音需确认`;
  } else {
    message = `已自动识别 ${summary.groups} 个案件，全部录音归属明确`;
  }
  setBatch(batchId, 'done', message);
}
