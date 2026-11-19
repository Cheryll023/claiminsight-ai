import zlib from 'node:zlib';
import { q, uid, nowIso } from './db.js';
import { listZipEntries, readZipEntry } from './zip.js';
import { embedTexts } from './llm.js';
import { isEmbedConfigured } from './config.js';

/* ---------------- 文档解析 ---------------- */

function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

function docxToText(buf) {
  const entries = listZipEntries(buf);
  const target = entries.find((e) => e.name === 'word/document.xml');
  if (!target) throw new Error('DOCX 中未找到正文内容');
  let xml = readZipEntry(buf, target).toString('utf8');
  xml = xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return xml
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pdfToText(buf) {
  const chunks = [];
  let pos = 0;
  while (pos < buf.length) {
    const streamIdx = buf.indexOf('stream', pos, 'latin1');
    if (streamIdx < 0) break;
    let dataStart = streamIdx + 6;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    const endIdx = buf.indexOf('endstream', dataStart, 'latin1');
    if (endIdx < 0) break;
    const dictStart = Math.max(0, buf.lastIndexOf('<<', streamIdx));
    const dict = buf.toString('latin1', dictStart, streamIdx);
    const raw = buf.subarray(dataStart, endIdx);
    let decoded = null;
    if (/FlateDecode/.test(dict)) {
      try {
        decoded = zlib.inflateSync(raw);
      } catch {
        try {
          decoded = zlib.inflateRawSync(raw);
        } catch {
          decoded = null;
        }
      }
    } else if (!/DCTDecode|JPXDecode|Image/.test(dict)) {
      decoded = raw;
    }
    if (decoded) {
      const s = decoded.toString('latin1');
      if (/(Tj|TJ)/.test(s)) chunks.push(extractPdfTextOps(s));
    }
    pos = endIdx + 9;
  }
  return chunks.join('\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function extractPdfTextOps(content) {
  const out = [];
  const ops = content.match(/\[(?:[^\]]|\][^T])*\]\s*TJ|\((?:\\.|[^\\()])*\)\s*Tj|T\*|Td|TD/g) || [];
  for (const op of ops) {
    if (/^T\*|Td|TD$/.test(op.trim())) {
      out.push('\n');
      continue;
    }
    const isArray = op.trim().startsWith('[');
    const re = /\((?:\\.|[^\\()])*\)/g;
    let m;
    let line = '';
    while ((m = re.exec(op))) {
      line += unescapePdfString(m[0].slice(1, -1));
    }
    if (line) out.push(isArray ? line : line);
  }
  return out
    .join(' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function unescapePdfString(s) {
  return s
    .replace(/\\([nrtbf()\\])/g, (_m, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] || c))
    .replace(/\\([0-7]{1,3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)));
}

export function extractDocumentText(name, buffer) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['txt', 'md', 'markdown', 'csv'].includes(ext)) return { text: decodeText(buffer), warning: '' };
  if (ext === 'docx') return { text: docxToText(buffer), warning: '' };
  if (ext === 'pdf') {
    const text = pdfToText(buffer);
    const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const warning =
      text.length < 80 || (cjk < 20 && text.length < 400)
        ? 'PDF 文本提取结果较少，可能是扫描件或特殊字体编码。建议同时上传 Word/Markdown 原件，或直接粘贴文本。'
        : '';
    return { text, warning };
  }
  if (ext === 'doc') throw new Error('暂不支持 .doc 旧格式，请另存为 .docx 后上传');
  throw new Error(`不支持的文档格式：.${ext}，请上传 PDF / DOCX / TXT / Markdown`);
}

/* ---------------- 切分与入库 ---------------- */

