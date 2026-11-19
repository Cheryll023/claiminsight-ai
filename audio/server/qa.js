import { q, jsonParse, uid, nowIso } from './db.js';
import { streamChat } from './llm.js';
import { searchKnowledge } from './kb.js';
import { formatDuration } from './filename.js';

function grams(text) {
  const clean = String(text || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
  const set = new Set();
  for (let i = 0; i < clean.length; i++) {
    set.add(clean[i]);
    if (i + 1 < clean.length) set.add(clean.slice(i, i + 2));
  }
  return set;
}

function retrieveSegments(recordings, question, limit = 14) {
  // 短案件直接提供完整转写，避免关键词检索漏掉上下文；长案件再按相关度筛选
  let totalChars = 0;
  let totalSegs = 0;
  const all = [];
  recordings.forEach((rec, recIndex) => {
    const transcript = jsonParse(rec.transcript_json, { segments: [] });
    for (const seg of transcript.segments || []) {
      totalChars += (seg.text || '').length;
      totalSegs += 1;
      all.push({ recIndex, rec, seg, score: 0 });
    }
  });
  if (totalChars <= 8000 && totalSegs <= 90) return all;

  const qGrams = grams(question);
  const scored = [];
  recordings.forEach((rec, recIndex) => {
    const transcript = jsonParse(rec.transcript_json, { segments: [] });
    (transcript.segments || []).forEach((seg) => {
      const sGrams = grams(seg.text);
      if (!sGrams.size) return;
      let hit = 0;
      for (const g of qGrams) if (sGrams.has(g)) hit += g.length > 1 ? 2 : 0.5;
      const density = hit / Math.sqrt(sGrams.size);
      if (density > 0.2) scored.push({ recIndex, rec, seg, score: density });
    });
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  if (!top.length) {
    // 没有命中时，取每段录音的开头片段，保证有基本上下文
    recordings.forEach((rec, recIndex) => {
      const segs = jsonParse(rec.transcript_json, { segments: [] }).segments || [];
      segs.slice(0, 3).forEach((seg) => top.push({ recIndex, rec, seg, score: 0 }));
    });
    return top.slice(0, limit);
  }
  return top.sort((a, b) => a.recIndex - b.recIndex || a.seg.start - b.seg.start);
}

function compactReport(report) {
  if (!report) return '（该案件尚未生成分析报告）';
  const clone = JSON.parse(JSON.stringify(report));
  delete clone.evidence;
  delete clone.meta;
  return JSON.stringify(clone, null, 1).slice(0, 12000);
}

export async function buildCaseContext(caseRow, recordings, question) {
  const segments = retrieveSegments(recordings, question);
  const kbHits = await searchKnowledge(question, 6).catch(() => []);
  const report = jsonParse(caseRow.report_json, null);

  const segmentBlock = segments
    .map((item) => `【录音${item.recIndex + 1} ${formatDuration(item.seg.start)}｜${item.rec.rec_type || '沟通'}】${item.seg.role === 'agent' ? '理赔专员' : item.seg.role === 'customer' ? '客户' : '未知'}：${item.seg.text}`)
    .join('\n');

  const kbBlock = kbHits.length
    ? kbHits.map((h) => `【知识库：${h.docName}${h.title && h.title !== h.docName ? ' / ' + h.title : ''}】\n${h.text}`).join('\n\n')
    : '（知识库中未检索到相关内容）';

  const system = `你是保险理赔录音分析 AI 助手，正在协助用户理解一个具体案件的沟通内容，并回答相关业务问题。你必须以提供的【案件资料】为准回答，不得编造案件事实或分析结论。

回答要求：
1. 紧扣当前案件，不要给通用的常识性回答；先给结论，再给依据，最后给可执行的建议。
2. 引用案件内容时使用格式【录音N 时间】，例如【录音2 03:12】；引用企业规范时使用【知识库：文档名】。
3. 企业制度、保险条款、操作规范等"规范依据"必须优先来自【企业知识库】。如果知识库没有可靠依据，必须明确说明"知识库中未找到相关规定"，再给出基于行业经验的一般性建议，并标注这是经验建议而非公司规定。
4. 区分「录音中的事实」「客户陈述」「你的推断」「你的建议」。
5. 案件资料未提及的信息，直接回答"录音中未提及"，不要猜测。
6. 重点围绕客户诉求、理赔专员的回答、解释是否充分、信息是否有遗漏、还有哪些业务疑问，给出有依据的分析。
7. 使用简洁的中文分点表述，适合理赔人员和业务团队快速阅读和执行。

【案件基本信息】
案件编号：${caseRow.code}
理赔专员工号：${caseRow.employee_id || '未知'}
录音数量：${recordings.length}

【案件分析报告（节选）】
${compactReport(report)}

【案件录音相关片段】
${segmentBlock || '（无）'}

【企业知识库检索结果】
${kbBlock}`;

  const citations = {
    segments: segments.map((item) => ({
      recordingId: item.rec.id,
      recordingIndex: item.recIndex + 1,
      filename: item.rec.filename,
      start: item.seg.start,
      time: formatDuration(item.seg.start),
      role: item.seg.role,
      text: item.seg.text.slice(0, 200),
    })),
    knowledge: kbHits.map((h) => ({
      docId: h.docId,
      docName: h.docName,
      title: h.title,
      text: h.text.slice(0, 240),
      score: h.score,
    })),
  };
  return { system, citations, kbHits };
}

export function loadConversation(caseId, limit = 12) {
  const rows = q.all(
    'SELECT role, content FROM messages WHERE case_id = ? ORDER BY created_at DESC LIMIT ?',
    caseId,
    limit,
  );
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

export function saveMessage(caseId, role, content, citations = null) {
  q.run(
    'INSERT INTO messages(id, case_id, role, content, citations_json, created_at) VALUES(?,?,?,?,?,?)',
    uid(),
    caseId,
    role,
    content,
    citations ? JSON.stringify(citations) : null,
    nowIso(),
  );
}

export async function answerQuestion({ caseRow, recordings, question, history, onMeta, onDelta }) {
  const { system, citations } = await buildCaseContext(caseRow, recordings, question);
  if (onMeta) onMeta(citations);
  const messages = [{ role: 'system', content: system }, ...(history || []), { role: 'user', content: question }];
  const answer = await streamChat(messages, onDelta, { temperature: 0.25 });
  return { answer, citations };
}
