/* 通用工具与 UI 原语 */

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${fmtDate(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fromNow(iso) {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '';
  const diff = Date.now() - d;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`;
  return fmtDate(iso);
}

export const STATUS = {
  uploaded: { label: '待转写', cls: 'badge-gray' },
  transcribing: { label: '转写中', cls: 'badge-blue pulse' },
  transcribed: { label: '已转写', cls: 'badge-green' },
  failed: { label: '处理失败', cls: 'badge-red' },
  pending: { label: '待分析', cls: 'badge-amber' },
  queued: { label: '排队中', cls: 'badge-blue' },
  processing: { label: '分析中', cls: 'badge-blue pulse' },
  ready: { label: '已完成', cls: 'badge-green' },
  uploading: { label: '上传中', cls: 'badge-gray' },
  grouping: { label: '待确认归类', cls: 'badge-amber' },
  confirmed: { label: '已确认', cls: 'badge-green' },
};

export function statusBadge(status, extra = '') {
  const meta = STATUS[status] || { label: status || '未知', cls: 'badge-gray' };
  const pulse = meta.cls.includes('pulse') ? ' badge-dot-pulse' : '';
  return `<span class="badge ${meta.cls.replace(' pulse', '')}${extra}"><i class="dot${status === 'processing' || status === 'transcribing' ? ' on' + pulse : ''}"></i>${esc(
    meta.label,
  )}</span>`;
}

export function roleName(role) {
  return role === 'agent' ? '理赔专员' : role === 'customer' ? '客户' : '未知说话人';
}

/* ---------------- 请求 ---------------- */

export async function api(url, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof Blob)) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const message = data?.error || `请求失败（HTTP ${res.status}）`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function uploadFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || `上传失败（HTTP ${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error('网络错误，上传中断'));
    xhr.send(file);
  });
}

export function postRaw(url, file, onProgress) {
  return uploadFile(url, file, onProgress);
}

/* ---------------- 提示与弹窗 ---------------- */

export function toast(message, type = 'info', timeout = 3600) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ico = type === 'error' ? icon('alert', 15) : type === 'success' ? icon('check', 15) : icon('info', 15);
  el.innerHTML = `${ico}<div>${esc(message)}</div>`;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, timeout);
}

export function confirmDialog({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="max-width:440px">
        <div class="modal-head"><h3>${esc(title)}</h3><button class="btn btn-ghost btn-icon" data-x>${icon('x')}</button></div>
        <div class="modal-body"><div style="font-size:13px;color:#475467;line-height:1.75">${esc(message)}</div></div>
        <div class="modal-foot">
          <button class="btn" data-cancel>取消</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button>
        </div>
      </div>`;
    const close = (value) => {
      mask.remove();
      resolve(value);
    };
    mask.querySelector('[data-ok]').onclick = () => close(true);
    mask.querySelector('[data-cancel]').onclick = () => close(false);
    mask.querySelector('[data-x]').onclick = () => close(false);
    mask.onclick = (e) => {
      if (e.target === mask) close(false);
    };
    root.appendChild(mask);
  });
}

export function openModal(html, { wide = false } = {}) {
  const root = document.getElementById('modal-root');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${html}</div>`;
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) close();
  });
  root.appendChild(mask);
  return { el: mask.querySelector('.modal'), close };
}

/* ---------------- Markdown 轻渲染 ---------------- */

function renderInline(text) {
  let s = esc(text);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/【录音(\d+)\s*([\d:]+)】/g, (_m, n, t) => `<span class="cite" data-cite-rec="${n}" data-cite-time="${t}">录音${n} ${t}</span>`);
  s = s.replace(/【知识库[:：]\s*([^】]+)】/g, (_m, name) => `<span class="cite kb" data-cite-kb="${esc(name)}">知识库：${esc(
    name.length > 18 ? name.slice(0, 18) + '…' : name,
  )}</span>`);
  s = s.replace(/\[录音(\d+)\s*([\d:]+)\]/g, (_m, n, t) => `<span class="cite" data-cite-rec="${n}" data-cite-time="${t}">录音${n} ${t}</span>`);
  return s;
}

