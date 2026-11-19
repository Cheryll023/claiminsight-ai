import { api, icon, esc } from './lib.js?v=7';
import workbench from './views/workbench.js?v=7';
import caseDetail from './views/caseDetail.js?v=7';
import knowledge from './views/knowledge.js?v=7';
import settings from './views/settings.js?v=7';

/* 嵌入宿主系统形态：单一「录音分析」入口，知识库/模型配置由宿主提供（本 Demo 保留页面，经工作台顶栏进入） */
const NAV = [
  { path: '/', label: '录音分析', icon: 'dashboard', view: workbench, title: '录音分析工作台' },
];

const routes = [
  { pattern: /^\/$/, view: workbench, title: '录音分析工作台' },
  { pattern: /^\/cases\/([^/]+)$/, view: caseDetail, title: '案件分析详情', params: ['id'] },
  { pattern: /^\/kb$/, view: knowledge, title: '企业业务知识库' },
  { pattern: /^\/settings$/, view: settings, title: '系统设置' },
];

const ctx = {
  setTitle(title, crumb) {
    document.getElementById('page-title').textContent = title;
    const crumbEl = document.getElementById('crumb');
    if (crumb && crumb.length) {
      crumbEl.innerHTML = crumb
        .map((item, i) =>
          item.href
            ? `<a href="${item.href}">${esc(item.label)}</a>${i < crumb.length - 1 ? '<span>/</span>' : ''}`
            : `<span>${esc(item.label)}</span>`,
        )
        .join('');
    } else {
      crumbEl.innerHTML = '<span>理赔录音智能分析平台</span>';
    }
  },
  setActions(html) {
    document.getElementById('topbar-actions').innerHTML = html || '';
  },
  navigate(path) {
    location.hash = `#${path}`;
  },
};

let currentDestroy = null;
let appStatus = { llm: false, asr: false, embed: false };

function renderNav() {
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  const nav = document.getElementById('nav');
  nav.innerHTML = NAV.map((item) => {
    if (item.group) return `<div class="nav-group">${esc(item.group)}</div>`;
    const active = item.path === '/' ? path === '/' || path.startsWith('/cases') : path.startsWith(item.path);
    return `<a class="nav-item ${active ? 'active' : ''}" href="#${item.path}">${icon(item.icon, 17)}<span>${esc(item.label)}</span></a>`;
  }).join('');
}

function renderAiStatus() {
  const el = document.getElementById('ai-status');
  const line = (ok, label) =>
    `<div class="status-line"><i class="dot ${ok ? 'on' : 'warn'}"></i>${esc(label)}${ok ? '' : '未配置'}</div>`;
  el.innerHTML = `${line(appStatus.llm, '大模型 ')}${line(appStatus.asr, '语音转写 ')}`;
  if (!appStatus.llm || !appStatus.asr) {
    el.innerHTML += `<a href="#/settings" style="color:#8ea6e8;font-size:11px;margin-top:2px">前往配置 →</a>`;
  }
}

async function refreshStatus() {
  try {
    const data = await api('/api/settings');
    appStatus = data.status;
    renderAiStatus();
  } catch {
    /* ignore */
  }
}

async function resolve() {
  const fullHash = location.hash.replace(/^#/, '') || '/';
  const path = fullHash.split('?')[0];
  /* 旧入口重定向：#/upload、#/cases 已并入工作台，保留 query（如 ?batch=） */
  if (path === '/upload' || path === '/cases') {
    const qs = fullHash.split('?')[1];
    location.replace(`#/${qs ? `?${qs}` : ''}`);
    return;
  }
  renderNav();
  /* 顶栏全局返回按钮：非首页路由（案件详情 / 知识库 / 设置）显示，保证任何页面都能回首页 */
  const backBtn = document.getElementById('back-btn');
  if (backBtn) backBtn.hidden = path === '/';
  let matched = null;
  let params = {};
  for (const r of routes) {
    const m = r.pattern.exec(path);
    if (m) {
      matched = r;
      params = Object.fromEntries((r.params || []).map((key, i) => [key, decodeURIComponent(m[i + 1])]));
      break;
    }
  }
  const view = document.getElementById('view');
  if (currentDestroy) {
    try {
      currentDestroy();
    } catch {
      /* ignore */
    }
    currentDestroy = null;
  }
  ctx.setActions('');
  if (!matched) {
    ctx.setTitle('页面不存在');
    view.innerHTML = `<div class="card empty">${icon('alert')}<h4>页面不存在</h4><p>请检查访问地址</p><a class="btn" href="#/">返回工作台</a></div>`;
    return;
  }
  ctx.setTitle(matched.title);
  view.innerHTML = `<div class="card empty"><span class="spinner dark"></span></div>`;
  document.querySelector('.view').scrollTo?.(0, 0);
  try {
    currentDestroy = (await matched.view(view, { ...ctx, params, path })) || null;
  } catch (err) {
    view.innerHTML = `<div class="card empty">${icon('alert')}<h4>页面加载失败</h4><p>${esc(err.message)}</p><button class="btn" onclick="location.reload()">刷新重试</button></div>`;
  }
}

window.addEventListener('hashchange', resolve);
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-nav]');
  if (link) {
    e.preventDefault();
    location.hash = `#${link.dataset.nav}`;
  }
});
document.getElementById('back-btn')?.addEventListener('click', () => {
  location.hash = '#/';
});

renderNav();
refreshStatus();
resolve();
setInterval(refreshStatus, 30000);

// 供视图使用
export { ctx, appStatus };
