import { api, esc, icon, toast, confirmDialog, openModal, fmtSize, fmtDateTime } from '../lib.js?v=7';

export default async function knowledge(view, ctx) {
  let docs = [];
  let stats = { docs: 0, chunks: 0 };
  let embed = false;
  let hits = null;
  let searching = false;

  ctx.setActions(`
    <button class="btn" id="paste-btn">${icon('file')}粘贴文本</button>
    <a class="btn btn-primary" href="#/">${icon('dashboard')}返回工作台</a>
  `);
  document.getElementById('paste-btn').onclick = () => pasteDialog();

  async function load() {
    const data = await api('/api/kb/docs');
    docs = data.docs;
    stats = data.stats;
    embed = data.embed;
    render();
  }

  function render() {
    const ready = docs.filter((d) => d.status === 'ready').length;
    view.innerHTML = `
      <div class="stats" style="margin-bottom:16px">
        <div class="stat">
          <div class="label">${icon('book', 13)} 知识文档</div>
          <div class="value">${stats.docs}<small>份</small></div>
          <div class="foot">${docs.length - ready ? `${docs.length - ready} 份处理失败` : '全部可检索'}</div>
        </div>
        <div class="stat">
          <div class="label">${icon('layers', 13)} 知识片段</div>
          <div class="value">${stats.chunks}<small>个</small></div>
          <div class="foot">按语义段落切分，供问答检索</div>
        </div>
        <div class="stat">
          <div class="label">${icon('search', 13)} 检索方式</div>
          <div class="value" style="font-size:18px">${embed ? '向量 + 关键词' : '关键词 BM25'}</div>
          <div class="foot">${embed ? '已启用向量检索，召回更准确' : '配置 Embedding 后可启用语义向量检索'}</div>
        </div>
        <div class="stat">
          <div class="label">${icon('shieldCheck', 13)} 引用约束</div>
          <div class="value" style="font-size:18px">强制标注来源</div>
          <div class="foot">无依据时提示「未找到相关规定」</div>
        </div>
      </div>

      <div class="kb-grid">
        <div class="stack">
          <div class="card">
            <div class="card-head">
              <div><h3>知识文档</h3><div class="sub">上传保险条款、理赔制度、操作手册、沟通话术</div></div>
              <div class="row">
                <span class="small muted">支持 PDF / DOCX / TXT / Markdown</span>
              </div>
            </div>
            <div style="padding:14px 16px 0">
              <div class="dropzone" id="kb-drop" style="padding:22px">
                <div class="dz-icon" style="width:42px;height:42px">${icon('upload', 21)}</div>
                <h3 style="font-size:14px">拖拽文档到此处，或点击选择</h3>
                <p style="margin-bottom:10px">系统会自动提取正文、按章节切分并建立检索索引</p>
                <button class="btn btn-sm btn-primary" id="kb-pick">${icon('plus')}选择文档</button>
                <input type="file" id="kb-input" multiple accept=".pdf,.docx,.txt,.md,.markdown" hidden />
              </div>
              <div id="kb-progress" style="margin-top:10px"></div>
            </div>
            <div class="table-wrap" style="margin-top:12px">
              <table class="table">
                <thead><tr><th>文档名称</th><th>类型</th><th>大小</th><th>片段</th><th>状态</th><th>上传时间</th><th></th></tr></thead>
                <tbody>
                  ${
                    docs.length
                      ? docs
                          .map(
                            (d) => `
                    <tr>
                      <td>
                        <div class="row" style="gap:8px">
                          <div class="file-ico" style="width:26px;height:26px;font-size:9px">${esc((d.ext || '').toUpperCase().slice(0, 4))}</div>
                          <div>
                            <div class="strong" style="font-size:12.5px">${esc(d.name)}</div>
                            ${d.error ? `<div class="small" style="color:#b54708;max-width:420px">${esc(d.error)}</div>` : ''}
                          </div>
                        </div>
                      </td>
                      <td class="muted small">${esc((d.ext || '').toUpperCase())}</td>
                      <td class="muted small mono">${fmtSize(d.size)}</td>
                      <td class="mono">${d.chunks || '—'}</td>
                      <td>
                        ${
                          d.status === 'ready'
                            ? '<span class="badge badge-green">可检索</span>'
                            : d.status === 'failed'
                              ? '<span class="badge badge-red">失败</span>'
                              : '<span class="badge badge-blue"><i class="dot on badge-dot-pulse"></i>处理中</span>'
                        }
                      </td>
                      <td class="muted small">${fmtDateTime(d.created_at)}</td>
                      <td>
                        <div class="actions">
                          <button class="btn btn-sm btn-ghost" data-view-doc="${d.id}">片段</button>
                          <button class="btn btn-sm btn-ghost" data-del-doc="${d.id}">${icon('trash', 13)}</button>
                        </div>
                      </td>
                    </tr>`,
                          )
                          .join('')
                      : `<tr><td colspan="7"><div class="empty">${icon('book')}<h4>知识库还是空的</h4><p>上传企业内部保险条款、理赔制度与操作手册，案件分析与 AI 助手会优先依据这些资料回答业务问题</p><button class="btn btn-primary btn-sm" id="kb-empty-pick">上传第一份文档</button></div></td></tr>`
                  }
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h3>检索测试</h3><div class="sub">验证知识库是否能命中可靠依据</div></div></div>
            <div style="padding:16px">
              <div class="search-box">
                <input class="input" id="kb-query" placeholder="例如：客户对定损金额有异议怎么处理" />
                <button class="btn btn-primary" id="kb-search-btn">${icon('search')}检索</button>
              </div>
              <div id="kb-results" style="margin-top:14px">
                ${
                  hits === null
                    ? `<div class="empty" style="padding:20px">${icon('search')}<p style="margin:0">输入问题，测试知识库召回效果</p></div>`
                    : hits.length
                      ? hits
                          .map(
                            (h) => `
                        <div class="search-hit">
                          <div class="sh-head">
                            <span class="badge badge-teal">${esc(h.docName)}</span>
                            ${h.title && h.title !== h.docName ? `<span class="small muted">${esc(h.title)}</span>` : ''}
                            <span class="score">相关度 ${h.score}</span>
                          </div>
                          <div class="sh-text">${esc(h.text)}</div>
                        </div>`,
                          )
                          .join('')
                      : `<div class="empty" style="padding:20px">${icon('alert')}<p style="margin:0">没有命中内容，说明知识库缺少相关资料，AI 会如实提示无依据</p></div>`
                }
              </div>
            </div>
          </div>

          <div class="card card-pad">
            <div class="section-title"><span class="bar"></span>知识库使用说明</div>
            <div class="small" style="color:#475467;line-height:1.85">
              <p style="margin:0 0 8px">1. 案件分析与 AI 助手会先检索本知识库，命中片段会作为「规范依据」注入上下文。</p>
              <p style="margin:0 0 8px">2. 回答中引用知识库时标注【知识库：文档名】，可在对话右侧查看原文片段。</p>
              <p style="margin:0 0 8px">3. 未检索到依据时，助手必须说明「知识库中未找到相关规定」，不得编造公司制度。</p>
              <p style="margin:0 0 8px">4. 企业正式制度与保险条款优先作为业务判断依据，行业经验只能作为补充建议。</p>
              <p style="margin:0">5. 建议上传现行有效的条款与制度，并在文件名中体现版本与生效日期。</p>
            </div>
          </div>
        </div>
      </div>`;

    bind();
  }

  function bind() {
    const drop = view.querySelector('#kb-drop');
    const input = view.querySelector('#kb-input');
    drop.onclick = (e) => {
      if (e.target.closest('button')) return;
      input.click();
    };
    view.querySelector('#kb-pick').onclick = (e) => {
      e.stopPropagation();
      input.click();
    };
    view.querySelector('#kb-empty-pick')?.addEventListener('click', () => input.click());
    input.onchange = () => {
      uploadDocs([...input.files]);
      input.value = '';
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
    drop.addEventListener('drop', (e) => uploadDocs([...e.dataTransfer.files]));

    view.querySelectorAll('[data-view-doc]').forEach((btn) => {
      btn.onclick = () => showDoc(btn.dataset.viewDoc);
    });
    view.querySelectorAll('[data-del-doc]').forEach((btn) => {
      btn.onclick = async () => {
        const ok = await confirmDialog({ title: '删除文档', message: '将同时删除该文档的全部检索片段。', confirmText: '删除', danger: true });
        if (!ok) return;
        try {
          await api(`/api/kb/docs/${btn.dataset.delDoc}`, { method: 'DELETE' });
          toast('文档已删除', 'success');
          load();
        } catch (err) {
          toast(err.message, 'error');
        }
      };
    });

    const queryInput = view.querySelector('#kb-query');
    const runSearch = async () => {
      const q = queryInput.value.trim();
      if (!q) return;
      if (searching) return;
      searching = true;
      const results = view.querySelector('#kb-results');
      results.innerHTML = `<div class="empty" style="padding:20px"><span class="spinner dark"></span></div>`;
      try {
        const res = await api('/api/kb/search', { method: 'POST', body: { query: q } });
        hits = res.hits;
      } catch (err) {
        toast(err.message, 'error');
        hits = [];
      } finally {
        searching = false;
        render();
      }
    };
    view.querySelector('#kb-search-btn').onclick = runSearch;
    queryInput.onkeydown = (e) => {
      if (e.key === 'Enter') runSearch();
    };
  }

  async function uploadDocs(files) {
    const allowed = ['pdf', 'docx', 'txt', 'md', 'markdown'];
    const valid = files.filter((f) => allowed.includes((f.name.split('.').pop() || '').toLowerCase()));
    if (valid.length !== files.length) toast('已跳过不支持的文件类型', 'error');
    if (!valid.length) return;
    const progress = view.querySelector('#kb-progress');
    for (const file of valid) {
      const row = document.createElement('div');
      row.className = 'row between';
      row.style.cssText = 'padding:8px 11px;border:1px solid var(--line);border-radius:9px;margin-bottom:6px;font-size:12px;background:#fcfdff';
      row.innerHTML = `<span>${esc(file.name)}</span><span class="small muted"><span class="spinner dark" style="width:12px;height:12px"></span> 解析中…</span>`;
      progress.appendChild(row);
      try {
        const res = await fetch(`/api/kb/docs?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '上传失败');
        row.innerHTML = `<span>${esc(file.name)}</span><span class="badge badge-green">已切分 ${data.chunks} 个片段</span>`;
        if (data.warning) toast(data.warning, 'error', 6000);
      } catch (err) {
        row.innerHTML = `<span>${esc(file.name)}</span><span class="small" style="color:#d92d20">${esc(err.message)}</span>`;
      }
    }
    setTimeout(() => load(), 600);
  }

  async function showDoc(id) {
    try {
      const data = await api(`/api/kb/docs/${id}`);
      const { doc, chunks } = data;
      const { close } = openModal(
        `
        <div class="modal-head">
          <div>
            <h3>${esc(doc.name)}</h3>
            <div class="small muted">${chunks.length} 个片段展示 · 全文 ${doc.textLength} 字</div>
          </div>
          <button class="btn btn-ghost btn-icon" data-close>${icon('x')}</button>
        </div>
        <div class="modal-body">
          ${doc.error ? `<div class="alert" style="margin-bottom:12px">${icon('alert')}<div>${esc(doc.error)}</div></div>` : ''}
          ${chunks
            .map(
              (ch) => `
            <div class="chunk-card">
              <div class="ch-idx">片段 #${ch.idx + 1}${ch.title && ch.title !== doc.name ? ` · ${esc(ch.title)}` : ''}</div>
              ${esc(ch.text)}
            </div>`,
            )
            .join('')}
        </div>
        <div class="modal-foot"><button class="btn" data-close>关闭</button></div>`,
        { wide: true },
      );
      void close;
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function pasteDialog() {
    const { el, close } = openModal(`
      <div class="modal-head"><h3>粘贴文本资料</h3><button class="btn btn-ghost btn-icon" data-close>${icon('x')}</button></div>
      <div class="modal-body">
        <div class="field">
          <label>资料名称</label>
          <input class="input" id="paste-name" placeholder="例如：车险理赔定损争议处理规范（2026版）" />
        </div>
        <div class="field">
          <label>正文内容</label>
          <textarea class="textarea" id="paste-text" rows="10" placeholder="粘贴制度条款、操作规范或话术内容…"></textarea>
          <div class="hint">内容会按段落切分并建立检索索引</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close>取消</button>
        <button class="btn btn-primary" id="paste-save">保存并建索引</button>
      </div>`);
    el.querySelector('#paste-save').onclick = async () => {
      const name = el.querySelector('#paste-name').value.trim();
      const text = el.querySelector('#paste-text').value.trim();
      if (name.length < 2) return toast('请填写资料名称', 'error');
      if (text.length < 20) return toast('正文内容过短', 'error');
      try {
        await api('/api/kb/docs', { method: 'POST', body: { name, text } });
        toast('资料已入库', 'success');
        close();
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }

  await load();
  return () => {};
}
