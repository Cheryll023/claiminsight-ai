import { api, esc, icon, toast } from '../lib.js?v=7';

export default async function settings(view, ctx) {
  let data = await api('/api/settings');
  let testing = '';
  ctx.setActions('');

  function render() {
    const s = data.settings;
    const st = data.status;
    const statusPill = (ok) => `<span class="badge ${ok ? 'badge-green' : 'badge-amber'}"><i class="dot ${ok ? 'on' : 'warn'}"></i>${ok ? '已配置' : '未配置'}</span>`;
    view.innerHTML = `
      <div class="alert ${st.llm && st.asr ? 'info' : ''}" style="margin-bottom:16px">
        ${icon('shieldCheck')}
        <div class="grow">
          <b>密钥仅保存在本机数据库中</b>，不会回显到前端页面。请使用具备相应模型的 OpenAI 兼容服务（如 OpenAI、DeepSeek、通义千问、豆包等）。
        </div>
      </div>

      <div class="settings-grid">
        <div>
          <div class="provider-card">
            <div class="provider-head">
              <div class="pico">${icon('spark', 18)}</div>
              <div><h3>大模型服务（LLM）</h3><div class="desc">用于案件分析报告、说话人角色判断与 AI 问答</div></div>
              ${statusPill(st.llm)}
            </div>
            <div class="form-row">
              <div class="field">
                <label>API Base URL</label>
                <input class="input" data-key="llm.base_url" value="${esc(s['llm.base_url'])}" placeholder="https://api.openai.com/v1" />
                <div class="hint">需兼容 /chat/completions 接口</div>
              </div>
              <div class="field">
                <label>模型名称</label>
                <input class="input" data-key="llm.model" value="${esc(s['llm.model'])}" placeholder="gpt-4o-mini / deepseek-chat" />
                <div class="hint">建议使用支持 JSON 输出的模型</div>
              </div>
            </div>
            <div class="field">
              <label>API Key</label>
              <input class="input" type="password" data-key="llm.api_key" value="${esc(s['llm.api_key'])}" placeholder="sk-…" autocomplete="off" />
              <div class="hint">${s._env['llm.api_key'] ? '环境变量已提供 Key，此处留空将使用环境变量' : '请输入服务商提供的 API Key'}</div>
            </div>
            <div class="row">
              <button class="btn btn-sm" data-test="llm">${icon('zap', 13)}测试连接</button>
              <span id="test-llm" class="small muted"></span>
            </div>
          </div>

          <div class="provider-card">
            <div class="provider-head">
              <div class="pico" style="background:#e6f6f4;color:#0e9384">${icon('message', 18)}</div>
              <div><h3>语音转写服务（ASR）</h3><div class="desc">将录音转写为带时间戳的文本，并尽可能区分说话人</div></div>
              ${statusPill(st.asr)}
            </div>
            <div class="form-row">
              <div class="field">
                <label>API Base URL</label>
                <input class="input" data-key="asr.base_url" value="${esc(s['asr.base_url'])}" placeholder="https://api.openai.com/v1" />
                <div class="hint">需兼容 /audio/transcriptions 接口</div>
              </div>
              <div class="field">
                <label>模型名称</label>
                <input class="input" data-key="asr.model" value="${esc(s['asr.model'])}" placeholder="whisper-1 / gpt-4o-transcribe-diarize" />
                <div class="hint">含 diarize 的模型可返回说话人分离</div>
              </div>
            </div>
            <div class="field">
              <label>API Key</label>
              <input class="input" type="password" data-key="asr.api_key" value="${esc(s['asr.api_key'])}" placeholder="sk-…" autocomplete="off" />
            </div>
            <div class="form-row">
              <div class="field">
                <label>录音语言</label>
                <select class="select" data-key="asr.language">
                  ${['zh', 'en', 'ja', 'auto']
                    .map((v) => `<option value="${v}" ${s['asr.language'] === v ? 'selected' : ''}>${v === 'zh' ? '中文' : v === 'en' ? '英文' : v === 'ja' ? '日文' : '自动识别'}</option>`)
                    .join('')}
                </select>
              </div>
              <div class="field">
                <label>说话人分离</label>
                <select class="select" data-key="asr.diarization">
                  <option value="auto" ${s['asr.diarization'] === 'auto' ? 'selected' : ''}>自动（按模型能力）</option>
                  <option value="on" ${s['asr.diarization'] === 'on' ? 'selected' : ''}>强制开启</option>
                  <option value="off" ${s['asr.diarization'] === 'off' ? 'selected' : ''}>关闭，使用 AI 推断</option>
                </select>
              </div>
            </div>
            <div class="row">
              <button class="btn btn-sm" data-test="asr">${icon('zap', 13)}测试连接</button>
              <span id="test-asr" class="small muted"></span>
            </div>
          </div>

          <div class="provider-card">
            <div class="provider-head">
              <div class="pico" style="background:#f4f0ff;color:#6941c6">${icon('layers', 18)}</div>
              <div><h3>向量模型（可选）</h3><div class="desc">启用后知识库使用「向量 + 关键词」混合检索，提升召回质量</div></div>
              ${statusPill(st.embed)}
            </div>
            <div class="form-row three">
              <div class="field">
                <label>API Base URL</label>
                <input class="input" data-key="embed.base_url" value="${esc(s['embed.base_url'])}" placeholder="https://api.openai.com/v1" />
              </div>
              <div class="field">
                <label>模型名称</label>
                <input class="input" data-key="embed.model" value="${esc(s['embed.model'])}" placeholder="text-embedding-3-small" />
              </div>
              <div class="field">
                <label>API Key</label>
                <input class="input" type="password" data-key="embed.api_key" value="${esc(s['embed.api_key'])}" placeholder="留空则仅用关键词检索" autocomplete="off" />
              </div>
            </div>
          </div>

          <div class="row" style="margin-top:16px;justify-content:flex-end">
            <span class="small muted grow">保存后立即生效，无需重启服务</span>
            <button class="btn btn-primary" id="save-settings">${icon('check')}保存配置</button>
          </div>
        </div>

        <aside class="stack">
          <div class="card card-pad">
            <div class="section-title"><span class="bar"></span>配置检查</div>
            <div class="info-list">
              <div class="item"><span>大模型</span><b>${st.llm ? '可用' : '缺失'}</b></div>
              <div class="item"><span>语音转写</span><b>${st.asr ? '可用' : '缺失'}</b></div>
              <div class="item"><span>向量检索</span><b>${st.embed ? '已启用' : '未启用'}</b></div>
            </div>
            <div class="divider"></div>
            <div class="small muted" style="line-height:1.8">
              缺少大模型或语音转写服务时，上传与案件归类仍可使用，但无法完成转写和报告生成。
            </div>
          </div>

          <div class="card card-pad env-tip">
            <div class="section-title"><span class="bar"></span>环境变量方式</div>
            <div class="small" style="color:#475467;line-height:2">
              也可在启动服务前设置环境变量：
              <div style="margin-top:6px">
                <code>LLM_BASE_URL</code> / <code>LLM_API_KEY</code> / <code>LLM_MODEL</code><br />
                <code>ASR_BASE_URL</code> / <code>ASR_API_KEY</code> / <code>ASR_MODEL</code><br />
                <code>EMBED_BASE_URL</code> / <code>EMBED_API_KEY</code> / <code>EMBED_MODEL</code>
              </div>
            </div>
          </div>

          <div class="card card-pad">
            <div class="section-title"><span class="bar"></span>接口兼容说明</div>
            <div class="small" style="color:#475467;line-height:1.85">
              <p style="margin:0 0 8px">· 大模型需支持 <code>POST /chat/completions</code>，建议支持 <code>response_format: json_object</code>。</p>
              <p style="margin:0 0 8px">· 语音转写需支持 <code>POST /audio/transcriptions</code>（multipart/form-data），返回 <code>verbose_json</code> 或 <code>diarized_json</code> 更佳。</p>
              <p style="margin:0">· 超过 20MB 的 MP3 / WAV 会自动分片转写；其他格式请先转换。</p>
            </div>
          </div>
        </aside>
      </div>`;

    bind();
  }

  function collect() {
    const patch = {};
    view.querySelectorAll('[data-key]').forEach((el) => {
      patch[el.dataset.key] = el.value;
    });
    return patch;
  }

  function bind() {
    view.querySelector('#save-settings').onclick = async () => {
      try {
        const res = await api('/api/settings', { method: 'PUT', body: collect() });
        data = await api('/api/settings');
        toast('配置已保存', 'success');
        render();
        void res;
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    view.querySelectorAll('[data-test]').forEach((btn) => {
      btn.onclick = async () => {
        const kind = btn.dataset.test;
        const out = view.querySelector(`#test-${kind}`);
        if (testing) return;
        testing = kind;
        btn.disabled = true;
        out.innerHTML = '<span class="spinner dark" style="width:12px;height:12px"></span> 正在测试…';
        try {
          await api('/api/settings', { method: 'PUT', body: collect() });
          const res = await api('/api/settings/test', { method: 'POST', body: { kind } });
          out.innerHTML = res.ok
            ? `<span style="color:#0f9d58">${icon('check', 12)} ${esc(res.message)}</span>`
            : `<span style="color:#d92d20">${icon('alert', 12)} ${esc(res.message)}</span>`;
          data = await api('/api/settings');
        } catch (err) {
          out.innerHTML = `<span style="color:#d92d20">${esc(err.message)}</span>`;
        } finally {
          testing = '';
          btn.disabled = false;
        }
      };
    });
  }

  render();
  return () => {};
}
