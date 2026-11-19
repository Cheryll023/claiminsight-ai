import { q, jsonParse, nowIso } from './db.js';
import { chatJson } from './llm.js';
import { formatDuration } from './filename.js';
import { searchKnowledge } from './kb.js';

export const REPORT_SCHEMA_HINT = `{
  "summary": {
    "overview": "案件整体摘要（3-6句，综合全部录音：谁、发生了什么、客户要什么、目前处理到哪一步）",
    "background": "案件背景（1-2句）",
    "customerSituation": "客户处境与核心关切（1-2句）",
    "mainClaim": "最核心的一条客户诉求（一句话）",
    "handlingStatus": "当前处理进展；录音未提及写「无法判断」",
    "emotionTrend": "客户情绪总体走向（文字描述，例如：由焦虑转为不满，因专员承诺复核有所缓和）",
    "escalationSummary": "投诉升级信号概述；未发现写「未发现明显升级信号」"
  },
  "claims": [
    {
      "id": "C1",
      "title": "一句话概括该诉求（如：对定损金额有异议，要求重新核定）",
      "type": "理赔咨询|进度催办|赔付异议|客户投诉|争议协商|材料补充|其他",
      "priority": "high|medium|low",
      "status": "已明确回应|部分回应|未回应|待核实",
      "raisedAt": "首次提出的录音与时间，如「录音1 02:12」",
      "demand": "客户具体希望得到什么（完整表述）",
      "context": "该诉求产生的背景与情境",
      "evidence": [{"recording": "录音1", "quote": "客户原话逐字摘录，10-40字"}],
      "response": {
        "summary": "工作人员针对该诉求做了什么、怎么解释的（2-3句）",
        "clarity": "充分|部分充分|不充分|未回应",
        "evaluation": "对该回应的客观评价，一句话",
        "measures": [{"text": "已采取的处理措施", "evidence": []}],
        "promises": [{"text": "工作人员明确承诺", "due": "承诺时限；未明确写「未明确」", "evidence": []}]
      },
      "dispute": {
        "dissatisfaction": "客户不满的具体原因（若无不满写「无明显不满」）",
        "focus": "争议焦点（双方分歧所在）",
        "triggers": [{"text": "触发不满的具体事件或话题", "evidence": []}],
        "repeated": [{"text": "客户反复追问的问题", "evidence": []}],
        "escalation": [{"level": "关注|预警|紧急", "text": "投诉升级信号（如要求投诉、提及监管、威胁起诉、情绪激烈）", "evidence": []}],
        "customerView": "客户表达的主张或不满（明确标注为客户陈述）",
        "confirmedFacts": [{"text": "录音中能够确认的客观事实", "evidence": []}],
        "unverified": [{"text": "仍需进一步核实的实际业务原因", "reason": "为什么需要核实"}]
      },
      "emotion": {
        "labels": ["焦虑", "不满"],
        "narrative": "客户在什么话题上产生什么情绪，工作人员如何回应、情绪是否缓和（可解释的文字分析）",
        "quotes": [{"text": "能体现情绪的原话", "evidence": []}]
      },
      "outcome": {
        "status": "已明确回应|部分回应|未回应|待核实",
        "text": "这条诉求目前的沟通结果（客户是否接受、下一步等什么）",
        "evidence": []
      },
      "pending": [{"text": "该诉求下尚未获得明确答复、需要业务人员核实的事项", "reason": "原因"}],
      "history": [{"recording": "录音1", "date": "2026-11-15", "note": "该诉求在该段录音中的变化（首次提出/再次追问/接受方案等）", "evidence": []}],
      "aiAdvice": {
        "actions": [{"text": "可执行的处理建议", "priority": "高|中|低", "basis": "依据来源：知识库文档名 / 录音事实；无依据时写「无知识库依据」"}],
        "basis": [{"docName": "引用的知识库文档名", "text": "适用依据摘要"}],
        "missingBasis": "缺少知识库依据时明确说明；有依据写「」"
      }
    }
  ],
  "communicationFlow": [
    {"date": "2026-11-15", "recording": "录音1", "stage": "首次联系|补充材料|方案沟通|投诉处理", "customer": "客户主要表达", "agent": "工作人员主要回应", "result": "本次沟通结果", "claimIds": ["C1"]}
  ],
  "crossRecording": {
    "repeated": [{"text": "同一案件多段录音中重复出现的问题", "refs": ["录音1", "录音3"], "evidence": []}],
    "commitments": [{"text": "历史承诺", "madeIn": "录音1", "status": "已兑现|未兑现|无法判断", "evidence": []}],
    "changes": ["客户诉求或沟通口径发生的变化"]
  },
  "riskSignals": [{"type": "投诉升级|信息矛盾|解释不充分|不当承诺|流程时效", "level": "关注|预警|紧急", "text": "风险信号描述（仅提示关注，不等同业务违规）", "claimId": "C1", "evidence": []}],
  "recommendations": {
    "verification": [{"text": "需要业务人员进一步核实的问题"}],
    "materials": [{"text": "需要补充的材料", "reason": "用途"}],
    "nextActions": [{"text": "下一步行动建议", "priority": "高|中|低"}]
  },
  "uncertainties": ["录音中无法确认、需要人工跟进的事项"]
}`;

