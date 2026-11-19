import {
  api,
  uploadFile,
  postRaw,
  esc,
  icon,
  toast,
  confirmDialog,
  fmtSize,
  fmtDuration,
  statusBadge,
  fmtDateTime,
  fromNow,
} from '../lib.js?v=7';

const FILTERS = [
  { key: '', label: '全部', match: () => true },
  { key: 'ready', label: '已分析', match: (c) => c.status === 'ready' },
  { key: 'active', label: '处理中', match: (c) => ['queued', 'processing', 'pending'].includes(c.status) },
  { key: 'failed', label: '失败', match: (c) => c.status === 'failed' },
];

export default async function workbench(view, ctx) {
  const query = new URLSearchParams(location.hash.split('?')[1] || '');

  /* ---------- 导入录音状态 ---------- */
  const up = {
    batchId: query.get('batch') || null,
    batch: null,
    step: 1,
    queue: [],
    groups: [],
    cases: [],
    recordings: [],
    uploading: false,
    polling: null,
    classifyPolling: null,
    classify: null,
    destroyed: false,
    ai: null,
    insights: null,
  };

  /* ---------- 案件列表状态 ---------- */
  const initialStatus = query.get('status') || '';
  let keyword = '';
  let filter = FILTERS.some((f) => f.key === initialStatus) ? initialStatus : '';
  let all = [];
  let casesTimer = null;

  ctx.setActions(`
    <a class="btn btn-ghost" href="#/kb">${icon('book', 15)}知识库</a>
    <a class="btn btn-ghost" href="#/settings">${icon('settings', 15)}设置</a>
  `);

  async function init() {
    if (up.batchId) {
      try {
        await loadBatch();
      } catch (err) {
        toast(err.message, 'error');
        up.batchId = null;
      }
    }
    up.ai = await api('/api/settings').then((d) => d.status).catch(() => null);
    render();
    loadCases();
    casesTimer = setInterval(() => {
      if (document.hidden || up.destroyed) return;
      if (all.some((c) => ['queued', 'processing'].includes(c.status))) loadCases();
    }, 4000);
    // 恢复未完成的识别任务
    if (up.step === 2 && up.classify?.status === 'running') startClassifyPolling();
    else if (up.step === 2 && (!up.classify || up.classify.status === 'idle')
      && up.groups.some((g) => g.needsReview) && up.ai?.llm) {
      beginClassify();
    }
  }

  async function loadBatch() {
    const data = await api(`/api/batches/${up.batchId}`);
    up.batch = data.batch;
    up.insights = data.insights || null;
    up.cases = data.cases;
    up.recordings = data.recordings || [];
    up.groups = data.groups || [];
    up.classify = data.classify || null;
    up.step = data.batch.status === 'confirmed' ? 3 : up.recordings.length ? 2 : 1;
  }

  /* ---------------- 页面结构 ---------------- */

  function render() {
    const ai = up.ai;
    const configAlert =
      ai && (!ai.llm || !ai.asr)
        ? `<div class="alert" style="margin-bottom:16px">
            ${icon('alert')}
            <div class="grow">
              <b>AI 服务尚未配置完整</b> —— ${!ai.asr ? '缺少语音转写服务' : ''}${!ai.llm ? ' 缺少大模型服务' : ''}。
              可以先导入录音并确认案件归类，但转写与案件分析报告生成需要先完成配置。
            </div>
            <a class="btn btn-sm" href="#/settings">立即配置</a>
          </div>`
        : '';
    /* 向导模式：进行中的导入流程独占页面，不在下方重复展示首页的「最近上传批次 / 案件分析」 */
    const wizard = up.batchId && up.step >= 2;
    view.innerHTML = `
      ${configAlert}
      ${wizard ? wizardBar() : heroHtml()}
      <div id="wb-stepper">${wizard ? stepper() : ''}</div>
      <div id="step-body"></div>
      ${wizard ? '' : '<div id="history" style="margin-top:22px"></div>'}
      ${wizard ? '' : '<div id="wb-cases" style="margin-top:22px"></div>'}
    `;
    view.querySelector('[data-exit-wizard]')?.addEventListener('click', exitWizard);
    bindStep();
    if (!wizard) {
      renderHistory();
      renderCases();
    }
  }

  /* 首页：主流程三步图示（上传录音 → 自动转写与归类 → AI 辅助分析） */
  function heroHtml() {
    return `<div class="hero" style="margin-bottom:16px">
      <div>
        <h2>三步完成理赔录音的转写与 AI 分析</h2>
        <p>上传团队录音压缩包，系统自动转写并按案件归类，生成以客户诉求为主线的综合分析报告，支持继续向 AI 追问</p>
      </div>
      <div class="hero-flow">
        <div class="hf-item"><span class="hf-num">1</span><div><b>上传录音</b><small>ZIP 压缩包或多个音频文件</small></div></div>
        <span class="hf-arrow">→</span>
        <div class="hf-item"><span class="hf-num">2</span><div><b>自动转写与归类</b><small>按案件自动分组，少量需确认</small></div></div>
        <span class="hf-arrow">→</span>
        <div class="hf-item"><span class="hf-num">3</span><div><b>AI 辅助分析</b><small>诉求 · 争议 · 建议 · 追问</small></div></div>
      </div>
    </div>`;
  }

  /* 向导顶栏：提供明确的返回首页出口，批次保留不丢失 */
  function wizardBar() {
    return `<div class="wizard-bar">
      <button class="btn btn-ghost btn-sm" data-exit-wizard>${icon('arrowRight', 14)}返回首页</button>
      <div class="grow">
        <b>${esc(up.batch?.name || '导入批次')}</b>
        <span class="small muted">${up.step === 2 ? '离开后可从首页「最近上传批次」继续确认' : '案件在后台处理，离开后可随时回来查看进度'}</span>
      </div>
      <span class="badge badge-blue">步骤 ${up.step} / 3</span>
    </div>`;
  }

  /* 退出导入向导回到首页；批次保留在「最近上传批次」，可随时继续 */
  function exitWizard() {
    if (up.polling) {
      clearInterval(up.polling);
      up.polling = null;
    }
    if (up.classifyPolling) {
      clearInterval(up.classifyPolling);
      up.classifyPolling = null;
    }
    up.batchId = null;
    up.batch = null;
    up.step = 1;
    up.queue = [];
    up.groups = [];
    up.cases = [];
    up.recordings = [];
    up.classify = null;
    up.insights = null;
    history.replaceState(null, '', '#/');
    render();
    loadCases();
  }

  function renderImport() {
    const wrap = view.querySelector('#wb-stepper');
    if (wrap) wrap.innerHTML = stepper();
    bindStep();
  }

  function stepper() {
    const item = (n, label, cls) => `<div class="step ${cls}"><span class="num">${cls.includes('done') ? icon('check', 12) : n}</span>${label}</div>`;
    return `<div class="steps">
      ${item(1, '上传录音', up.step === 1 ? 'active' : 'done')}
      <span class="step-line"></span>
      ${item(2, '确认案件归类', up.step === 2 ? 'active' : up.step > 2 ? 'done' : '')}
      <span class="step-line"></span>
      ${item(3, '转写与 AI 分析', up.step === 3 ? 'active' : '')}
    </div>`;
  }

  /* ---------------- 第一步：上传 ---------------- */

  function stepOneHtml() {
    return `
      <div class="card card-pad" style="padding:0">
        <div class="card-head">
          <div><h3>上传理赔沟通录音</h3><div class="sub">支持整个团队的录音压缩包，上传后自动识别案件归属，无需逐个填写</div></div>
          <span class="badge badge-gray">${icon('shield', 12)} 本地存储</span>
        </div>
        <div style="padding:18px">
          <div class="dropzone" id="dropzone">
            <div class="dz-icon">${icon('layers', 26)}</div>
            <h3>拖拽压缩包到此处，或点击选择文件</h3>
            <p>推荐上传 ZIP 压缩包（可包含多个员工/案件文件夹）；也支持 MP3 / WAV / M4A / AAC / FLAC / OGG / AMR 单文件批量选择</p>
            <div class="row" style="justify-content:center">
              <button class="btn btn-primary" id="pick-zip">${icon('layers')}选择 ZIP 压缩包</button>
              <button class="btn" id="pick-files">${icon('file')}选择录音文件</button>
            </div>
            <input type="file" id="file-input" multiple accept="audio/*,.zip" hidden />
            <input type="file" id="zip-input" accept=".zip" hidden />
          </div>
          <div class="row wrap" style="gap:6px;margin-top:14px">
            <span class="small muted">自动识别顺序：</span>
            <span class="badge badge-gray">1 文件名</span>
            <span class="badge badge-blue">2 文件夹结构</span>
            <span class="badge badge-teal">3 录音内容</span>
            <span class="small muted">识别不确定时才需要人工确认</span>
          </div>
          <div id="queue-area" style="margin-top:16px"></div>
        </div>
      </div>`;
  }

  function queueHtml() {
    if (!up.queue.length) return '';
    const totalSize = up.queue.reduce((s, item) => s + item.file.size, 0);
    return `
      <div class="card" style="box-shadow:none">
        <div class="card-head">
          <div><h3>待上传文件 <span class="muted">(${up.queue.length})</span></h3><div class="sub">总大小 ${fmtSize(totalSize)}</div></div>
          <div class="row">
            <button class="btn btn-sm btn-ghost" id="clear-queue" ${up.uploading ? 'disabled' : ''}>清空</button>
            <button class="btn btn-sm btn-primary" id="start-upload" ${up.uploading ? 'disabled' : ''}>
              ${up.uploading ? '<span class="spinner"></span> 上传中…' : icon('upload') + ' 开始上传'}
            </button>
          </div>
        </div>
        <div class="file-list">
          ${up.queue.map(fileRow).join('')}
        </div>
      </div>`;
  }

  function fileRow(item) {
    const isZip = /\.zip$/i.test(item.file.name);
    const statusMap = {
      waiting: '<span class="badge badge-gray">等待上传</span>',
      uploading: '<span class="badge badge-blue"><i class="dot on badge-dot-pulse"></i>上传中</span>',
      unzipping: '<span class="badge badge-blue"><i class="dot on badge-dot-pulse"></i>解压中</span>',
      done: '<span class="badge badge-green">已上传</span>',
      error: `<span class="badge badge-red">失败</span>`,
    };
    return `
      <div class="file-item" data-file-row="${item.id}">
        <div class="file-ico">${isZip ? 'ZIP' : esc(item.ext)}</div>
        <div class="grow">
          <div class="row between" style="gap:8px">
            <div class="file-name">${esc(item.file.name)}</div>
            <div class="small muted mono">${fmtSize(item.file.size)}</div>
          </div>
          <div class="progress progress-thin" style="margin-top:6px">
            <i data-file-progress="${item.id}" style="width:${Math.round((item.progress || 0) * 100)}%"></i>
          </div>
          <div class="row between" style="margin-top:4px">
            <span class="small muted" data-file-note="${item.id}">${esc(item.note || '')}</span>
            <span class="small${item.status === 'error' ? '' : ' muted'}" style="${item.status === 'error' ? 'color:#d92d20' : ''}">${item.error || ''}</span>
          </div>
        </div>
        <div style="flex:none">${statusMap[item.status] || ''}</div>
        ${item.status === 'waiting' ? `<button class="btn btn-ghost btn-icon btn-sm" data-remove="${item.id}">${icon('x', 14)}</button>` : ''}
      </div>`;
  }

  function addFiles(fileList) {
    const files = [...fileList];
    for (const file of files) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const isZip = ext === 'zip';
      const okAudio = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'amr', 'wma', 'webm', 'mp4'].includes(ext);
      if (!isZip && !okAudio) {
        toast(`已跳过不支持的文件：${file.name}`, 'error');
        continue;
      }
      if (up.queue.some((q) => q.file.name === file.name && q.file.size === file.size)) continue;
      up.queue.push({
        id: crypto.randomUUID(),
        file,
        ext,
        progress: 0,
        status: 'waiting',
        note: isZip ? '上传后自动解压' : '',
      });
    }
    refreshQueue();
  }

  function refreshQueue() {
    const area = view.querySelector('#queue-area');
    if (area) area.innerHTML = queueHtml();
  }

  async function startUpload() {
    if (up.uploading) return;
    up.uploading = true;
    refreshQueue();
    try {
      if (!up.batchId) {
        const created = await api('/api/batches', {
          method: 'POST',
          body: { name: `上传批次 ${new Date().toLocaleString('zh-CN', { hour12: false })}` },
        });
        up.batchId = created.id;
        history.replaceState(null, '', `#/?batch=${up.batchId}`);
      }

      const items = up.queue.filter((q) => q.status === 'waiting');
      const audioItems = items.filter((q) => q.ext !== 'zip');
      const zipItems = items.filter((q) => q.ext === 'zip');

      for (const item of zipItems) {
        item.status = 'uploading';
        refreshQueue();
        try {
          const res = await postRaw(`/api/batches/${up.batchId}/zip?name=${encodeURIComponent(item.file.name)}`, item.file, (p) => {
            item.progress = p;
            const bar = view.querySelector(`[data-file-progress="${item.id}"]`);
            if (bar) bar.style.width = `${Math.round(p * 100)}%`;
          });
          item.status = 'done';
          item.progress = 1;
          item.note = `已解压并识别 ${res.added} 个录音${res.skipped.length ? `，跳过 ${res.skipped.length} 个` : ''}`;
          if (res.skipped.length) toast(`压缩包内 ${res.skipped.length} 个文件被跳过`, 'error');
        } catch (err) {
          item.status = 'error';
          item.error = err.message;
        }
        refreshQueue();
      }

      const worker = async () => {
        while (audioItems.length) {
          const item = audioItems.shift();
          item.status = 'uploading';
          refreshQueue();
          try {
            await uploadFile(
              `/api/batches/${up.batchId}/files?name=${encodeURIComponent(item.file.name)}&index=${up.queue.indexOf(item)}`,
              item.file,
              (p) => {
                item.progress = p;
                const bar = view.querySelector(`[data-file-progress="${item.id}"]`);
                if (bar) bar.style.width = `${Math.round(p * 100)}%`;
              },
            );
            item.status = 'done';
            item.progress = 1;
          } catch (err) {
            item.status = 'error';
            item.error = err.message;
          }
          refreshQueue();
        }
      };
      await Promise.all([worker(), worker()]);

      const failed = up.queue.filter((q) => q.status === 'error');
      if (failed.length) {
        toast(`${failed.length} 个文件上传失败，可重试或移除`, 'error');
        up.uploading = false;
        refreshQueue();
        return;
      }
      up.queue = [];
      up.step = 2;
      history.replaceState(null, '', `#/?batch=${up.batchId}`);
      await beginClassify();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      up.uploading = false;
      refreshQueue();
    }
  }

  /* ---------------- 分层识别 ---------------- */

  async function beginClassify({ reset = false } = {}) {
    if (!up.batchId) return;
    up.step = 2;
    up.classify = { status: 'running', message: reset ? '正在重新识别…' : '正在解析文件名与目录结构', summary: null };
    render();
    try {
      await api(`/api/batches/${up.batchId}/classify`, { method: 'POST', body: { reset } });
      startClassifyPolling();
    } catch (err) {
      toast(err.message, 'error');
      up.classify = { status: 'failed', message: err.message };
      renderImport();
    }
  }

  function startClassifyPolling() {
    if (up.classifyPolling) clearInterval(up.classifyPolling);
    up.classifyPolling = setInterval(async () => {
      if (up.destroyed || up.step !== 2) {
        clearInterval(up.classifyPolling);
        up.classifyPolling = null;
        return;
      }
      try {
        const data = await api(`/api/batches/${up.batchId}`);
        up.batch = data.batch;
    up.insights = data.insights || null;
        up.cases = data.cases;
        up.recordings = data.recordings || [];
        up.groups = data.groups || [];
        up.classify = data.classify || up.classify;
        // 用户正在编辑编号时不打断输入，等下一轮再刷新
        const el = document.activeElement;
        const editing = el && el.closest('#step-body') && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
        if (!editing) renderImport();
        if (up.classify?.status === 'running') return;
        clearInterval(up.classifyPolling);
        up.classifyPolling = null;
        if (up.classify?.status === 'failed') {
          toast(up.classify.message || '识别失败', 'error');
          return;
        }
        // 全部归属明确时无需人工确认，直接进入分析
        if (up.groups.length && !up.groups.some((g) => g.needsReview)) {
          await confirmGroups({ auto: true });
        }
      } catch {
        /* 忽略瞬时错误，下一轮重试 */
      }
    }, 1500);
  }

  async function reclassify() {
    const ok = await confirmDialog({
      title: '重新识别',
      message: '将重新解析文件名、目录结构，并对未确定归属的录音重新做内容识别。人工指定过的归属会保留。',
      confirmText: '重新识别',
    });
    if (!ok) return;
    await beginClassify({ reset: true });
  }

  /* ---------------- 第二步：自动识别归类 ---------------- */

  const SOURCE_LABEL = { filename: '文件名', folder: '目录结构', content: '录音内容', manual: '人工指定' };
  const SOURCE_BADGE = { filename: 'badge-gray', folder: 'badge-blue', content: 'badge-teal', manual: 'badge-violet' };

  function stepTwoHtml() {
    const groups = up.groups;
    const totalFiles = groups.reduce((s, g) => s + g.recordings.length, 0);
    const pendingGroups = groups.filter((g) => g.needsReview);
    const autoGroups = groups.filter((g) => !g.needsReview);
    const pendingFiles = pendingGroups.reduce((s, g) => s + g.recordings.length, 0);
    const sources = { filename: 0, folder: 0, content: 0, manual: 0 };
    for (const g of groups) {
      for (const [k, v] of Object.entries(g.sources || {})) sources[k] = (sources[k] || 0) + v;
    }
    const running = up.classify?.status === 'running';
    const codes = groups.map((g) => g.code);
    const sourceText = Object.entries(sources)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${SOURCE_LABEL[k]} ${v}`)
      .join(' · ');

    return `
      <div class="card">
        <div class="card-head">
          <div>
            <h3>${running ? '正在自动识别归类' : '自动识别归类'}</h3>
            <div class="sub">分批解析：文件名 → 压缩包目录结构 → 录音内容；仅无法确定归属的录音才需要人工确认</div>
          </div>
          <div class="row">
            <button class="btn btn-sm" id="reclassify" ${running || !up.batchId ? 'disabled' : ''}>${icon('refresh', 14)}重新识别</button>
            <button class="btn btn-sm btn-primary" id="confirm-groups" ${running || !groups.length ? 'disabled' : ''}>${icon('check')}确认并开始分析</button>
          </div>
        </div>
        <div style="padding:16px">
          ${
            running
              ? `<div class="alert info" style="margin-bottom:14px"><span class="spinner dark"></span><div class="grow"><b>识别进行中</b> —— ${esc(up.classify?.message || '正在解析')}</div></div>`
              : ''
          }
          <div class="row wrap" style="gap:8px;margin-bottom:${pendingGroups.length ? '14px' : '4px'}">
            <span class="badge badge-green">${autoGroups.length} 个案件自动识别</span>
            ${pendingFiles ? `<span class="badge badge-amber">${pendingFiles} 段录音待确认</span>` : '<span class="badge badge-gray">全部录音归属明确</span>'}
            <span class="small muted">共 ${totalFiles} 段录音${sourceText ? ` · ${sourceText}` : ''}</span>
          </div>
          ${
            pendingFiles
              ? `<div class="alert" style="margin-bottom:14px">${icon('alert')}<div>以下 <b>${pendingFiles}</b> 段录音无法自动确定归属${
                  up.classify && up.classify.contentAvailable === false
                    ? '（未配置语音转写或大模型，本次仅按文件名与目录识别）'
                    : ''
                }。补充案件编号即可，其余分组已自动确认。</div></div>`
              : ''
          }
          ${
            pendingGroups.length
              ? `<div class="section-title"><span class="bar"></span>需要确认</div>
                 ${pendingGroups.map((g) => groupHtml(g, groups.indexOf(g), codes, false)).join('')}`
              : ''
          }
          ${
            autoGroups.length
              ? `<div class="section-title" style="margin-top:${pendingGroups.length ? '20px' : '0'}"><span class="bar" style="background:#0f9d58"></span>已自动归类</div>
                 ${autoGroups.map((g) => groupHtml(g, groups.indexOf(g), codes, true)).join('')}`
              : ''
          }
          ${groups.length ? '' : `<div class="empty">${icon('file')}<h4>没有待归类的录音</h4></div>`}
        </div>
      </div>`;
  }

  function groupHtml(group, index, codes, compact) {
    const isPending = group.needsReview;
    const sources = Object.entries(group.sources || {}).filter(([, v]) => v > 0);
    const filesHtml = group.recordings.length
      ? group.recordings.map((r) => recRowHtml(r, index, codes)).join('')
      : `<div class="empty-inline">此分组暂无录音，可从其他分组移入，或删除该分组</div>`;
    return `
      <div class="case-group" data-group="${index}" style="${isPending ? 'border-color:#f7ddb8;background:#fffdf8' : ''}">
        <div class="cg-head">
          <div class="avatar">${icon('folder', 15)}</div>
          <div style="width:170px">
            <input class="code-input" data-group-code="${index}" value="${esc(group.code)}" placeholder="案件编号" />
          </div>
          <div class="row" style="gap:6px">
            <span class="small muted">理赔专员工号</span>
            <input class="emp-input" data-group-emp="${index}" value="${esc(group.employeeId || '')}" placeholder="工号" style="width:90px" />
          </div>
          <span class="badge ${isPending ? 'badge-amber' : 'badge-green'}">${isPending ? '待确认' : '已自动确认'}</span>
          <span class="badge badge-gray">${group.recordings.length} 段</span>
          ${sources.map(([k, v]) => `<span class="badge ${SOURCE_BADGE[k] || 'badge-gray'}">${SOURCE_LABEL[k]} ${v}</span>`).join('')}
          <div class="grow"></div>
          ${up.groups.length > 1 ? `<button class="btn btn-ghost btn-sm" data-del-group="${index}">${icon('trash', 13)}移除</button>` : ''}
        </div>
        ${
          group.candidates?.length
            ? `<div class="row wrap" style="padding:6px 16px 2px;gap:6px">
                 <span class="small muted">可能是：</span>
                 ${group.candidates
                   .map(
                     (c) =>
                       `<button class="chip" data-cand="${esc(c.code)}" data-cand-group="${index}">${esc(c.code)}${c.reason ? ` · ${esc(c.reason)}` : ''}</button>`,
                   )
                   .join('')}
               </div>`
            : ''
        }
        ${
          compact
            ? `<details class="cg-files" style="padding:0 16px 8px"><summary class="small muted" style="cursor:pointer;padding:6px 0">查看 ${group.recordings.length} 段录音</summary>${filesHtml}</details>`
            : `<div class="cg-files">${filesHtml}</div>`
        }
        ${
          group.warnings?.length
            ? `<div style="padding:4px 16px 10px"><div class="small muted">识别提示：${group.warnings.map((w) => esc(w)).join('；')}</div></div>`
            : ''
        }
      </div>`;
  }

  function recRowHtml(r, index, codes) {
    const srcBadge = r.matchSource
      ? `<span class="badge ${SOURCE_BADGE[r.matchSource] || 'badge-gray'}">${SOURCE_LABEL[r.matchSource] || ''}</span>`
      : '';
    const hint = r.hints?.customerDemand || r.hints?.accidentSummary || '';
    return `
      <div class="cg-file" data-rec="${r.id}">
        <div class="file-ico" style="width:26px;height:26px;font-size:9px">${esc((r.filename.split('.').pop() || '').slice(0, 4))}</div>
        <div class="grow" style="min-width:0">
          <div class="fname" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.filename)}</div>
          ${
            r.folderPath
              ? `<div class="small muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">目录：${esc(r.folderPath)}</div>`
              : ''
          }
          ${hint ? `<div class="small muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">识别：${esc(hint)}</div>` : ''}
        </div>
        ${srcBadge}
        <span class="tag">${esc(r.recDate || '日期未知')}</span>
        <span class="tag">${esc(r.recType || '类型未识别')}</span>
        <span class="muted small mono">${r.duration ? fmtDuration(r.duration) : fmtSize(r.size)}</span>
        <select data-move-rec="${r.id}" data-from="${index}">
          <option value="">归属：${esc(up.groups[index].code)}</option>
          ${codes
            .map((code, ci) => (ci === index ? '' : `<option value="${ci}">移至 ${esc(code)}</option>`))
            .join('')}
        </select>
        <button class="btn btn-ghost btn-icon btn-sm" data-del-rec="${r.id}" title="删除录音">${icon('trash', 14)}</button>
      </div>`;
  }

  /* ---------------- 第三步：处理进度 ---------------- */

  function stepThreeHtml() {
    const total = up.cases.length;
    const finished = up.cases.filter((c) => c.status === 'ready').length;
    const failed = up.cases.filter((c) => c.status === 'failed').length;
    const allDone = total > 0 && finished + failed === total;
    return `
      ${allDone ? doneBanner(finished, failed) : ''}
      <div class="card">
        <div class="card-head">
          <div>
            <h3>案件处理进度</h3>
            <div class="sub">${up.batch ? esc(up.batch.name) : ''} · ${total} 个案件 · 共 ${up.cases.reduce((s, c) => s + (c.recordingCount || 0), 0)} 段录音</div>
          </div>
          <div class="row">
            <span class="badge badge-green">${finished} 已完成</span>
            ${failed ? `<span class="badge badge-red">${failed} 失败</span>` : ''}
            <button class="btn btn-sm" data-view-results>回首页查看案件</button>
          </div>
        </div>
        <div>
          ${
            up.cases.length
              ? up.cases.map(caseProgressRow).join('')
              : `<div class="empty">${icon('clock')}<h4>正在创建案件…</h4></div>`
          }
        </div>
      </div>
      ${insightsHtml()}
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h3>本批次录音</h3><span class="small muted">共 ${up.recordings?.length || 0} 个文件</span></div>
        <div class="file-list">
          ${(up.recordings || [])
            .map(
              (r) => `
            <div class="file-item">
              <div class="file-ico">${esc((r.format || '').slice(0, 4))}</div>
              <div class="grow">
                <div class="file-name">${esc(r.filename)}</div>
                <div class="small muted">${esc(r.rec_type || '类型未知')} · ${esc(r.rec_date || '日期未知')} · ${fmtDuration(r.duration)}</div>
              </div>
              ${statusBadge(r.status)}
              ${r.error ? `<span class="small" style="color:#d92d20;max-width:280px">${esc(r.error)}</span>` : ''}
            </div>`,
            )
            .join('')}
        </div>
      </div>`;
  }

  function caseProgressRow(c) {
    const job = c.job || {};
    const progress = c.status === 'ready' ? 100 : job.progress || (c.status === 'processing' ? 10 : 0);
    const statusText = {
      queued: '排队中',
      processing: job.message || '分析中',
      ready: '分析完成',
      failed: c.error || '处理失败',
      pending: '待分析',
    }[c.status] || c.status;
    return `
      <div class="list-row" style="align-items:flex-start;padding:15px 20px">
        <div class="avatar ${c.status === 'failed' ? 'amber' : c.status === 'ready' ? 'teal' : ''}">
          ${c.status === 'ready' ? icon('check', 15) : c.status === 'failed' ? icon('alert', 15) : '<span class="spinner dark" style="width:13px;height:13px"></span>'}
        </div>
        <div class="grow">
          <div class="row between">
            <div class="row">
              <span class="main-txt">${esc(c.code)}</span>
              <span class="small muted">理赔专员 ${esc(c.employeeId || '—')} · ${c.recordingCount} 段录音</span>
            </div>
            <a class="link small" href="#/cases/${c.id}">查看分析 →</a>
          </div>
          <div class="progress ${c.status === 'ready' ? 'green' : c.status === 'failed' ? 'amber' : ''}" style="margin-top:8px">
            <i style="width:${c.status === 'failed' && progress < 100 ? Math.max(progress, 8) : progress}%"></i>
          </div>
          <div class="row between" style="margin-top:5px">
            <span class="small ${c.status === 'failed' ? '' : 'muted'}" style="${c.status === 'failed' ? 'color:#d92d20' : ''}">${esc(statusText)}</span>
            <div class="row" style="gap:8px">
              ${c.status === 'failed' ? `<button class="btn btn-sm" data-retry-case="${c.id}">${icon('refresh', 12)}重新处理</button>` : ''}
              <span class="small muted mono">${progress}%</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  /* ---------------- 批量业务洞察 ---------------- */

  function insightsHtml() {
    const ins = up.insights;
    if (!ins || !ins.analyzedCases) return '';
    const maxType = Math.max(1, ...(ins.byType || []).map((t) => t.count));
    const emotions = (ins.emotions || []).slice(0, 5);
    const painPoints = [...(ins.dissatisfactions || []), ...(ins.triggers || [])].slice(0, 5);
    return `
      <div class="card" style="margin-top:16px" id="batch-insights">
        <div class="card-head">
          <div>
            <h3>批量业务洞察</h3>
            <div class="sub">本批次 ${ins.analyzedCases}/${ins.totalCases} 个已分析案件 · 以客户诉求为口径汇总，不新建独立报表</div>
          </div>
          <div class="row wrap" style="gap:6px">
            <span class="badge badge-blue">${ins.claimCount} 条客户诉求</span>
            ${ins.escalationCount ? `<span class="badge badge-amber">${ins.escalationCount} 项升级信号</span>` : ''}
            ${ins.pendingCount ? `<span class="badge badge-gray">${ins.pendingCount} 项待核实</span>` : ''}
          </div>
        </div>
        <div class="insight-body">
          <div class="insight-grid">
            <div class="insight-box">
              <div class="dc-mini-title">诉求类型分布</div>
              ${
                (ins.byType || []).length
                  ? ins.byType
                      .map(
                        (t) => `<div class="insight-bar">
                          <span class="ib-label">${esc(t.label)}</span>
                          <i><b style="width:${Math.round((t.count / maxType) * 100)}%"></b></i>
                          <em>${t.count}</em>
                        </div>`,
                      )
                      .join('')
                  : '<span class="muted-text">暂无数据</span>'
              }
              ${
                emotions.length
                  ? `<div class="row wrap" style="gap:5px;margin-top:9px">${emotions
                      .map((e) => `<span class="badge badge-violet">${esc(e.label)} · ${e.count}</span>`)
                      .join('')}</div>`
                  : ''
              }
            </div>
            <div class="insight-box">
              <div class="dc-mini-title">高频不满与触发点</div>
              ${
                painPoints.length
                  ? `<ul class="bullets">${painPoints
                      .map((p) => `<li>${esc(p.text)}<span class="quote">${p.count} 次${p.cases?.length ? ` · ${esc(p.cases.join('、'))}` : ''}</span></li>`)
                      .join('')}</ul>`
                  : '<span class="muted-text">未识别到集中性不满</span>'
              }
            </div>
          </div>

          <div class="insight-grid">
            <div class="insight-box">
              <div class="dc-mini-title">投诉升级信号</div>
              ${
                (ins.escalations || []).length
                  ? `<ul class="bullets">${ins.escalations
                      .map(
                        (e) => `<li><span class="badge badge-${e.level === '紧急' ? 'red' : e.level === '预警' ? 'amber' : 'gray'}" style="margin-right:5px">${esc(
                          e.level,
                        )}</span>${esc(e.text)}<a class="link small" href="#/cases/${e.caseId}">${esc(e.caseCode)}</a></li>`,
                      )
                      .join('')}</ul>`
                  : '<span class="muted-text">本批次暂未发现明显升级信号</span>'
              }
            </div>
            <div class="insight-box">
              <div class="dc-mini-title">集中待核实事项</div>
              ${
                (ins.pending || []).length
                  ? `<ul class="bullets">${ins.pending
                      .slice(0, 6)
                      .map(
                        (p) => `<li>${esc(p.text)}<a class="link small" href="#/cases/${p.caseId}">${esc(p.caseCode)}</a>${
                          p.reason ? `<span class="quote">${esc(p.reason)}</span>` : ''
                        }</li>`,
                      )
                      .join('')}</ul>`
                  : '<span class="muted-text">暂无待核实事项</span>'
              }
            </div>
          </div>

          <div class="insight-box" style="margin-top:12px">
            <div class="dc-mini-title">可复用的处理建议</div>
            ${
              (ins.advice || []).length
                ? `<ul class="bullets">${ins.advice
                    .slice(0, 6)
                    .map(
                      (a) => `<li>${a.priority ? `<span class="badge badge-${a.priority === '高' ? 'red' : a.priority === '低' ? 'gray' : 'amber'}" style="margin-right:5px">${esc(
                        a.priority,
                      )}</span>` : ''}${esc(a.text)}<a class="link small" href="#/cases/${a.caseId}">${esc(a.caseCode)}</a>${
                        a.basis ? `<span class="basis-tag">${esc(a.basis)}</span>` : ''
                      }</li>`,
                    )
                    .join('')}</ul>`
                : '<span class="muted-text">暂无建议</span>'
            }
          </div>
        </div>
      </div>`;
  }

  function doneBanner(finished, failed) {
    return `<div class="card card-pad" style="margin-bottom:16px;border-color:#c6ecd6;background:linear-gradient(120deg,#f2fbf6,#fff)">
      <div class="row between wrap">
        <div class="row">
          <div class="avatar teal" style="width:40px;height:40px">${icon('check', 20)}</div>
          <div>
            <div style="font-weight:600;font-size:15px">本批次处理完成：${finished} 个案件已生成报告${failed ? `，${failed} 个失败` : ''}</div>
            <div class="small muted">点击「查看分析结果」回到首页案件列表，点击案件即可查看报告，并可在案件详情的「AI 问答」中继续追问</div>
          </div>
        </div>
        <div class="row">
          <button class="btn" data-new-upload>${icon('plus')}导入新录音</button>
          <button class="btn btn-primary" data-view-results>查看分析结果</button>
        </div>
      </div>
    </div>`;
  }

  /* ---------------- 最近上传批次 ---------------- */

  async function renderHistory() {
    const holder = view.querySelector('#history');
    if (!holder) return;
    let batches = [];
    try {
      batches = (await api('/api/batches')).batches;
    } catch {
      return;
    }
    if (!batches.length) {
      holder.innerHTML = '';
      return;
    }
    holder.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>最近上传批次</h3><span class="small muted">可回溯每次上传的文件与自动识别的案件</span></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>批次</th><th>文件</th><th>案件</th><th>状态</th><th>上传时间</th><th></th></tr></thead>
            <tbody>
              ${batches
                .map(
                  (b) => `
                <tr>
                  <td class="strong">${esc(b.name)}</td>
                  <td class="mono">${b.file_count}</td>
                  <td class="mono">${b.case_count}</td>
                  <td>${statusBadge(b.status)}${b.failed_count ? ` <span class="badge badge-red">${b.failed_count} 失败</span>` : ''}</td>
                  <td class="muted small">${fmtDateTime(b.created_at)}</td>
                  <td>
                    <div class="actions">
                      ${
                        b.status === 'confirmed'
                          ? `<a class="btn btn-sm" href="#/?batch=${b.id}">进度</a>`
                          : `<button class="btn btn-sm" data-open-batch="${b.id}">继续确认</button>`
                      }
                      <button class="btn btn-sm btn-danger" data-del-batch="${b.id}">${icon('trash', 13)}</button>
                    </div>
                  </td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  /* ---------------- 绑定：导入向导 ---------------- */

  function bindStep() {
    const body = view.querySelector('#step-body');
    if (up.step === 1) {
      body.innerHTML = stepOneHtml();
      const drop = body.querySelector('#dropzone');
      const fileInput = body.querySelector('#file-input');
      const zipInput = body.querySelector('#zip-input');
      drop.onclick = (e) => {
        if (e.target.closest('#pick-zip')) return;
        if (e.target.closest('button')) return;
        fileInput.click();
      };
      body.querySelector('#pick-files').onclick = (e) => {
        e.stopPropagation();
        fileInput.click();
      };
      body.querySelector('#pick-zip').onclick = (e) => {
        e.stopPropagation();
        zipInput.click();
      };
      fileInput.onchange = () => {
        addFiles(fileInput.files);
        fileInput.value = '';
      };
      zipInput.onchange = () => {
        addFiles(zipInput.files);
        zipInput.value = '';
      };
      ['dragenter', 'dragover'].forEach((evt) =>
        drop.addEventListener(evt, (e) => {
          e.preventDefault();
          drop.classList.add('drag');
        }),
      );
      ['dragleave', 'drop'].forEach((evt) =>
        drop.addEventListener(evt, (e) => {
          e.preventDefault();
          drop.classList.remove('drag');
        }),
      );
      drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
      refreshQueue();
      body.onclick = async (e) => {
        const startBtn = e.target.closest('#start-upload');
        if (startBtn) return startUpload();
        const clearBtn = e.target.closest('#clear-queue');
        if (clearBtn && !up.uploading) {
          up.queue = [];
          refreshQueue();
          return;
        }
        const rm = e.target.closest('[data-remove]');
        if (rm && !up.uploading) {
          up.queue = up.queue.filter((q) => q.id !== rm.dataset.remove);
          refreshQueue();
        }
      };
    } else if (up.step === 2) {
      body.innerHTML = stepTwoHtml();
      body.onclick = async (e) => {
        if (e.target.closest('#reclassify')) return reclassify();
        const cand = e.target.closest('[data-cand]');
        if (cand) return applyCandidate(Number(cand.dataset.candGroup), cand.dataset.cand);
        const delGroup = e.target.closest('[data-del-group]');
        if (delGroup) {
          const idx = Number(delGroup.dataset.delGroup);
          const group = up.groups[idx];
          if (group.recordings.length) {
            toast('该分组下仍有录音，请先移出或删除录音', 'error');
            return;
          }
          up.groups.splice(idx, 1);
          bindStep();
          return;
        }
        const delRec = e.target.closest('[data-del-rec]');
        if (delRec) {
          const ok = await confirmDialog({
            title: '删除录音',
            message: '将从本批次中删除该录音文件，操作不可恢复。',
            confirmText: '删除',
            danger: true,
          });
          if (!ok) return;
          try {
            await api(`/api/recordings/${delRec.dataset.delRec}`, { method: 'DELETE' });
            up.groups = up.groups.map((g) => ({
              ...g,
              recordings: g.recordings.filter((r) => r.id !== delRec.dataset.delRec),
            }));
            bindStep();
          } catch (err) {
            toast(err.message, 'error');
          }
          return;
        }
        if (e.target.closest('#confirm-groups')) return confirmGroups();
      };
      body.oninput = (e) => {
        if (e.target.matches('[data-group-code]')) {
          const gi = Number(e.target.dataset.groupCode);
          up.groups[gi].code = e.target.value;
          up.groups[gi].needsReview = !e.target.value.trim();
        }
        if (e.target.matches('[data-group-emp]')) {
          up.groups[Number(e.target.dataset.groupEmp)].employeeId = e.target.value;
        }
      };
      body.onchange = (e) => {
        const sel = e.target.closest('[data-move-rec]');
        if (!sel || sel.value === '') return;
        const recId = sel.dataset.moveRec;
        const from = Number(sel.dataset.from);
        const to = Number(sel.value);
        const rec = up.groups[from].recordings.find((r) => r.id === recId);
        if (!rec) return;
        up.groups[from].recordings = up.groups[from].recordings.filter((r) => r.id !== recId);
        up.groups[to].recordings.push({ ...rec, needsReview: false, matchSource: 'manual', matchConfidence: 'high' });
        // 目标分组已有明确编号时持久化，刷新后仍保持
        const targetCode = up.groups[to].autoCode;
        if (targetCode) {
          api(`/api/recordings/${recId}/assign`, { method: 'POST', body: { code: targetCode } }).catch(() => {});
        }
        bindStep();
      };
    } else {
      body.innerHTML = stepThreeHtml();
      body.onclick = async (e) => {
        const retry = e.target.closest('[data-retry-case]');
        if (retry) {
          try {
            await api(`/api/cases/${retry.dataset.retryCase}/analyze`, { method: 'POST' });
            toast('已重新提交分析', 'success');
          } catch (err) {
            toast(err.message, 'error');
          }
          return;
        }
        if (e.target.closest('[data-scroll-cases]') || e.target.closest('[data-view-results]')) {
          /* 向导模式下案件列表在首页，退出向导后定位到案件列表 */
          exitWizard();
          setTimeout(() => view.querySelector('#wb-cases')?.scrollIntoView({ behavior: 'smooth' }), 60);
          return;
        }
        if (e.target.closest('[data-new-upload]')) return resetForNewUpload();
      };
      if (!up.polling) startPolling();
    }

    const historyEl = view.querySelector('#history');
    if (historyEl) historyEl.onclick = onHistoryClick;
  }

  async function onHistoryClick(e) {
    const open = e.target.closest('[data-open-batch]');
    if (open) {
      location.hash = `#/?batch=${open.dataset.openBatch}`;
      return;
    }
    const del = e.target.closest('[data-del-batch]');
    if (del) {
      const ok = await confirmDialog({
        title: '删除上传批次',
        message: '将删除该批次下的录音文件、案件与分析报告，且不可恢复。',
        confirmText: '删除批次',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/batches/${del.dataset.delBatch}`, { method: 'DELETE' });
        toast('批次已删除', 'success');
        if (up.batchId && up.batchId === del.dataset.delBatch) {
          exitWizard();
        } else {
          renderHistory();
          loadCases();
        }
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  }

  /* 开始一次新的导入：清空当前向导状态并回到首页上传区 */
  function resetForNewUpload() {
    exitWizard();
  }

  /* 采纳候选案件编号：合并进已有分组，或直接设为该分组编号 */
  function applyCandidate(index, code) {
    const group = up.groups[index];
    if (!group) return;
    const target = up.groups.findIndex((g, i) => i !== index && (g.autoCode || g.code) === code);
    if (target >= 0) {
      up.groups[target].recordings.push(
        ...group.recordings.map((r) => ({ ...r, needsReview: false, matchSource: 'manual', matchConfidence: 'high' })),
      );
      up.groups.splice(index, 1);
      group.recordings.forEach((r) => {
        api(`/api/recordings/${r.id}/assign`, { method: 'POST', body: { code } }).catch(() => {});
      });
    } else {
      group.code = code;
      group.autoCode = code;
      group.needsReview = false;
      group.confidence = 'medium';
      group.candidates = [];
      group.recordings.forEach((r) => {
        r.needsReview = false;
        r.matchSource = 'manual';
        api(`/api/recordings/${r.id}/assign`, { method: 'POST', body: { code } }).catch(() => {});
      });
    }
    bindStep();
  }

  async function confirmGroups({ auto = false } = {}) {
    const groups = up.groups.filter((g) => g.recordings.length);
    if (!groups.length) {
      toast('至少需要一个包含录音的案件分组', 'error');
      return;
    }
    const codes = groups.map((g) => g.code.trim());
    if (codes.some((c) => !c)) {
      toast('还有分组缺少案件编号，请补充后再确认', 'error');
      return;
    }
    if (new Set(codes.map((c) => c.toUpperCase())).size !== codes.length) {
      toast('案件编号不能重复', 'error');
      return;
    }
    if (!auto && !up.cases.length) {
      const ok = await confirmDialog({
        title: '确认并开始分析',
        message: `即将对 ${groups.length} 个案件、${groups.reduce((s, g) => s + g.recordings.length, 0)} 段录音执行转写、案件分析与报告生成，过程中可离开此页面。`,
        confirmText: '开始分析',
      });
      if (!ok) return;
    }
    try {
      const res = await api(`/api/batches/${up.batchId}/confirm`, {
        method: 'POST',
        body: { groups: groups.map((g) => ({ code: g.code, employeeId: g.employeeId, recordingIds: g.recordings.map((r) => r.id) })) },
      });
      up.step = 3;
      up.cases = res.cases.map((c) => ({ ...c, status: 'queued', job: { progress: 0, message: '排队中' }, recordingCount: 0 }));
      history.replaceState(null, '', `#/?batch=${up.batchId}`);
      render();
      loadCases();
      toast(
        auto ? `全部录音归属已自动确定，${res.cases.length} 个案件开始分析` : `已提交 ${res.cases.length} 个案件，正在处理`,
        'success',
      );
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function startPolling() {
    if (up.polling) clearInterval(up.polling);
    up.polling = setInterval(async () => {
      if (up.destroyed || up.step !== 3) return;
      try {
        const data = await api(`/api/batches/${up.batchId}`);
        up.cases = data.cases;
        up.recordings = data.recordings;
        up.batch = data.batch;
    up.insights = data.insights || null;
        const allDone = up.cases.length > 0 && up.cases.every((c) => c.status === 'ready' || c.status === 'failed');
        const body = view.querySelector('#step-body');
        if (body && up.step === 3) body.innerHTML = stepThreeHtml();
        if (allDone) {
          clearInterval(up.polling);
          up.polling = null;
          renderHistory();
          loadCases();
        }
      } catch {
        /* ignore transient errors */
      }
    }, 2500);
  }

  /* ---------------- 案件列表 ---------------- */

  async function loadCases() {
    try {
      const data = await api(`/api/cases${keyword ? `?q=${encodeURIComponent(keyword)}` : ''}`);
      all = data.cases;
      renderCases();
    } catch {
      /* 轮询过程中的瞬时错误忽略 */
    }
  }

  function filtered() {
    const f = FILTERS.find((x) => x.key === filter) || FILTERS[0];
    return all.filter(f.match);
  }

  function renderCases() {
    const holder = view.querySelector('#wb-cases');
    if (!holder) return;
    const list = filtered();
    const counts = Object.fromEntries(FILTERS.map((f) => [f.key, all.filter(f.match).length]));
    const rows = list
      .map(
        (c) => `
      <tr data-case="${c.id}" style="cursor:pointer">
        <td>
          <div class="strong">${esc(c.code)}</div>
          <div class="small muted">${c.recordingCount || 0} 段录音 · ${fromNow(c.updatedAt)}</div>
        </td>
        <td>${esc(c.employeeId || '—')}</td>
        <td class="muted small">${c.recordingCount || 0} 段 · ${fmtDuration(c.duration)}</td>
        <td class="muted small" style="max-width:320px">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.summary || '—')}</div>
        </td>
        <td>${c.claimCount ? `<span class="badge badge-blue">${c.claimCount} 条</span>${c.escalationCount ? `<span class="badge badge-amber" style="margin-left:4px">${c.escalationCount} 升级</span>` : ''}` : '<span class="muted small">—</span>'}</td>
        <td>${statusBadge(c.status)}${
          c.status === 'failed' && c.error
            ? `<div class="small" style="color:#d92d20;max-width:240px;margin-top:2px">${esc(c.error)}</div>`
            : ''
        }</td>
        <td class="muted small">${c.analysisAt ? fromNow(c.analysisAt) : '—'}</td>
        <td>
          <div class="actions">
            <button class="btn btn-sm" data-open="${c.id}">查看分析</button>
            <button class="btn btn-sm btn-ghost" data-analyze="${c.id}" title="重新分析">${icon('refresh', 13)}</button>
            <button class="btn btn-sm btn-ghost" data-del="${c.id}" title="删除">${icon('trash', 13)}</button>
          </div>
        </td>
      </tr>`,
      )
      .join('');

    holder.innerHTML = `
      <div class="card">
        <div class="row between wrap" style="padding:14px 18px;gap:12px;border-bottom:1px solid var(--line)">
          <div class="row wrap">
            <h3 style="margin:0;font-size:15px">案件分析</h3>
            ${FILTERS.map(
              (f) => `
              <button class="chip ${filter === f.key ? 'active' : ''}" data-filter="${f.key}" style="${
                filter === f.key ? 'background:#eef2ff;border-color:#c9d7ff;color:#1f45d8;font-weight:600' : ''
              }">${f.label} <span style="opacity:.6">${counts[f.key]}</span></button>`,
            ).join('')}
          </div>
          <div class="row" style="gap:8px;min-width:280px">
            <div style="position:relative;flex:1">
              <span style="position:absolute;left:10px;top:9px;color:#98a2b3">${icon('search', 15)}</span>
              <input class="input" id="case-search" placeholder="搜索案件编号 / 理赔专员工号" value="${esc(keyword)}" style="padding-left:32px" />
            </div>
            <button class="btn btn-icon" id="case-refresh" title="刷新">${icon('refresh', 15)}</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th style="width:22%">案件编号</th>
              <th>理赔专员</th>
              <th>录音</th>
              <th>核心诉求摘要</th>
              <th style="width:110px">客户诉求</th>
              <th style="width:120px">状态</th>
              <th>分析时间</th>
              <th style="width:190px"></th>
            </tr></thead>
            <tbody>${rows || `<tr><td colspan="8"><div class="empty">${icon('message')}<h4>还没有分析案件</h4><p>${
              all.length ? '试试切换筛选条件或清空搜索' : '通过上方「导入录音」上传理赔沟通录音，系统会自动识别案件并生成综合分析报告'
            }</p></div></td></tr>`}</tbody>
          </table>
        </div>
      </div>`;

    bindCases();
  }

  function bindCases() {
    const holder = view.querySelector('#wb-cases');
    if (!holder) return;
    holder.querySelectorAll('[data-filter]').forEach((btn) => {
      btn.onclick = () => {
        filter = btn.dataset.filter;
        renderCases();
      };
    });
    const search = holder.querySelector('#case-search');
    search.oninput = () => {
      keyword = search.value.trim();
      clearTimeout(search._t);
      search._t = setTimeout(() => loadCases(), 280);
    };
    holder.querySelector('#case-refresh').onclick = () => loadCases();
    holder.querySelectorAll('tr[data-case]').forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.closest('button')) return;
        location.hash = `#/cases/${tr.dataset.case}`;
      };
    });
    holder.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = () => (location.hash = `#/cases/${b.dataset.open}`);
    });
    holder.querySelectorAll('[data-analyze]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/api/cases/${b.dataset.analyze}/analyze`, { method: 'POST' });
          toast('已提交重新分析，稍后刷新查看结果', 'success');
          setTimeout(() => loadCases(), 1200);
        } catch (err) {
          toast(err.message, 'error');
        }
      };
    });
    holder.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const ok = await confirmDialog({
          title: '删除案件',
          message: '将删除该案件下的录音文件、分析报告与问答记录，操作不可恢复。',
          confirmText: '删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await api(`/api/cases/${b.dataset.del}`, { method: 'DELETE' });
          toast('案件已删除', 'success');
          loadCases();
        } catch (err) {
          toast(err.message, 'error');
        }
      };
    });
  }

  await init();

  return () => {
    up.destroyed = true;
    if (up.polling) clearInterval(up.polling);
    if (up.classifyPolling) clearInterval(up.classifyPolling);
    if (casesTimer) clearInterval(casesTimer);
  };
}