export function renderMarkdown(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(renderInline).join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.type}>${list.items.map((i) => `<li>${renderInline(i)}</li>`).join('')}</${list.type}>`);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      out.push(`<h4>${renderInline(heading[2])}</h4>`);
      continue;
    }
    const ol = /^\s*(\d+)[.、)]\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(ol[2]);
      continue;
    }
    if (ul) {
      flushPara();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(ul[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join('');
}

/* ---------------- 图标 ---------------- */

const ICONS = {
  dashboard: '<path d="M3.5 10.5 12 3.8l8.5 6.7V20a.8.8 0 0 1-.8.8h-5v-6.4h-5.4v6.4h-5a.8.8 0 0 1-.8-.8v-9.5Z"/>',
  upload: '<path d="M12 16V4.8M8 8.4 12 4.4l4 4"/><path d="M4 15v3.6c0 .8.6 1.4 1.4 1.4h13.2c.8 0 1.4-.6 1.4-1.4V15"/>',
  folder: '<path d="M3.5 7.2c0-.9.7-1.6 1.6-1.6h4l2 2.2h6.2c.9 0 1.6.7 1.6 1.6v8.2c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6V7.2Z"/>',
  book: '<path d="M4 5.4c0-.8.6-1.4 1.4-1.4H10c1.1 0 2 .9 2 2v13c0-1.1-.9-2-2-2H4V5.4Z"/><path d="M20 5.4c0-.8-.6-1.4-1.4-1.4H14c-1.1 0-2 .9-2 2v13c0-1.1.9-2 2-2h6V5.4Z"/>',
  settings:
    '<circle cx="12" cy="12" r="2.8"/><path d="M19.4 14.4a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrowRight: '<path d="M5 12h13M13 6.5 18.5 12 13 17.5"/>',
  check: '<path d="m4.5 12.5 4.5 4.5 10.5-11"/>',
  alert: '<path d="M12 8v5.2"/><circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none"/><path d="M10.3 3.9 2.8 17c-.7 1.2.2 2.7 1.6 2.7h15.2c1.4 0 2.3-1.5 1.6-2.7L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r=".9" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 4.5v11M8 11.5l4 4 4-4"/><path d="M4.5 19.5h15"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 3.6V9h-5.4"/>',
  trash: '<path d="M4.5 6.8h15M9.5 6.8V4.6c0-.6.4-1 1-1h3c.6 0 1 .4 1 1v2.2M6.5 6.8l.9 12.2c0 .9.8 1.5 1.6 1.5h6c.8 0 1.6-.6 1.6-1.5l.9-12.2"/>',
  play: '<path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" stroke="none"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 4 4"/>',
  file: '<path d="M6 3.5h7l5 5v12H6v-17Z"/><path d="M13 3.5v5h5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
  user: '<circle cx="12" cy="8.2" r="3.6"/><path d="M4.8 20c.7-3.6 3.6-5.6 7.2-5.6s6.5 2 7.2 5.6"/>',
  spark: '<path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9 12 3.5Z"/>',
  send: '<path d="M4.5 12 20 4.5 15.5 20 11.8 13.2 4.5 12Z"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  shield: '<path d="M12 3.2 19 6v5.4c0 4.2-2.9 7.6-7 9.4-4.1-1.8-7-5.2-7-9.4V6l7-2.8Z"/>',
  quote: '<path d="M9.5 6.5c-3 1.4-4.5 3.7-4.5 6.8 0 2.4 1.3 4.2 3.4 4.2 1.8 0 3.1-1.3 3.1-3 0-1.7-1.2-2.9-2.8-2.9-.3 0-.6 0-.8.1.3-1.6 1.4-2.9 3.2-3.8l-1.6-1.4Z"/><path d="M17.5 6.5c-3 1.4-4.5 3.7-4.5 6.8 0 2.4 1.3 4.2 3.4 4.2 1.8 0 3.1-1.3 3.1-3 0-1.7-1.2-2.9-2.8-2.9-.3 0-.6 0-.8.1.3-1.6 1.4-2.9 3.2-3.8l-1.6-1.4Z"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16v-4M12 16V7M16 16v-6"/>',
  message: '<path d="M20.5 12c0 4.1-3.8 7.4-8.5 7.4-1 0-2-.1-2.9-.4L4 21l1.4-3.9A7 7 0 0 1 3.5 12c0-4.1 3.8-7.4 8.5-7.4s8.5 3.3 8.5 7.4Z"/>',
  zap: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z"/>',
  layers: '<path d="m12 3.5 8.5 4.3L12 12 3.5 7.8 12 3.5Z"/><path d="m4 12 8 4 8-4M4 16.2l8 4 8-4"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  shieldCheck: '<path d="M12 3.2 19 6v5.4c0 4.2-2.9 7.6-7 9.4-4.1-1.8-7-5.2-7-9.4V6l7-2.8Z"/><path d="m8.8 11.7 2.2 2.2 4.2-4.4"/>',
  external: '<path d="M14 4.5h5.5V10"/><path d="m19.5 4.5-7.6 7.6"/><path d="M18 14v5.6H4.4V5.9H10"/>',
  sort: '<path d="M8 5v14M5 16l3 3 3-3"/><path d="M16 19V5M13 8l3-3 3 3"/>',
};

export function icon(name, size = 16) {
  const body = ICONS[name] || ICONS.info;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function debounce(fn, wait = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