const ANALYSIS_SYSTEM = `你是资深保险理赔业务分析专家，负责对理赔专员与客户的通话录音做案件级综合分析，输出可供理赔人员和业务团队使用的分析报告。

必须遵守：
1. 以「客户诉求」为核心组织全部分析。一段录音可能包含多个诉求，必须逐个提取，不能只输出一个意图标签；每个诉求都要关联工作人员的回应、争议与情绪、沟通结果、待核实事项和个人建议。
2. 严格区分三类信息：客户表达的不满（客户陈述）、录音中能够确认的事实、仍需核实的业务原因。不得把风险信号直接判定为业务违规，也不得把客户主张写成已认定事实。
3. 每条关键结论尽量给出 evidence，quote 必须是通话原文的逐字摘录（10-40字），recording 使用给定的录音编号（如「录音1」）。
4. 录音中没有提到的内容，写「无法判断」或放入 uncertainties，绝不编造案件事实、金额、日期、条款编号、公司制度或赔付结论。
5. 同一案件的多段录音要综合分析：同一诉求合并为一个 claims 条目，并在 history 中记录其在各段录音中的变化；注意客户重复提出的问题、历史承诺是否兑现、沟通口径是否变化。
6. 情绪分析采用可解释的文字描述，重点说明客户在什么话题上产生不满、工作人员如何回应，不做打分或评级。
7. AI 建议要可执行。涉及业务规则、条款、赔付标准的判断，只能引用【企业知识库】中的内容并写明文档名；知识库没有依据时，必须在 missingBasis 中说明「知识库中未找到相关规定」，不得编造公司制度。
8. 不做员工绩效打分、评级或排名；建议只针对具体业务问题，就事论事。
9. 语言简洁、专业、可执行，面向理赔人员和业务团队阅读。
10. 只输出合法 JSON，不要输出 Markdown 或解释。`;

const KB_QUERY = '理赔 定损 免赔 条款 投诉处理 沟通规范 三者险 车损险 赔付标准';

function recordingLabel(index) {
  return `录音${index + 1}`;
}

export function buildTranscriptText(recordings) {
  const parts = [];
  recordings.forEach((rec, index) => {
    const transcript = jsonParse(rec.transcript_json, { segments: [] });
    const head = [
      `【${recordingLabel(index)}】${rec.rec_type || '沟通录音'}｜${rec.rec_date || '日期未知'}｜时长 ${formatDuration(rec.duration) || '未知'}｜文件 ${rec.filename}`,
    ].join('');
    const lines = (transcript.segments || []).map((seg) => {
      const role = seg.role === 'agent' ? '理赔专员' : seg.role === 'customer' ? '客户' : '未知说话人';
      return `[${formatDuration(seg.start)}] ${role}：${seg.text}`;
    });
    parts.push([head, ...lines].join('\n'));
  });
  return parts.join('\n\n');
}