function splitChunks(text, target = 700, overlap = 120) {
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks = [];
  let current = '';
  let heading = '';
  const flush = () => {
    if (!current.trim()) return;
    chunks.push({ title: heading, text: current.trim() });
    const tail = overlap > 0 ? current.slice(-overlap) : '';
    current = tail;
  };
  for (const para of paragraphs) {
    const isHeading = /^(#{1,6}\s|第[一二三四五六七八九十百]+[章节条]|[一二三四五六七八九十]+、|\d+(\.\d+)*\s*[、.]\s*\S{2,20}$)/.test(para) && para.length <= 40;
    if (isHeading) {
      flush();
      heading = para.replace(/^#+\s*/, '').slice(0, 60);
      current = `${para}\n`;
      continue;
    }
    if (current.length + para.length > target && current.length > 0) {
      flush();
      if (current.length + para.length > target * 1.6) current = '';
    }
    current += (current ? '\n' : '') + para;
  }
  if (current.trim() && current.trim().length > 20) chunks.push({ title: heading, text: current.trim() });
  return chunks.filter((c) => c.text.length >= 12);
}

export async function ingestDocument({ name, buffer, pastedText }) {
  const docId = uid();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : 'txt';
  q.run(
    'INSERT INTO kb_docs(id, name, ext, size, status, created_at) VALUES(?,?,?,?,?,?)',
    docId,
    name,
    ext,
    buffer ? buffer.length : (pastedText || '').length,
    'processing',
    nowIso(),
  );
  try {
    let text = pastedText || '';
    let warning = '';
    if (!text) {
      const parsed = extractDocumentText(name, buffer);
      text = parsed.text;
      warning = parsed.warning;
    }
    text = text.replace(/\r\n/g, '\n').trim();
    if (text.length < 20) throw new Error('文档内容为空或无法提取有效文本');
    const chunks = splitChunks(text);
    if (!chunks.length) throw new Error('文档切分后没有有效内容');

    let embeddings = null;
    if (isEmbedConfigured()) {
      try {
        embeddings = [];
        for (let i = 0; i < chunks.length; i += 16) {
          const batch = chunks.slice(i, i + 16).map((c) => c.text.slice(0, 2000));
          const vecs = await embedTexts(batch);
          embeddings.push(...(vecs || []));
        }
        if (embeddings.length !== chunks.length) embeddings = null;
      } catch {
        embeddings = null;
      }
    }

    const insert = q.run;
    for (let i = 0; i < chunks.length; i++) {
      insert(
        'INSERT INTO kb_chunks(id, doc_id, idx, title, text, embedding) VALUES(?,?,?,?,?,?)',
        uid(),
        docId,
        i,
        chunks[i].title || name,
        chunks[i].text,
        embeddings ? JSON.stringify(embeddings[i]) : null,
      );
    }
    q.run('UPDATE kb_docs SET status = ?, text = ?, chunks = ?, error = ? WHERE id = ?', 'ready', text, chunks.length, warning, docId);
    invalidateIndex();
    return { id: docId, chunks: chunks.length, warning };
  } catch (err) {
    q.run('UPDATE kb_docs SET status = ?, error = ? WHERE id = ?', 'failed', err.message, docId);
    throw err;
  }
}

/* ---------------- 检索 ---------------- */

let indexCache = null;

export function invalidateIndex() {
  indexCache = null;
}

function tokenize(text) {
  const tokens = [];
  const lower = text.toLowerCase();
  for (const run of lower.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]);
      if (i + 1 < run.length) tokens.push(run[i] + run[i + 1]);
    }
  }
  for (const word of lower.match(/[a-z0-9]{2,}/g) || []) tokens.push(word);
  return tokens;
}

const STOP_TOKENS = new Set('的了和是我在有与及或对于并且等这一个我们你们他们可以需要如果因为所以但是还要就都也很不'.split(''));

function buildIndex() {
  if (indexCache) return indexCache;
  const rows = q.all(
    `SELECT c.id, c.doc_id, c.idx, c.title, c.text, c.embedding, d.name AS doc_name
     FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE d.status = 'ready'`,
  );
  const docs = rows.map((row) => {
    const tf = new Map();
    const toks = tokenize(`${row.title || ''} ${row.text}`);
    for (const t of toks) {
      if (STOP_TOKENS.has(t)) continue;
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    return { ...row, tf, len: toks.length, embedding: row.embedding ? JSON.parse(row.embedding) : null };
  });
  const df = new Map();
  for (const doc of docs) for (const t of doc.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  indexCache = { docs, df, avgLen: docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1) };
  return indexCache;
}

export async function searchKnowledge(query, topK = 6) {
  const index = buildIndex();
  if (!index.docs.length) return [];
  const tokens = tokenize(query).filter((t) => !STOP_TOKENS.has(t));
  const scores = new Map();
  const N = index.docs.length;
  const k1 = 1.2;
  const b = 0.75;
  for (const doc of index.docs) {
    let score = 0;
    for (const token of new Set(tokens)) {
      const f = doc.tf.get(token) || 0;
      if (!f) continue;
      const dfv = index.df.get(token) || 0;
      const idf = Math.log(1 + (N - dfv + 0.5) / (dfv + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (doc.len / index.avgLen))));
    }
    if (score > 0) scores.set(doc.id, { doc, score });
  }

  if (isEmbedConfigured()) {
    try {
      const [qvec] = (await embedTexts([query])) || [];
      if (qvec) {
        for (const doc of index.docs) {
          if (!doc.embedding) continue;
          const cos = cosine(qvec, doc.embedding);
          const prev = scores.get(doc.id);
          const boost = Math.max(0, cos) * 10;
          if (prev) prev.score += boost;
          else scores.set(doc.id, { doc, score: boost });
        }
      }
    } catch {
      /* 向量检索失败时使用纯关键词结果 */
    }
  }

  const sorted = [...scores.values()].sort((a, b2) => b2.score - a.score).slice(0, topK);
  return sorted.map(({ doc, score }) => ({
    chunkId: doc.id,
    docId: doc.doc_id,
    docName: doc.doc_name,
    title: doc.title,
    idx: doc.idx,
    text: doc.text,
    score: Number(score.toFixed(3)),
  }));
}

function cosine(a, b2) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b2.length); i++) {
    dot += a[i] * b2[i];
    na += a[i] * a[i];
    nb += b2[i] * b2[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function kbStats() {
  const docs = q.get("SELECT COUNT(*) AS c FROM kb_docs WHERE status = 'ready'");
  const chunks = q.get('SELECT COUNT(*) AS c FROM kb_chunks');
  return { docs: docs?.c || 0, chunks: chunks?.c || 0 };
}