function caseMeta(caseRow, recordings) {
  const dates = recordings.map((r) => r.rec_date).filter(Boolean).sort();
  const totalDuration = recordings.reduce((s, r) => s + (r.duration || 0), 0);
  return {
    code: caseRow.code,
    employeeId: caseRow.employee_id || '',
    recordingCount: recordings.length,
    dateRange: dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : '未知',
    totalDuration,
    files: recordings.map((r, i) => ({ label: recordingLabel(i), filename: r.filename, type: r.rec_type || '', date: r.rec_date || '' })),
  };
}

async function extractPerRecording(rec, index, meta) {
  const transcript = jsonParse(rec.transcript_json, { segments: [] });
  const text = (transcript.segments || [])
    .map((s) => {
      const role = s.role === 'agent' ? '理赔专员' : s.role === 'customer' ? '客户' : '未知';
      return `[${formatDuration(s.start)}] ${role}：${s.text}`;
    })
    .join('\n')
    .slice(0, 24000);
  const result = await chatJson(
    [
      { role: 'system', content: ANALYSIS_SYSTEM },
      {
        role: 'user',
        content: `案件编号：${meta.code}
当前处理录音：${recordingLabel(index)}（${rec.rec_type || '类型未知'}，${rec.rec_date || '日期未知'}）

请只针对这段录音做信息抽取，按客户诉求组织，输出 JSON：
{
  "claims": [{"title": "诉求概括", "type": "理赔咨询|进度催办|赔付异议|客户投诉|争议协商|材料补充|其他", "demand": "客户诉求", "trigger": "触发情境", "customerQuote": "客户原话摘录", "agentResponse": "工作人员回应", "promises": ["明确承诺"], "outcome": "本次沟通结果"}],
  "emotion": {"narrative": "客户情绪变化及触发话题", "quotes": ["体现情绪的原话"]},
  "dissatisfactions": ["客户不满点"],
  "confirmedFacts": ["录音中可确认的事实"],
  "unverified": ["仍需核实的业务原因"],
  "escalation": ["投诉升级信号"],
  "quotes": [{"quote": "原文逐字摘录（10-40字）", "context": "该句的意义"}]
}

录音原文：
${text}`,
      },
    ],
    { temperature: 0.1, maxTokens: 3000 },
  );
  return { label: recordingLabel(index), extraction: result };
}

function stripEmpty(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const arr = value.map(stripEmpty).filter((v) => v !== null && v !== '' && !(Array.isArray(v) && !v.length));
    return arr.length ? arr : [];
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = stripEmpty(v);
      if (cleaned !== null && !(Array.isArray(cleaned) && !cleaned.length)) out[k] = cleaned;
    }
    return Object.keys(out).length ? out : null;
  }
  return value;
}

function bigrams(text) {
  const clean = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

function overlapScore(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / Math.max(a.size, b.size);
}

/**
 * 将 AI 给出的引用与真实转写文本对齐，避免出现编造的"原文"。
 */
export function validateEvidence(report, recordings) {
  const segIndex = recordings.map((rec, i) => {
    const t = jsonParse(rec.transcript_json, { segments: [] });
    return {
      label: recordingLabel(i),
      recId: rec.id,
      recording: rec,
      segments: (t.segments || []).map((s) => ({ ...s, grams: bigrams(s.text) })),
    };
  });
  let total = 0;
  let verified = 0;
  const seen = new WeakSet();

  const visit = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (Array.isArray(node.evidence)) {
      for (const ev of node.evidence) {
        if (!ev || typeof ev !== 'object') continue;
        total++;
        const quote = String(ev.quote || '').trim();
        if (!quote) {
          ev.verified = false;
          continue;
        }
        const target =
          segIndex.find((s) => s.label === ev.recording || s.recording.filename === ev.recording) ||
          (segIndex.length === 1 ? segIndex[0] : null);
        const pools = target ? [target] : segIndex;
        let best = null;
        const qGrams = bigrams(quote);
        for (const pool of pools) {
          for (const seg of pool.segments) {
            const score = overlapScore(qGrams, seg.grams) + (seg.text.includes(quote) ? 0.5 : 0);
            if (!best || score > best.score) best = { score, seg, pool };
          }
        }
        if (best && best.score >= 0.34) {
          ev.verified = true;
          ev.recordingId = best.pool.recId;
          ev.recording = best.pool.label;
          ev.segmentIdx = best.seg.idx;
          ev.start = best.seg.start;
          ev.end = best.seg.end;
          ev.time = formatDuration(best.seg.start);
          ev.quote = quote;
          verified++;
        } else {
          ev.verified = false;
        }
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value);
    }
  };
  visit(report);
  return { total, verified };
}

function collectEvidence(report) {
  const list = [];
  const seen = new WeakSet();
  const visit = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (Array.isArray(node.evidence)) {
      for (const ev of node.evidence) {
        if (ev?.verified) list.push({ ...ev });
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value);
    }
  };
  visit(report);
  return list;
}

export async function analyzeCase(caseRow, recordings, onProgress = () => {}) {
  const meta = caseMeta(caseRow, recordings);
  const transcriptText = buildTranscriptText(recordings);
  const warnings = [];

  if (!transcriptText || transcriptText.length < 50) {
    throw new Error('该案件暂无可用转写内容，无法生成分析报告');
  }

  const kbHits = await searchKnowledge(KB_QUERY, 6).catch(() => []);
  const kbBlock = kbHits.length
    ? kbHits.map((h) => `【知识库：${h.docName}】\n${h.text}`).join('\n\n')
    : '（知识库中未检索到相关内容）';

  let report;
  if (transcriptText.length <= 42000) {
    onProgress(20, '正在综合分析案件录音');
    report = await chatJson(
      [
        { role: 'system', content: ANALYSIS_SYSTEM },
        {
          role: 'user',
          content: `案件基本信息：
- 案件编号：${meta.code}
- 理赔专员工号：${meta.employeeId || '未知'}
- 录音数量：${meta.recordingCount}
- 录音日期范围：${meta.dateRange}

【企业知识库参考（涉及业务规则、条款、赔付标准时只能引用以下内容）】
${kbBlock}

请综合以下全部录音，生成以客户诉求为核心的分析报告，严格按 JSON 结构输出：
${REPORT_SCHEMA_HINT}

录音转写全文：
${transcriptText}`,
        },
      ],
      { temperature: 0.15, maxTokens: 8000 },
    );
  } else {
    const extractions = [];
    for (let i = 0; i < recordings.length; i++) {
      onProgress(10 + Math.round((i / recordings.length) * 55), `正在抽取第 ${i + 1}/${recordings.length} 段录音要点`);
      try {
        extractions.push(await extractPerRecording(recordings[i], i, meta));
      } catch (err) {
        warnings.push(`${recordingLabel(i)} 要点抽取失败：${err.message}`);
      }
    }
    if (!extractions.length) throw new Error('录音要点抽取全部失败，请检查模型配置');
    onProgress(72, '正在综合各段录音生成案件报告');
    report = await chatJson(
      [
        { role: 'system', content: ANALYSIS_SYSTEM },
        {
          role: 'user',
          content: `案件基本信息：
- 案件编号：${meta.code}
- 理赔专员工号：${meta.employeeId || '未知'}
- 录音数量：${meta.recordingCount}
- 录音日期范围：${meta.dateRange}
- 录音清单：${JSON.stringify(meta.files)}

【企业知识库参考（涉及业务规则、条款、赔付标准时只能引用以下内容）】
${kbBlock}

下面是各段录音按客户诉求组织的结构化抽取结果（未包含完整原文，但 quote 字段为原文摘录）。请合并同一诉求、综合全部录音，生成一份统一的案件报告，严格按 JSON 结构输出：
${REPORT_SCHEMA_HINT}

各段录音抽取结果：
${JSON.stringify(extractions, null, 1).slice(0, 60000)}`,
        },
      ],
      { temperature: 0.15, maxTokens: 8000 },
    );
  }

  report = normalizeReport(stripEmpty(report) || {});
  enforceKnowledgeBasis(report, kbHits);
  const validation = validateEvidence(report, recordings);
  const coverage = {
    recordings: recordings.length,
    failed: warnings.length,
    transcriptChars: transcriptText.length,
    quotes: validation,
  };

  const full = {
    meta: {
      ...meta,
      generatedAt: nowIso(),
      analysisMode: transcriptText.length <= 42000 ? 'full' : 'map-reduce',
      transcriptChars: transcriptText.length,
      quotes: validation,
      warnings,
      claimCount: report.claims.length,
    },
    ...report,
    evidence: collectEvidence(report),
  };

  if (!full.summary && !full.claims.length) {
    throw new Error('模型未返回有效的报告结构，请更换模型后重试');
  }
  return full;
}

/**
 * 校验 AI 建议中的知识库依据：模型引用了知识库中不存在的文档时移除并提示，
 * 避免编造公司制度或赔付依据。
 */
function enforceKnowledgeBasis(report, kbHits) {
  const allowed = (kbHits || []).map((h) => h.docName);
  for (const claim of report.claims) {
    const advice = claim.aiAdvice || (claim.aiAdvice = {});
    const removed = [];
    const kept = [];
    for (const item of advice.basis || []) {
      if (item?.docName && allowed.includes(item.docName)) kept.push(item);
      else if (item?.docName) removed.push(item.docName);
    }
    advice.basis = kept;
    for (const action of advice.actions || []) {
      const match = String(action.basis || '').match(/知识库[:：]\s*(.+)/);
      if (!match) continue;
      const doc = match[1].trim();
      const ok = allowed.some((name) => doc.includes(name) || name.includes(doc));
      if (!ok) action.basis = '缺少知识库依据，需人工核实';
    }
    const notes = [];
    if (removed.length) notes.push(`模型引用了知识库中不存在的文档（${removed.join('、')}），已移除，请人工核实依据。`);
    if (!kept.length) notes.push('知识库中未找到与该诉求直接相关的规定。');
    if (notes.length) advice.missingBasis = [advice.missingBasis, ...notes].filter(Boolean).join('；');
  }
}

/**
 * 兜底修正模型输出：保证 claims 是数组、有稳定 id，并补齐常用字段。
 */
function normalizeReport(report) {
  const claims = Array.isArray(report.claims) ? report.claims : [];
  report.claims = claims
    .filter((c) => c && typeof c === 'object')
    .map((c, i) => {
      const claim = { ...c };
      claim.id = claim.id || `C${i + 1}`;
      claim.title = claim.title || claim.demand || `客户诉求 ${i + 1}`;
      claim.type = claim.type || '其他';
      claim.status = claim.status || claim.outcome?.status || '待核实';
      claim.response = claim.response || {};
      claim.dispute = claim.dispute || {};
      claim.emotion = claim.emotion || {};
      claim.outcome = claim.outcome || {};
      claim.pending = Array.isArray(claim.pending) ? claim.pending : [];
      claim.history = Array.isArray(claim.history) ? claim.history : [];
      claim.aiAdvice = claim.aiAdvice || {};
      return claim;
    });
  report.communicationFlow = Array.isArray(report.communicationFlow) ? report.communicationFlow : [];
  report.crossRecording = report.crossRecording || {};
  report.riskSignals = Array.isArray(report.riskSignals) ? report.riskSignals : [];
  report.recommendations = report.recommendations || {};
  report.uncertainties = Array.isArray(report.uncertainties) ? report.uncertainties : [];
  return report;
}

/* ---------------- 单条诉求深度分析 ---------------- */

const DEEP_SYSTEM = `你是资深保险理赔业务专家。用户会给出一个案件中的某一条客户诉求及其上下文，请针对这条诉求做深入分析，帮助业务人员把问题处理闭环。

要求：
1. 只围绕当前诉求，不重复案件背景，不做员工绩效评价。
2. 严格区分：客户陈述、录音可确认事实、你的推断、业务规则依据。
3. 涉及制度、条款、赔付标准时，优先引用【企业知识库】内容并写明文档名；没有依据时必须明确写「知识库中未找到相关规定」，不得编造。
4. 给可执行的处理动作和沟通口径，语言简洁。
5. 只输出合法 JSON，不要输出 Markdown 或解释。`;

/**
 * 针对单条客户诉求生成深度分析，不要求用户重复输入案件背景。
 */
export async function deepAnalyzeClaim({ caseRow, recordings, claim }) {
  const transcriptText = buildTranscriptText(recordings);
  const query = `${claim.title || ''} ${claim.demand || ''} ${claim.dispute?.focus || ''}`.slice(0, 400);
  const kbHits = await searchKnowledge(query || KB_QUERY, 6).catch(() => []);
  const kbBlock = kbHits.length
    ? kbHits.map((h) => `【知识库：${h.docName}】\n${h.text}`).join('\n\n')
    : '（知识库中未检索到相关内容）';

  const result = await chatJson(
    [
      { role: 'system', content: DEEP_SYSTEM },
      {
        role: 'user',
        content: `案件编号：${caseRow.code}
理赔专员工号：${caseRow.employee_id || '未知'}
当前分析诉求：${JSON.stringify(
          {
            id: claim.id,
            title: claim.title,
            type: claim.type,
            demand: claim.demand,
            context: claim.context,
            response: claim.response?.summary,
            dispute: claim.dispute,
            emotion: claim.emotion,
            outcome: claim.outcome,
            pending: claim.pending,
          },
          null,
          1,
        )}

【企业知识库参考】
${kbBlock}

【录音转写全文】
${transcriptText.slice(0, 40000)}

请输出 JSON：
{
  "conclusion": "对该诉求的结论性判断（2-3句，明确哪些已回应、哪些未解决）",
  "points": [{"text": "分析要点", "basis": "录音事实 / 知识库：文档名 / 业务经验（需注明）", "evidence": [{"recording": "录音1", "quote": "原文逐字摘录"}]}],
  "checks": [{"text": "需要业务人员核实的事项", "reason": "原因"}],
  "actions": [{"text": "可执行动作", "priority": "高|中|低"}],
  "script": "建议对客户使用的沟通口径（可直接参考）",
  "missingBasis": "缺少知识库依据的说明；有依据写「」"
}`,
      },
    ],
    { temperature: 0.2, maxTokens: 3000 },
  );

  const cleaned = stripEmpty(result) || {};
  const validation = validateEvidence(cleaned, recordings);
  return {
    ...cleaned,
    generatedAt: nowIso(),
    quotes: validation,
    knowledge: kbHits.map((h) => ({ docName: h.docName, text: h.text.slice(0, 240), score: h.score })),
  };
}

export function saveReport(caseId, report) {
  q.run(
    `UPDATE cases SET report_json = ?, analysis_error = NULL, analysis_at = ?, status = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(report),
    nowIso(),
    'ready',
    nowIso(),
    caseId,
  );
}
