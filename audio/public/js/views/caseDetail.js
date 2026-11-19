import {
  api,
  esc,
  icon,
  statusBadge,
  toast,
  confirmDialog,
  fmtDuration,
  fmtDateTime,
  fromNow,
  renderMarkdown,
  roleName,
} from '../lib.js?v=7';

const QUICK_QUESTIONS = [
  '客户提出了哪些诉求？各自的处理结果如何？',
  '客户在哪些话题上产生不满？工作人员是如何回应的？',
  '哪些诉求还没有得到明确答复，需要进一步核实？',
  '结合企业知识库，客户对 500 元免赔的异议应该怎么处理？',
  '多段录音中客户重复提出了哪些问题？历史承诺兑现了吗？',
  '下一步应该优先处理哪些诉求？',
];

export default async function caseDetail(view, ctx) {
  const caseId = ctx.params.id;
  let data = null;
  let tab = 'report';
  let activeRec = 0;
  let playerTime = 0;
  let highlightStart = null;
  let timer = null;
  let chatting = false;
  let lastCitations = null;
  let chatDraft = '';
  let emotionFocus = null; // 从报告跳到情绪分析时要定位的诉求
  let dockOpen = true; // 报告内 AI 助手侧栏是否展开

  async function load(silent = false) {
    try {
      data = await api(`/api/cases/${caseId}`);
      if (!silent) {
        ctx.setTitle(data.case.code, [
          { label: '录音分析', href: '#/' },
          { label: data.case.code },
        ]);
      }
      render(silent);
    } catch (err) {
      if (!silent) {
        view.innerHTML = `<div class="card empty">${icon('alert')}<h4>案件加载失败</h4><p>${esc(err.message)}</p><a class="btn" href="#/">返回工作台</a></div>`;
      }
    }
  }

  function render(silent = false) {
    if (!data) return;
    const { case: c, recordings, report, job } = data;
    const processing = ['queued', 'processing'].includes(c.status);
    const failed = c.status === 'failed';
    const failedRecordings = recordings.filter((r) => r.status === 'failed');

    ctx.setActions(`
      <button class="btn" data-act="export" ${!report ? 'disabled' : ''}>${icon('download')}导出分析报告</button>
      <button class="btn" data-act="reanalyze" ${processing ? 'disabled' : ''}>${icon('refresh')}${processing ? '处理中…' : '重新分析'}</button>
      <button class="btn btn-danger btn-icon" data-act="delete" title="删除案件">${icon('trash')}</button>
    `);

    view.innerHTML = `
      <div class="detail-head">
        <div class="grow">
          <div class="detail-title">
            <a class="btn btn-ghost btn-icon" href="#/" title="返回工作台">${icon('arrowRight', 15)}</a>
            <h2>${esc(c.code)}</h2>
            ${statusBadge(c.status)}
            ${report ? `<span class="badge badge-blue">${icon('layers', 12)} ${recordings.length} 段录音综合分析</span>` : ''}
            ${c.claimCount ? `<span class="badge badge-blue">${c.claimCount} 条客户诉求</span>` : ''}
            ${c.escalationCount ? `<span class="badge badge-amber">${c.escalationCount} 项升级信号</span>` : ''}
            ${failedRecordings.length ? `<span class="badge badge-red">${failedRecordings.length} 段录音处理失败</span>` : ''}
          </div>
          <div class="meta-grid">
            <span>理赔专员 <b>${esc(c.employeeId || '—')}</b></span>
            <span>录音 <b>${recordings.length} 段</b></span>
            <span>通话时长 <b>${fmtDuration(recordings.reduce((s, r) => s + (r.duration || 0), 0))}</b></span>
            <span>创建于 <b>${fmtDateTime(c.createdAt)}</b></span>
            ${c.analysisAt ? `<span>分析完成 <b>${fromNow(c.analysisAt)}</b></span>` : ''}
          </div>
        </div>
      </div>

      ${
        processing
          ? `<div class="alert info" style="margin-bottom:16px">${icon('clock')}<div class="grow"><b>${job?.message || '案件处理中'}</b>
              <div class="progress progress-thin" style="margin-top:7px;max-width:520px"><i style="width:${job?.progress || 6}%"></i></div></div>
              <span class="small muted">页面自动刷新</span></div>`
          : ''
      }
      ${failed ? `<div class="alert danger" style="margin-bottom:16px">${icon('alert')}<div class="grow"><b>处理失败：</b>${esc(c.error || '未知错误')}</div>
          <button class="btn btn-sm" data-act="reanalyze">${icon('refresh', 13)}重试</button></div>` : ''}
      ${failedRecordings.length && !failed ? `<div class="alert" style="margin-bottom:16px">${icon('alert')}<div class="grow">部分录音转写失败，报告仅基于成功转写的 ${recordings.length - failedRecordings.length} 段录音。可在「录音原文」中重试。</div></div>` : ''}

      <div class="tabs">
        <div class="tab ${tab === 'report' ? 'active' : ''}" data-tab="report">${icon('message', 14)} 分析报告</div>
        <div class="tab ${tab === 'emotion' ? 'active' : ''}" data-tab="emotion">${icon('chart', 14)} 情绪分析</div>
        <div class="tab ${tab === 'transcript' ? 'active' : ''}" data-tab="transcript">${icon('file', 14)} 录音原文 <span class="count">${recordings.length}</span></div>
        <div class="tab ${tab === 'chat' ? 'active' : ''}" data-tab="chat">${icon('spark', 14)} AI 问答${data.messages?.length ? `<span class="count">${data.messages.filter((m) => m.role === 'user').length}</span>` : ''}</div>
      </div>

      <div id="tab-body"></div>
    `;

    bindShell();
    const body = view.querySelector('#tab-body');
    if (tab === 'report') renderReport(body, { c, report, recordings, job });
    else if (tab === 'emotion') renderEmotion(body, { c, report, recordings });
    else if (tab === 'transcript') renderTranscripts(body, { recordings });
    else renderChat(body, { c, report });
  }

  function bindShell() {
    view.querySelectorAll('[data-tab]').forEach((el) => {
      el.onclick = () => {
        tab = el.dataset.tab;
        render();
      };
    });
    document.querySelectorAll('#topbar-actions [data-act], #view [data-act]').forEach((btn) => {
      const act = btn.dataset.act;
      if (act === 'export') btn.onclick = exportReport;
      if (act === 'reanalyze')
        btn.onclick = async () => {
          try {
            await api(`/api/cases/${caseId}/analyze`, { method: 'POST' });
            toast('已提交重新分析', 'success');
            load(true);
          } catch (err) {
            toast(err.message, 'error');
          }
        };
      if (act === 'delete')
        btn.onclick = async () => {
          const ok = await confirmDialog({
            title: '删除案件',
            message: '将删除该案件下的录音文件、分析报告和问答记录，不可恢复。',
            confirmText: '删除',
            danger: true,
          });
          if (!ok) return;
          try {
            await api(`/api/cases/${caseId}`, { method: 'DELETE' });
            toast('案件已删除', 'success');
            location.hash = '#/';
          } catch (err) {
            toast(err.message, 'error');
          }
        };
    });
  }

  /* ---------------- 报告 ---------------- */

  function recLabelMap(recordings) {
    const map = {};
    recordings.forEach((r, i) => (map[r.id] = i + 1));
    return map;
  }

  function evChips(evidence, recordings) {
    if (!Array.isArray(evidence) || !evidence.length) return '';
    const map = recLabelMap(recordings);
    return evidence
      .map((ev) => {
        if (!ev || typeof ev !== 'object') return '';
        if (!ev.verified || !ev.recordingId) {
          return `<span class="evidence unverified" title="${esc(ev.quote || '未在录音原文中定位到该引用')}">${icon('alert', 11)}引用未核验</span>`;
        }
        const idx = map[ev.recordingId];
        return `<span class="evidence" data-ev-rec="${esc(ev.recordingId)}" data-ev-start="${ev.start}" title="${esc(ev.quote || '')}">${icon(
          'quote',
          11,
        )}录音${idx || ev.recording?.replace(/[^\d]/g, '') || ''} ${esc(ev.time || '')}${icon('play', 9)}</span>`;
      })
      .join('');
  }

  function quotesOf(item) {
    if (!item?.evidence) return '';
    const verified = item.evidence.filter((e) => e?.verified && e.quote);
    if (!verified.length) return '';
    return verified
      .slice(0, 2)
      .map((e) => `<span class="quote">“${esc(e.quote.length > 64 ? e.quote.slice(0, 64) + '…' : e.quote)}”</span>`)
      .join('');
  }

  function normalizeItem(item) {
    if (item == null) return null;
    if (typeof item === 'string') return { text: item };
    return item;
  }

  function itemText(item) {
    if (!item) return '';
    return item.text || item.description || item.event || item.value || item.content || '';
  }

  function bullets(items, recordings, { numbered = false, render } = {}) {
    if (!Array.isArray(items) || !items.length) return `<span class="muted-text">无法判断</span>`;
    return `<ul class="bullets ${numbered ? 'numbered' : ''}">${items
      .map((raw) => {
        const item = normalizeItem(raw);
        if (!item) return '';
        const main = render ? render(item) : esc(itemText(item));
        return `<li>${main}${quotesOf(item)}${evChips(item.evidence, recordings)}</li>`;
      })
      .join('')}</ul>`;
  }

  function sub(title, content, extra = '') {
    return `<div class="subblock"><h4>${esc(title)}${extra}</h4>${content}</div>`;
  }

  function reportSection(iconName, title, idx, bodyHtml) {
    return `<section class="report-card">
      <header><span class="ico">${icon(iconName, 15)}</span><h3>${esc(title)}</h3><span class="idx">${idx}</span></header>
      <div class="report-body">${bodyHtml}</div>
    </section>`;
  }

  function renderReport(container, { c, report, recordings, job }) {
    if (!report) {
      const processing = ['queued', 'processing'].includes(c.status);
      container.innerHTML = `<div class="card empty">
        ${icon(processing ? 'clock' : 'chart')}
        <h4>${processing ? '正在生成案件分析报告' : '暂无分析报告'}</h4>
        <p>${processing ? esc(job?.message || 'AI 正在综合案件全部录音…') : esc(c.error || '该案件尚未完成分析，或处理失败需要重试')}</p>
        ${
          processing
            ? `<div class="progress" style="max-width:420px;margin:0 auto"><i style="width:${job?.progress || 8}%"></i></div>`
            : `<button class="btn btn-primary" data-act="reanalyze">${icon('refresh')}开始分析</button>`
        }
      </div>`;
      container.querySelectorAll('[data-act="reanalyze"]').forEach((b) => (b.onclick = () => {
        api(`/api/cases/${caseId}/analyze`, { method: 'POST' })
          .then(() => {
            toast('已提交分析', 'success');
            load(true);
          })
          .catch((err) => toast(err.message, 'error'));
      }));
      return;
    }

    if (Array.isArray(report.claims) && report.claims.length) {
      renderDemandReport(container, { c, report, recordings });
      return;
    }

    const summary = report.summary || {};
    const facts = report.facts || {};
    const comm = report.communication || {};
    const recs = report.recommendations || {};
    const suggestions = report.suggestions || report.coach || {};
    const risks = Array.isArray(report.risks) ? report.risks : [];
    const uncertainties = Array.isArray(report.uncertainties) ? report.uncertainties : [];
    const meta = report.meta || {};
    const quotes = meta.quotes || { total: 0, verified: 0 };
    const rate = quotes.total ? Math.round((quotes.verified / quotes.total) * 100) : 0;
    const dateRange = meta.dateRange || '未知';
    const totalDuration = recordings.reduce((s, r) => s + (r.duration || 0), 0);

    const analysisBanner = `
      <section class="card card-pad" style="margin-bottom:16px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
        <div class="avatar teal" style="width:38px;height:38px">${icon('layers', 18)}</div>
        <div class="grow" style="min-width:260px">
          <div style="font-weight:600;margin-bottom:2px">基于 ${recordings.length} 段录音的综合分析</div>
          <div class="small muted">
            已合并 ${recordings.length} 段沟通录音、共 ${fmtDuration(totalDuration)}、${meta.transcriptChars ? `${meta.transcriptChars.toLocaleString()} 字转写文本` : '案件全部转写内容'}，
            跨录音提取客户诉求、关键事实与待跟进事项。关键结论引用录音原文，已核验 ${quotes.verified}/${quotes.total} 条。
          </div>
        </div>
        <div class="row wrap" style="gap:6px">
          ${recordings.map((r, i) => `<span class="badge badge-gray">录音${i + 1} · ${fmtDuration(r.duration)}</span>`).join('')}
        </div>
      </section>`;

    const summaryHero = `
      <section class="card" style="margin-bottom:16px">
        <div class="card-head"><div><h3>案件核心摘要</h3><div class="sub">综合全部录音形成的案件级结论</div></div><span class="badge badge-blue">AI 综合分析</span></div>
        <div style="padding:0 20px 18px">
          <p style="margin:0 0 10px;font-size:14px;line-height:1.9;color:#344054">${esc(summary.events || summary.background || '无法判断')}</p>
          <div class="grid grid-2" style="gap:12px">
            <div class="quote-card"><div class="small muted">客户核心诉求</div><div style="margin-top:3px">${esc(summary.customerDemands || '无法判断')}</div></div>
            <div class="quote-card"><div class="small muted">当前处理情况</div><div style="margin-top:3px">${esc(summary.currentStatus || '无法判断')}</div></div>
          </div>
          <div class="quote-card" style="margin-top:12px">
            <div class="small muted">待解决问题</div>
            <div style="margin-top:3px">${
              Array.isArray(report.facts?.pending) && report.facts.pending.length
                ? esc(report.facts.pending.slice(0, 3).map((p) => itemText(p)).join('；'))
                : '未识别到明确待确认事项'
            }</div>
          </div>
        </div>
      </section>`;

    container.innerHTML = `
      <div class="report-layout">
        <div class="report-main">
          <div class="report-guide">
            <div class="rg-text">${icon('info', 14)}<div><b>报告怎么看：</b>从「案件核心摘要」快速把握全貌，再按 01–05 编号模块依次查看事实提取、诉求沟通、风险识别与处理建议；右侧栏为案件信息、引用核验与录音清单。</div></div>
          </div>
          ${analysisBanner}
          ${summaryHero}
          ${
            uncertainties.length
              ? `<div class="uncertain"><h4>${icon('alert', 13)} 需要人工确认的事项</h4>
                  <ul class="bullets">${uncertainties.map((u) => `<li>${esc(typeof u === 'string' ? u : itemText(u))}</li>`).join('')}</ul>
                </div>`
              : ''
          }

          ${reportSection(
            'layers',
            '关键事实提取',
            '01',
            `
            ${sub('事故经过', bullets(facts.accident, recordings))}
            ${sub('客户陈述', bullets(facts.customerStatements, recordings))}
            ${sub(
              '关键时间节点',
              Array.isArray(facts.timeline) && facts.timeline.length
                ? `<div class="table-wrap"><table class="table" style="font-size:12.5px"><tbody>${facts.timeline
                    .map((t) => {
                      const item = normalizeItem(t);
                      return `<tr><td style="width:120px" class="mono">${esc(item.date || '未知')}</td><td>${esc(item.event || itemText(item))}${quotesOf(
                        item,
                      )}${evChips(item.evidence, recordings)}</td></tr>`;
                    })
                    .join('')}</tbody></table></div>`
                : '<span class="muted-text">无法判断</span>',
            )}
            <div class="grid grid-2">
              ${sub('已确认的信息', bullets(facts.confirmed, recordings))}
              ${sub(
                '尚待核实的信息',
                Array.isArray(facts.pending) && facts.pending.length
                  ? `<ul class="bullets">${facts.pending
                      .map((p) => {
                        const item = normalizeItem(p);
                        return `<li>${esc(itemText(item))}${item.reason ? `<span class="quote">核实原因：${esc(item.reason)}</span>` : ''}</li>`;
                      })
                      .join('')}</ul>`
                  : '<span class="muted-text">无法判断</span>',
              )}
            </div>`,
          )}

          ${reportSection(
            'message',
            '客户诉求与沟通情况',
            '02',
            `
            ${sub('客户主要问题', bullets(comm.questions, recordings))}
            ${sub('客户不满的事项', bullets(comm.dissatisfactions, recordings))}
            ${sub(
              '客户提出的异议',
              Array.isArray(comm.objections) && comm.objections.length
                ? `<ul class="bullets">${comm.objections
                    .map((o) => {
                      const item = normalizeItem(o);
                      return `<li>${esc(itemText(item))}${item.response ? `<span class="quote">专员回应：${esc(item.response)}</span>` : ''}${evChips(
                        item.evidence,
                        recordings,
                      )}</li>`;
                    })
                    .join('')}</ul>`
                : '<span class="muted-text">无法判断</span>',
            )}
            ${sub(
              '理赔专员的回应情况',
              Array.isArray(comm.agentResponses) && comm.agentResponses.length
                ? `<ul class="bullets">${comm.agentResponses
                    .map((a) => {
                      const item = normalizeItem(a);
                      const tone =
                        item.evaluation === '不充分' || item.evaluation === '不到位'
                          ? 'red'
                          : item.evaluation === '充分' || item.evaluation === '到位'
                            ? 'green'
                            : 'amber';
                      return `<li>${item.evaluation ? `<span class="badge badge-${tone}" style="margin-right:5px">${esc(item.evaluation)}</span>` : ''}${esc(
                        itemText(item),
                      )}${evChips(item.evidence, recordings)}</li>`;
                    })
                    .join('')}</ul>`
                : '<span class="muted-text">无法判断</span>',
            )}
            ${sub(
              '解释不充分或存在歧义的地方',
              Array.isArray(comm.unclearPoints) && comm.unclearPoints.length
                ? `<ul class="bullets">${comm.unclearPoints
                    .map((p) => {
                      const item = normalizeItem(p);
                      return `<li>${esc(itemText(item))}${evChips(item.evidence, recordings)}</li>`;
                    })
                    .join('')}</ul>`
                : '<span class="muted-text">未识别到明显问题</span>',
            )}`,
          )}

          ${reportSection(
            'shield',
            '案件问题与风险识别',
            '03',
            risks.length
              ? risks
                  .map((raw) => {
                    const r = normalizeItem(raw);
                    const sev = r.severity === 'high' ? 'high' : r.severity === 'low' ? 'low' : 'medium';
                    const sevLabel = sev === 'high' ? '高风险' : sev === 'low' ? '低风险' : '中风险';
                    return `<div class="risk ${sev}">
                      <i class="sev"></i>
                      <div class="grow">
                        <div class="row between"><div class="r-type">${esc(r.type || '风险')}</div><span class="badge badge-${
                          sev === 'high' ? 'red' : sev === 'low' ? 'green' : 'amber'
                        }">${sevLabel}</span></div>
                        <div class="r-text">${esc(itemText(r))}</div>
                        ${quotesOf(r)}${evChips(r.evidence, recordings)}
                      </div>
                    </div>`;
                  })
                  .join('')
              : `<span class="muted-text">未识别到明显风险</span>`,
          )}

          ${reportSection(
            'target',
            '后续处理建议',
            '04',
            `
            <div class="grid grid-2">
              ${sub(
                '需要进一步核实的问题',
                Array.isArray(recs.verification) && recs.verification.length
                  ? `<ul class="bullets numbered">${recs.verification.map((v) => `<li>${esc(itemText(normalizeItem(v)))}</li>`).join('')}</ul>`
                  : '<span class="muted-text">无法判断</span>',
              )}
              ${sub(
                '需要补充的材料',
                Array.isArray(recs.materials) && recs.materials.length
                  ? `<ul class="bullets">${recs.materials
                      .map((m) => {
                        const item = normalizeItem(m);
                        return `<li>${esc(itemText(item))}${item.reason ? `<span class="quote">用途：${esc(item.reason)}</span>` : ''}</li>`;
                      })
                      .join('')}</ul>`
                  : '<span class="muted-text">无法判断</span>',
              )}
            </div>
            ${sub(
              '下一步行动建议',
              Array.isArray(recs.nextActions) && recs.nextActions.length
                ? `<ul class="bullets">${recs.nextActions
                    .map((a) => {
                      const item = normalizeItem(a);
                      const pr = item.priority === '高' ? 'red' : item.priority === '低' ? 'gray' : 'amber';
                      return `<li>${item.priority ? `<span class="badge badge-${pr}" style="margin-right:5px">${esc(item.priority)}优先</span>` : ''}${esc(
                        itemText(item),
                      )}</li>`;
                    })
                    .join('')}</ul>`
                : '<span class="muted-text">无法判断</span>',
            )}`,
          )}

          ${reportSection(
            'zap',
            '沟通与业务改进建议',
            '05',
            `
            ${sub('业务知识与条款解释不足', bullets(suggestions.businessGaps || suggestions.knowledgeGaps, recordings))}
            ${sub('沟通表达与信息遗漏', bullets(suggestions.communicationIssues, recordings))}
            ${sub('客户诉求识别偏差', bullets(suggestions.needIdentification, recordings))}
            ${sub(
              '可改进的具体动作',
              Array.isArray(suggestions.actions) && suggestions.actions.length
                ? `<ul class="bullets numbered">${suggestions.actions
                    .map((a) => {
                      const item = normalizeItem(a);
                      return `<li>${esc(itemText(item))}${item.rationale ? `<span class="quote">改进理由：${esc(item.rationale)}</span>` : ''}</li>`;
                    })
                    .join('')}</ul>`
                : '<span class="muted-text">无法判断</span>',
            )}`,
          )}
        </div>

        <aside class="side-panel">
          <div class="card card-pad">
            <div class="section-title"><span class="bar"></span>案件信息</div>
            <div class="info-list">
              <div class="item"><span>案件编号</span><b>${esc(c.code)}</b></div>
              <div class="item"><span>理赔专员</span><b>${esc(c.employeeId || '未知')}</b></div>
              <div class="item"><span>录音数量</span><b>${recordings.length} 段</b></div>
              <div class="item"><span>录音日期</span><b>${esc(dateRange)}</b></div>
              <div class="item"><span>通话总时长</span><b>${fmtDuration(recordings.reduce((s, r) => s + (r.duration || 0), 0))}</b></div>
            </div>
          </div>

          <div class="card card-pad">
            <div class="section-title"><span class="bar"></span>分析概况</div>
            <div class="info-list">
              <div class="item"><span>分析范围</span><b>${recordings.length} 段录音</b></div>
              <div class="item"><span>问题与风险</span><b>${risks.length} 项</b></div>
              <div class="item"><span>引用核验</span><b>${quotes.verified}/${quotes.total} 条</b></div>
              <div class="item"><span>分析时间</span><b>${fmtDateTime(meta.generatedAt)}</b></div>
            </div>
            <button class="btn btn-sm btn-block btn-primary" style="margin-top:12px" data-act="ask">${icon('spark', 13)}针对本案继续追问</button>
          </div>

          <div class="card card-pad">
            <div class="section-title"><span class="bar"></span>引用核验</div>
            <div class="coverage-ring">
              <div class="ring" style="--p:${rate}"><span>${rate}%</span></div>
              <div>
                <div style="font-weight:600;font-size:13px">${quotes.verified}/${quotes.total} 条引用已定位</div>
                <div class="small muted">AI 结论中标记的原文引用会在转写文本中自动比对，未定位的引用已标注。</div>
              </div>
            </div>
            <div class="divider"></div>
            <div class="info-list">
              <div class="item"><span>生成时间</span><b>${fmtDateTime(meta.generatedAt)}</b></div>
              <div class="item"><span>分析方式</span><b>${meta.analysisMode === 'map-reduce' ? '分段抽取 + 综合' : '全量综合分析'}</b></div>
              <div class="item"><span>转写字数</span><b>${meta.transcriptChars ? meta.transcriptChars.toLocaleString() : '—'}</b></div>
            </div>
            ${meta.failedRecordings ? `<div class="alert" style="margin-top:10px;padding:8px 10px">${icon('alert', 14)}<div>${meta.failedRecordings} 段录音未能转写，报告未覆盖其内容。</div></div>` : ''}
          </div>

          <div class="card">
            <div class="card-head"><h3>录音清单</h3><span class="small muted">${recordings.length} 段</span></div>
            <div class="file-list">
              ${recordings
                .map(
                  (r, i) => `
                <div class="file-item" style="padding:10px 14px;cursor:pointer" data-goto-rec="${r.id}">
                  <div class="avatar ${r.status === 'transcribed' ? 'teal' : 'amber'}" style="width:26px;height:26px;font-size:10px">${i + 1}</div>
                  <div class="grow">
                    <div class="small" style="font-weight:500">${esc(r.recType || '沟通录音')}</div>
                    <div class="small muted">${esc(r.recDate || '日期未知')} · ${fmtDuration(r.duration)}</div>
                  </div>
                  ${statusBadge(r.status)}
                </div>`,
                )
                .join('')}
            </div>
          </div>

          <div class="alert info" style="font-size:11.5px">${icon('info')}<div>报告由 AI 基于录音转写生成，重要结论请结合原文核实后使用。</div></div>
        </aside>
      </div>`;

    container.querySelectorAll('[data-act="ask"]').forEach((btn) => {
      btn.onclick = () => {
        tab = 'chat';
        render();
      };
    });
    container.querySelectorAll('[data-ev-rec]').forEach((chip) => {
      chip.onclick = () => {
        const recId = chip.dataset.evRec;
        const start = Number(chip.dataset.evStart) || 0;
        openTranscriptAt(recId, start);
      };
    });
    container.querySelectorAll('[data-goto-rec]').forEach((el) => {
      el.onclick = () => {
        const idx = recordings.findIndex((r) => r.id === el.dataset.gotoRec);
        tab = 'transcript';
        activeRec = Math.max(0, idx);
        render();
      };
    });
  }

  /* ---------------- 以客户诉求为核心的报告 ---------------- */

  const CLAIM_TYPE_TONE = {
    理赔咨询: 'blue',
    进度催办: 'amber',
    赔付异议: 'violet',
    客户投诉: 'red',
    争议协商: 'violet',
    材料补充: 'teal',
    其他: 'gray',
  };
  const CLAIM_STATUS_TONE = { 已明确回应: 'green', 部分回应: 'amber', 未回应: 'red', 待核实: 'gray' };
  const CLARITY_TONE = { 充分: 'green', 部分充分: 'amber', 不充分: 'red', 未回应: 'gray' };
  const LEVEL_TONE = { 紧急: 'red', 预警: 'amber', 关注: 'gray' };

  function claimBadge(type) {
    return `<span class="badge badge-${CLAIM_TYPE_TONE[type] || 'gray'}">${esc(type || '其他')}</span>`;
  }

  function statusBadgeOf(value) {
    if (!value) return '';
    return `<span class="badge badge-${CLAIM_STATUS_TONE[value] || 'gray'}">${esc(value)}</span>`;
  }

  function renderDemandReport(container, { c, report, recordings }) {
    const summary = report.summary || {};
    const claims = report.claims || [];
    const flow = Array.isArray(report.communicationFlow) ? report.communicationFlow : [];
    const cross = report.crossRecording || {};
    const risks = Array.isArray(report.riskSignals) ? report.riskSignals : [];
    const recs = report.recommendations || {};
    const uncertainties = Array.isArray(report.uncertainties) ? report.uncertainties : [];
    const meta = report.meta || {};
    const quotes = meta.quotes || { total: 0, verified: 0 };
    const rate = quotes.total ? Math.round((quotes.verified / quotes.total) * 100) : 0;
    const totalDuration = recordings.reduce((s, r) => s + (r.duration || 0), 0);
    const escalationCount = claims.reduce((s, cl) => s + (cl.dispute?.escalation?.length || 0), 0);
    const pendingCount = claims.reduce((s, cl) => s + (cl.pending?.length || 0), 0);
    const metaList = meta.dateRange || '未知';

    const summaryHero = `
      <section class="card" style="margin-bottom:16px" id="sec-summary">
        <div class="card-head">
          <div><h3>案件整体摘要</h3><div class="sub">以 ${claims.length} 条客户诉求为主线，综合 ${recordings.length} 段录音</div></div>
          <span class="badge badge-blue">AI 综合分析</span>
        </div>
        <div style="padding:0 20px 18px">
          <p style="margin:0 0 12px;font-size:14px;line-height:1.9;color:#344054">${esc(summary.overview || summary.events || '无法判断')}</p>
          <div class="grid grid-2" style="gap:12px">
            <div class="quote-card"><div class="small muted">最核心诉求</div><div style="margin-top:3px">${esc(summary.mainClaim || summary.customerDemands || '无法判断')}</div></div>
            <div class="quote-card"><div class="small muted">当前处理进展</div><div style="margin-top:3px">${esc(summary.handlingStatus || summary.currentStatus || '无法判断')}</div></div>
            <div class="quote-card"><div class="small muted">客户处境与关切</div><div style="margin-top:3px">${esc(summary.customerSituation || '无法判断')}</div></div>
            <div class="quote-card"><div class="small muted">情绪走向</div><div style="margin-top:3px">${esc(summary.emotionTrend || '无法判断')}</div></div>
          </div>
          <div class="quote-card" style="margin-top:12px;${escalationCount ? 'border-color:#f6d5c4;background:#fffaf7' : ''}">
            <div class="small muted">投诉与升级信号</div>
            <div style="margin-top:3px">${esc(summary.escalationSummary || (escalationCount ? '存在需关注的升级信号，请见各诉求详情' : '未发现明显升级信号'))}</div>
          </div>
        </div>
      </section>`;

    const flowHtml = flow.length
      ? `<section class="card" style="margin-bottom:16px" id="sec-flow">
          <div class="card-head"><div><h3>沟通脉络</h3><div class="sub">按时间还原每段录音中客户表达、工作人员回应与沟通结果</div></div>
            <span class="badge badge-gray">${flow.length} 次沟通</span></div>
          <div class="flow-list">
            ${flow
              .map(
                (f) => `
              <div class="flow-row">
                <div class="flow-time">
                  <b>${esc(f.date || '日期未知')}</b>
                  <span>${esc(f.recording || '')}${f.stage ? ` · ${esc(f.stage)}` : ''}</span>
                </div>
                <div class="flow-body">
                  <div class="flow-line"><span class="who customer">客户</span>${esc(f.customer || '—')}</div>
                  <div class="flow-line"><span class="who agent">工作人员</span>${esc(f.agent || '—')}</div>
                  <div class="flow-line result"><span class="who">结果</span>${esc(f.result || '—')}</div>
                  ${
                    Array.isArray(f.claimIds) && f.claimIds.length
                      ? `<div class="row wrap" style="gap:5px;margin-top:6px">${f.claimIds
                          .map((id) => `<button class="chip" data-goto-claim="${esc(id)}">${esc(claims.find((x) => x.id === id)?.title || id)}</button>`)
                          .join('')}</div>`
                      : ''
                  }
                </div>
              </div>`,
              )
              .join('')}
          </div>
        </section>`
      : '';

    const claimsHtml = claims
      .map((claim, i) => {
        const resp = claim.response || {};
        const dispute = claim.dispute || {};
        const emotion = claim.emotion || {};
        const outcome = claim.outcome || {};
        const advice = claim.aiAdvice || {};
        const measures = Array.isArray(resp.measures) ? resp.measures : [];
        const promises = Array.isArray(resp.promises) ? resp.promises : [];
        const triggers = Array.isArray(dispute.triggers) ? dispute.triggers : [];
        const repeated = Array.isArray(dispute.repeated) ? dispute.repeated : [];
        const escalation = Array.isArray(dispute.escalation) ? dispute.escalation : [];
        const confirmed = Array.isArray(dispute.confirmedFacts) ? dispute.confirmedFacts : [];
        const unverified = Array.isArray(dispute.unverified) ? dispute.unverified : [];
        const pending = Array.isArray(claim.pending) ? claim.pending : [];
        const history = Array.isArray(claim.history) ? claim.history : [];
        const actions = Array.isArray(advice.actions) ? advice.actions : [];
        const basis = Array.isArray(advice.basis) ? advice.basis : [];
        const labels = Array.isArray(emotion.labels) ? emotion.labels : [];

        return `<article class="demand-card" id="claim-${esc(claim.id)}">
          <header class="dc-head">
            <span class="dc-id">${esc(claim.id || `C${i + 1}`)}</span>
            <div class="grow">
              <h4>${esc(claim.title || '客户诉求')}</h4>
              <div class="row wrap" style="gap:6px;margin-top:5px">
                ${claimBadge(claim.type)}
                ${statusBadgeOf(claim.status)}
                ${claim.priority === 'high' ? '<span class="badge badge-red">高优先</span>' : ''}
                ${claim.raisedAt ? `<span class="small muted">首次提出：${esc(claim.raisedAt)}</span>` : ''}
              </div>
            </div>
          </header>
          <div class="dc-body">
            <div class="dc-step">
              <div class="dc-label">${icon('message', 13)} 客户诉求</div>
              <p class="dc-main">${esc(claim.demand || '无法判断')}</p>
              ${claim.context ? `<p class="dc-sub">${esc(claim.context)}</p>` : ''}
              ${quotesOf(claim)}${evChips(claim.evidence, recordings)}
            </div>

            <div class="dc-step">
              <div class="dc-label">${icon('user', 13)} 工作人员回应 ${resp.clarity ? `<span class="badge badge-${CLARITY_TONE[resp.clarity] || 'gray'}">${esc(resp.clarity)}</span>` : ''}</div>
              <p class="dc-main">${esc(resp.summary || '无法判断')}</p>
              ${resp.evaluation ? `<p class="dc-sub">${esc(resp.evaluation)}</p>` : ''}
              ${
                measures.length
                  ? `<div class="dc-mini"><span class="dc-mini-title">处理措施</span><ul class="bullets">${measures
                      .map((m) => {
                        const it = normalizeItem(m);
                        return `<li>${esc(itemText(it))}${evChips(it.evidence, recordings)}</li>`;
                      })
                      .join('')}</ul></div>`
                  : ''
              }
              ${
                promises.length
                  ? `<div class="dc-mini"><span class="dc-mini-title">明确承诺</span><ul class="bullets">${promises
                      .map((p) => {
                        const it = normalizeItem(p);
                        return `<li>${esc(itemText(it))}<span class="quote">时限：${esc(it.due || '未明确')}</span>${evChips(it.evidence, recordings)}</li>`;
                      })
                      .join('')}</ul></div>`
                  : `<div class="dc-mini"><span class="dc-mini-title">明确承诺</span><span class="muted-text">未识别到明确承诺</span></div>`
              }
            </div>

            <div class="dc-step emo-brief">
              <div class="dc-label">${icon('chart', 13)} 情绪与争议</div>
              <p class="dc-main">
                ${labels.map((l) => `<span class="badge badge-violet">${esc(l)}</span>`).join('')}
                ${esc(dispute.focus || dispute.dissatisfaction || '无明显争议')}
                ${escalation.length ? `<span class="badge badge-amber">${escalation.length} 项升级信号</span>` : ''}
              </p>
              ${emotion.narrative ? `<p class="dc-sub">${esc(emotion.narrative)}</p>` : ''}
              <button class="btn btn-sm btn-ghost" data-goto-emotion="${esc(claim.id)}">查看该诉求的情绪与争议详情 ${icon('arrowRight', 12)}</button>
            </div>

            <div class="dc-step dc-split">
              <div>
                <div class="dc-label">${icon('check', 13)} 沟通结果</div>
                <p class="dc-main">${esc(outcome.text || '无法判断')}</p>
                <div class="row wrap" style="gap:6px">${statusBadgeOf(outcome.status || claim.status)}${evChips(outcome.evidence, recordings)}</div>
              </div>
              <div>
                <div class="dc-label">${icon('clock', 13)} 待核实事项</div>
                ${
                  pending.length
                    ? `<ul class="bullets">${pending
                        .map((p) => {
                          const it = normalizeItem(p);
                          return `<li>${esc(itemText(it))}${it.reason ? `<span class="quote">原因：${esc(it.reason)}</span>` : ''}</li>`;
                        })
                        .join('')}</ul>`
                    : '<span class="muted-text">该诉求下暂无待核实事项</span>'
                }
              </div>
            </div>

            ${
              history.length > 1
                ? `<div class="dc-step">
                    <div class="dc-label">${icon('layers', 13)} 多段录音中的变化</div>
                    <div class="history-line">${history
                      .map(
                        (h) => `<div class="history-item"><span class="mono">${esc(h.recording || '')}${h.date ? ` · ${esc(h.date)}` : ''}</span><span>${esc(h.note || '')}</span>${evChips(h.evidence, recordings)}</div>`,
                      )
                      .join('')}</div>
                  </div>`
                : ''
            }

            <div class="dc-step advice">
              <div class="dc-label">${icon('spark', 13)} AI 业务处理建议</div>
              ${
                actions.length
                  ? `<ul class="bullets">${actions
                      .map((a) => {
                        const it = normalizeItem(a);
                        const pr = it.priority === '高' ? 'red' : it.priority === '低' ? 'gray' : 'amber';
                        return `<li>${it.priority ? `<span class="badge badge-${pr}" style="margin-right:5px">${esc(it.priority)}优先</span>` : ''}${esc(
                          itemText(it),
                        )}${it.basis ? `<span class="basis-tag">${esc(it.basis)}</span>` : ''}</li>`;
                      })
                      .join('')}</ul>`
                  : '<span class="muted-text">暂无可执行建议</span>'
              }
              ${
                basis.length
                  ? `<div class="basis-list">${basis
                      .map((b) => `<span class="basis-chip" title="${esc(b.text || '')}">${icon('book', 11)} ${esc(b.docName || '知识库依据')}</span>`)
                      .join('')}</div>`
                  : ''
              }
              ${
                advice.missingBasis
                  ? `<div class="alert" style="margin-top:8px;padding:8px 10px">${icon('info', 13)}<div>${esc(advice.missingBasis)}</div></div>`
                  : ''
              }
              <div class="row wrap" style="gap:8px;margin-top:10px">
                <button class="btn btn-sm btn-primary" data-deep="${esc(claim.id)}">${icon('spark', 13)}针对本条诉求深度分析</button>
                <button class="btn btn-sm" data-ask-claim="${esc(claim.id)}">${icon('message', 13)}在 AI 问答中继续追问</button>
              </div>
            </div>

            ${claim.deepDive ? deepDiveHtml(claim, recordings) : ''}
          </div>
        </article>`;
      })
      .join('');

    const crossHtml =
      (Array.isArray(cross.repeated) && cross.repeated.length) ||
      (Array.isArray(cross.commitments) && cross.commitments.length) ||
      (Array.isArray(cross.changes) && cross.changes.length)
        ? `<section class="card" style="margin-bottom:16px" id="sec-cross">
            <div class="card-head"><div><h3>跨录音关联</h3><div class="sub">客户重复提出的问题、历史承诺与沟通内容变化</div></div></div>
            <div style="padding:0 20px 18px">
              ${
                Array.isArray(cross.repeated) && cross.repeated.length
                  ? `<div class="dc-mini"><span class="dc-mini-title">反复提出的问题</span><ul class="bullets">${cross.repeated
                      .map((r) => {
                        const it = normalizeItem(r);
                        return `<li>${esc(itemText(it))}${Array.isArray(it.refs) ? `<span class="quote">${esc(it.refs.join('、'))}</span>` : ''}${evChips(it.evidence, recordings)}</li>`;
                      })
                      .join('')}</ul></div>`
                  : ''
              }
              ${
                Array.isArray(cross.commitments) && cross.commitments.length
                  ? `<div class="dc-mini"><span class="dc-mini-title">历史承诺兑现情况</span><ul class="bullets">${cross.commitments
                      .map((r) => {
                        const it = normalizeItem(r);
                        const tone = it.status === '已兑现' ? 'green' : it.status === '未兑现' ? 'red' : 'gray';
                        return `<li>${esc(itemText(it))}<span class="badge badge-${tone}" style="margin-left:5px">${esc(it.status || '无法判断')}</span>${
                          it.madeIn ? `<span class="quote">承诺于 ${esc(it.madeIn)}</span>` : ''
                        }${evChips(it.evidence, recordings)}</li>`;
                      })
                      .join('')}</ul></div>`
                  : ''
              }
              ${
                Array.isArray(cross.changes) && cross.changes.length
                  ? `<div class="dc-mini"><span class="dc-mini-title">沟通内容变化</span><ul class="bullets">${cross.changes
                      .map((t) => `<li>${esc(typeof t === 'string' ? t : itemText(normalizeItem(t)))}</li>`)
                      .join('')}</ul></div>`
                  : ''
              }
            </div>
          </section>`
        : '';

    const riskHtml = risks.length
      ? `<section class="card" style="margin-bottom:16px" id="sec-risks">
          <div class="card-head"><div><h3>需要关注的风险信号</h3><div class="sub">仅作为关注提示，不等同于业务违规结论</div></div><span class="badge badge-amber">${risks.length} 项</span></div>
          <div style="padding:0 20px 18px">
            ${risks
              .map(
                (r) => `<div class="risk ${r.level === '紧急' ? 'high' : r.level === '预警' ? 'medium' : 'low'}" style="margin-top:8px">
                  <i class="sev"></i>
                  <div class="grow"><div class="row between"><div class="r-type">${esc(r.type || '风险信号')}</div><span class="badge badge-${LEVEL_TONE[r.level] || 'gray'}">${esc(r.level || '关注')}</span></div>
                  <div class="r-text">${esc(r.text || '')}</div>${evChips(r.evidence, recordings)}</div>
                </div>`,
              )
              .join('')}
          </div>
        </section>`
      : '';

    const recsHtml = `
      <section class="card" style="margin-bottom:16px" id="sec-recs">
        <div class="card-head"><div><h3>案件级处理建议</h3><div class="sub">跨诉求的整体跟进事项</div></div></div>
        <div style="padding:0 20px 18px" class="grid grid-2">
          <div>
            <div class="dc-label">${icon('clock', 13)} 需要进一步核实</div>
            ${
              Array.isArray(recs.verification) && recs.verification.length
                ? `<ul class="bullets numbered">${recs.verification.map((v) => `<li>${esc(itemText(normalizeItem(v)))}</li>`).join('')}</ul>`
                : '<span class="muted-text">无法判断</span>'
            }
            <div class="dc-label" style="margin-top:14px">${icon('file', 13)} 需要补充的材料</div>
            ${
              Array.isArray(recs.materials) && recs.materials.length
                ? `<ul class="bullets">${recs.materials
                    .map((m) => {
                      const it = normalizeItem(m);
                      return `<li>${esc(itemText(it))}${it.reason ? `<span class="quote">用途：${esc(it.reason)}</span>` : ''}</li>`;
                    })
                    .join('')}</ul>`
                : '<span class="muted-text">无法判断</span>'
            }
          </div>
          <div>
            <div class="dc-label">${icon('target', 13)} 下一步行动</div>
            ${
              Array.isArray(recs.nextActions) && recs.nextActions.length
                ? `<ul class="bullets">${recs.nextActions
                    .map((a) => {
                      const it = normalizeItem(a);
                      const pr = it.priority === '高' ? 'red' : it.priority === '低' ? 'gray' : 'amber';
                      return `<li>${it.priority ? `<span class="badge badge-${pr}" style="margin-right:5px">${esc(it.priority)}优先</span>` : ''}${esc(itemText(it))}</li>`;
                    })
                    .join('')}</ul>`
                : '<span class="muted-text">无法判断</span>'
            }
            ${
              uncertainties.length
                ? `<div class="uncertain" style="margin-top:12px"><h4>${icon('alert', 13)} 需要人工确认</h4><ul class="bullets">${uncertainties
                    .map((u) => `<li>${esc(typeof u === 'string' ? u : itemText(normalizeItem(u)))}</li>`)
                    .join('')}</ul></div>`
                : ''
            }
          </div>
        </div>
      </section>`;

    /* 报告导读：分析报告包含多个模块，先用横幅说明每个模块的用途，并提供锚点快速定位 */
    const guideHtml = `
      <div class="report-guide">
        <div class="rg-text">${icon('info', 14)}<div><b>报告怎么看：</b>「整体摘要」快速把握案件全貌；「沟通脉络」按时间还原每次沟通；「客户诉求分析」逐条查看 <b>诉求 → 工作人员回应 → 沟通结果 → 待核实 → AI 建议</b>。情绪、争议与投诉升级的完整分析在「情绪分析」页签；右侧 AI 助手可边看边问。</div></div>
        <div class="rg-anchors">
          <button class="chip" data-goto-section="sec-summary">整体摘要</button>
          ${flow.length ? '<button class="chip" data-goto-section="sec-flow">沟通脉络</button>' : ''}
          <button class="chip" data-goto-section="sec-claims">客户诉求</button>
          <button class="chip" data-goto-tab="emotion">情绪与争议</button>
          ${crossHtml ? '<button class="chip" data-goto-section="sec-cross">跨录音关联</button>' : ''}
          <button class="chip" data-goto-section="sec-recs">处理建议</button>
        </div>
      </div>`;

    container.innerHTML = `
      <div class="report-layout">
        <div class="report-main">
          ${guideHtml}
          <section class="card card-pad" style="margin-bottom:16px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
            <div class="avatar teal" style="width:38px;height:38px">${icon('layers', 18)}</div>
            <div class="grow" style="min-width:260px">
              <div style="font-weight:600;margin-bottom:2px">基于 ${recordings.length} 段录音、${claims.length} 条客户诉求的综合分析</div>
              <div class="small muted">
                共 ${fmtDuration(totalDuration)}、${meta.transcriptChars ? `${meta.transcriptChars.toLocaleString()} 字转写文本` : '全部转写内容'}；
                跨录音合并同一诉求，并关联工作人员回应、争议情绪、沟通结果与待核实事项。关键结论引用已核验 ${quotes.verified}/${quotes.total} 条。
              </div>
            </div>
            <div class="row wrap" style="gap:6px">
              ${recordings.map((r, i) => `<span class="badge badge-gray">录音${i + 1} · ${fmtDuration(r.duration)}</span>`).join('')}
            </div>
          </section>

          ${summaryHero}
          ${flowHtml}

          <section class="card" style="margin-bottom:16px" id="sec-claims">
            <div class="card-head"><div><h3>客户诉求分析</h3><div class="sub">客户诉求 → 工作人员回应 → 争议与情绪 → 沟通结果 → 待核实 → AI 建议</div></div>
              <span class="badge badge-blue">${claims.length} 条诉求</span></div>
            <div class="demand-list">${claimsHtml}</div>
          </section>

          ${crossHtml}
          ${recsHtml}
        </div>

        <aside class="side-panel">
          ${aiDockHtml(c)}
          <div class="card card-pad">
            <div class="section-title"><span class="bar"></span>案件信息</div>
            <div class="info-list">
              <div class="item"><span>案件编号</span><b>${esc(c.code)}</b></div>
              <div class="item"><span>理赔专员</span><b>${esc(c.employeeId || '未知')}</b></div>
              <div class="item"><span>录音数量</span><b>${recordings.length} 段</b></div>
              <div class="item"><span>录音日期</span><b>${esc(metaList)}</b></div>
              <div class="item"><span>通话总时长</span><b>${fmtDuration(totalDuration)}</b></div>
            </div>
          </div>

          <div class="card card-pad">
            <div class="section-title"><span class="bar"></span>诉求概况</div>
            <div class="info-list">
              <div class="item"><span>客户诉求</span><b>${claims.length} 条</b></div>
              <div class="item"><span>投诉升级信号</span><b>${escalationCount} 项</b></div>
              <div class="item"><span>待核实事项</span><b>${pendingCount} 项</b></div>
              <div class="item"><span>聚焦问题</span><b>${risks.length} 项</b></div>
              <div class="item"><span>引用核验</span><b>${quotes.verified}/${quotes.total} 条</b></div>
            </div>
            <button class="btn btn-sm btn-block btn-primary" style="margin-top:12px" data-act="ask">${icon('spark', 13)}针对本案继续追问</button>
          </div>

          <div class="card card-pad">
            <div class="section-title"><span class="bar"></span>引用核验</div>
            <div class="coverage-ring">
              <div class="ring" style="--p:${rate}"><span>${rate}%</span></div>
              <div>
                <div style="font-weight:600;font-size:13px">${quotes.verified}/${quotes.total} 条引用已定位</div>
                <div class="small muted">AI 结论中的原文引用会自动与转写文本比对，未定位的引用已标注。</div>
              </div>
            </div>
            <div class="divider"></div>
            <div class="info-list">
              <div class="item"><span>生成时间</span><b>${fmtDateTime(meta.generatedAt)}</b></div>
              <div class="item"><span>分析方式</span><b>${meta.analysisMode === 'map-reduce' ? '分段抽取 + 综合' : '全量综合分析'}</b></div>
              <div class="item"><span>转写字数</span><b>${meta.transcriptChars ? meta.transcriptChars.toLocaleString() : '—'}</b></div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>录音清单</h3><span class="small muted">${recordings.length} 段</span></div>
            <div class="file-list">
              ${recordings
                .map(
                  (r, i) => `
                <div class="file-item" style="padding:10px 14px;cursor:pointer" data-goto-rec="${r.id}">
                  <div class="avatar ${r.status === 'transcribed' ? 'teal' : 'amber'}" style="width:26px;height:26px;font-size:10px">${i + 1}</div>
                  <div class="grow">
                    <div class="small" style="font-weight:500">${esc(r.recType || '沟通录音')}</div>
                    <div class="small muted">${esc(r.recDate || '日期未知')} · ${fmtDuration(r.duration)}</div>
                  </div>
                  ${statusBadge(r.status)}
                </div>`,
                )
                .join('')}
            </div>
          </div>

          <div class="alert info" style="font-size:11.5px">${icon('info')}<div>报告由 AI 基于录音转写生成，区分客户陈述、可确认事实与待核实原因；重要结论请结合原文核实后使用。</div></div>
        </aside>
      </div>`;

    container.querySelectorAll('[data-act="ask"]').forEach((btn) => {
      btn.onclick = () => {
        tab = 'chat';
        render();
      };
    });
    container.querySelectorAll('[data-ev-rec]').forEach((chip) => {
      chip.onclick = () => openTranscriptAt(chip.dataset.evRec, Number(chip.dataset.evStart) || 0);
    });
    container.querySelectorAll('[data-goto-rec]').forEach((el) => {
      el.onclick = () => {
        const idx = recordings.findIndex((r) => r.id === el.dataset.gotoRec);
        tab = 'transcript';
        activeRec = Math.max(0, idx);
        render();
      };
    });
    container.querySelectorAll('[data-goto-claim]').forEach((el) => {
      el.onclick = () => {
        const target = container.querySelector(`#claim-${CSS.escape(el.dataset.gotoClaim)}`);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target?.classList.add('flash');
        setTimeout(() => target?.classList.remove('flash'), 1600);
      };
    });
    /* 报告导读锚点：快速定位到对应模块 */
    container.querySelectorAll('[data-goto-section]').forEach((btn) => {
      btn.onclick = () => {
        const el = container.querySelector(`#${btn.dataset.gotoSection}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el?.classList.add('flash');
        setTimeout(() => el?.classList.remove('flash'), 1600);
      };
    });
    /* 导读里指向其他页签的入口 */
    container.querySelectorAll('[data-goto-tab]').forEach((btn) => {
      btn.onclick = () => {
        tab = btn.dataset.gotoTab;
        render();
      };
    });
    /* 从诉求卡跳到情绪分析页签，并定位该诉求 */
    container.querySelectorAll('[data-goto-emotion]').forEach((btn) => {
      btn.onclick = () => {
        emotionFocus = btn.dataset.gotoEmotion;
        tab = 'emotion';
        render();
      };
    });
    bindAiDock(container, c);
    container.querySelectorAll('[data-deep]').forEach((btn) => {
      btn.onclick = async () => {
        const claim = claims.find((x) => x.id === btn.dataset.deep);
        btn.disabled = true;
        const old = btn.innerHTML;
        btn.innerHTML = '<span class="spinner"></span> 正在分析本条诉求…';
        try {
          await api(`/api/cases/${caseId}/claims/${encodeURIComponent(btn.dataset.deep)}/analyze`, { method: 'POST' });
          toast('深度分析已生成', 'success');
          data = await api(`/api/cases/${caseId}`);
          render();
          setTimeout(() => {
            view.querySelector(`#claim-${CSS.escape(btn.dataset.deep)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 80);
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
          btn.innerHTML = old;
        }
      };
    });
    container.querySelectorAll('[data-ask-claim]').forEach((btn) => {
      btn.onclick = () => {
        const claim = claims.find((x) => x.id === btn.dataset.askClaim);
        chatDraft = `请深入分析客户诉求「${claim?.title || btn.dataset.askClaim}」：客户的诉求是什么，工作人员回应是否充分，还有哪些待核实事项，建议怎么处理？`;
        tab = 'chat';
        render();
      };
    });
  }

  /* ---------------- 报告内 AI 助手侧栏 ---------------- */

  function aiDockHtml(c) {
    const messages = data.messages || [];
    return `<div class="card ai-dock ${dockOpen ? 'open' : ''}">
      <div class="ai-dock-head">
        <div class="bot">${icon('spark', 15)}</div>
        <div class="grow"><b>AI 助手</b><small>边看报告边提问</small></div>
        <button class="btn btn-ghost btn-icon btn-sm" data-dock-toggle title="${dockOpen ? '收起侧栏' : '展开侧栏'}">${icon(dockOpen ? 'chevronDown' : 'spark', 14)}</button>
      </div>
      ${
        dockOpen
          ? `<div class="ai-dock-body">
              <div class="ai-dock-log" id="dock-log">
                ${
                  messages.length
                    ? messages.slice(-4).map((m) => msgHtml(m.role, m.content)).join('')
                    : `<div class="ai-dock-hint">${icon('info', 12)}<span>报告里的结论都可以追问，例如“客户为什么对赔付金额不满？”</span></div>`
                }
              </div>
              <div class="ai-dock-quick">
                ${QUICK_QUESTIONS.slice(0, 2).map((q) => `<button class="chip" data-dock-quick="${esc(q)}">${esc(q)}</button>`).join('')}
              </div>
              <div class="composer-box">
                <textarea id="dock-input" rows="1" placeholder="针对当前报告提问…"></textarea>
                <button class="btn btn-primary btn-sm" id="dock-send">${icon('send', 13)}</button>
              </div>
              <button class="link-btn" data-open-chat>查看完整对话与引用 ${icon('arrowRight', 11)}</button>
            </div>`
          : ''
      }
    </div>`;
  }

  function bindAiDock(container, c) {
    const dock = container.querySelector('.ai-dock');
    if (!dock) return;
    dock.querySelector('[data-dock-toggle]').onclick = () => {
      dockOpen = !dockOpen;
      render();
    };
    dock.querySelector('[data-open-chat]')?.addEventListener('click', () => {
      tab = 'chat';
      render();
    });
    const input = dock.querySelector('#dock-input');
    if (!input) return;
    dock.querySelectorAll('[data-dock-quick]').forEach((chip) => {
      chip.onclick = () => {
        input.value = chip.dataset.dockQuick;
        input.focus();
      };
    });
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        dockSend(container, c);
      }
    };
    dock.querySelector('#dock-send').onclick = () => dockSend(container, c);
  }

  async function dockSend(container, c) {
    if (chatting) return;
    const input = container.querySelector('#dock-input');
    const question = (input.value || '').trim();
    if (!question) return;
    chatting = true;
    input.value = '';
    const log = container.querySelector('#dock-log');
    log.querySelector('.ai-dock-hint')?.remove();
    log.insertAdjacentHTML('beforeend', msgHtml('user', question));
    log.insertAdjacentHTML(
      'beforeend',
      `<div class="msg assistant" id="dock-streaming"><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>`,
    );
    log.scrollTop = log.scrollHeight;
    const bubble = log.querySelector('#dock-streaming .bubble');
    const btn = container.querySelector('#dock-send');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';

    let fullText = '';
    let frame = null;
    const paint = () => {
      frame = null;
      bubble.innerHTML = renderMarkdown(fullText) || '<span class="typing"><i></i><i></i><i></i></span>';
      log.scrollTop = log.scrollHeight;
    };
    try {
      await streamAnswer(question, {
        onMeta: (payload) => {
          lastCitations = payload;
        },
        onDelta: (text) => {
          fullText += text;
          if (!frame) frame = requestAnimationFrame(paint);
        },
      });
      if (frame) cancelAnimationFrame(frame);
      bubble.innerHTML = renderMarkdown(fullText || '（未返回内容）');
      data.messages = data.messages || [];
      data.messages.push({ role: 'user', content: question }, { role: 'assistant', content: fullText, citations: lastCitations });
    } catch (err) {
      bubble.innerHTML = `<span style="color:#d92d20">${esc(err.message)}</span>`;
      toast(err.message, 'error');
    } finally {
      chatting = false;
      btn.disabled = false;
      btn.innerHTML = icon('send', 13);
      log.querySelector('#dock-streaming')?.removeAttribute('id');
      log.scrollTop = log.scrollHeight;
    }
  }

  /* 统一的流式问答请求：AI 问答页与报告内助手共用 */
  async function streamAnswer(question, { onMeta, onDelta }) {
    const res = await fetch(`/api/cases/${caseId}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `请求失败（HTTP ${res.status}）`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = 'message';
        let dataLine = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        let payload;
        try {
          payload = JSON.parse(dataLine);
        } catch {
          continue;
        }
        if (event === 'meta') onMeta?.(payload);
        else if (event === 'delta') onDelta?.(payload.text || '', payload);
        else if (event === 'error') {
          /* 上游模型不可达时给出可读提示，避免直接暴露 fetch failed */
          const raw = payload.message || '';
          const readable = /fetch failed|Failed to fetch|ECONNREFUSED|ENOTFOUND|timeout/i.test(raw)
            ? '模型服务不可达，请前往「系统设置」检查 API 配置'
            : raw || '回答失败';
          throw new Error(readable);
        }
      }
    }
  }

  /* ---------------- 情绪分析 ---------------- */

  function renderEmotion(container, { c, report, recordings }) {
    if (!report) {
      container.innerHTML = `<div class="card empty">${icon('chart')}<h4>暂无情绪分析</h4><p>该案件尚未完成分析，或分析报告尚未生成</p></div>`;
      return;
    }
    const claims = Array.isArray(report.claims) ? report.claims : [];
    if (!claims.length) {
      container.innerHTML = `<div class="card empty">${icon('chart')}<h4>暂无情绪与争议数据</h4><p>当前报告未包含按客户诉求组织的情绪分析</p></div>`;
      return;
    }

    const labelCount = new Map();
    claims.forEach((cl) => (cl.emotion?.labels || []).forEach((l) => labelCount.set(l, (labelCount.get(l) || 0) + 1)));
    const escalationTotal = claims.reduce((s, cl) => s + (cl.dispute?.escalation?.length || 0), 0);
    const dissatisfied = claims.filter((cl) => cl.dispute?.dissatisfaction && !/无明显不满/.test(cl.dispute.dissatisfaction)).length;
    const risks = Array.isArray(report.riskSignals) ? report.riskSignals : [];

    const overview = `
      <section class="card" style="margin-bottom:16px">
        <div class="card-head"><div><h3>情绪与争议概览</h3><div class="sub">按客户诉求汇总，与「分析报告」中的诉求一一对应</div></div></div>
        <div style="padding:0 20px 18px">
          <div class="grid grid-3" style="gap:12px">
            <div class="quote-card"><div class="small muted">有情绪记录的诉求</div><div class="emo-num">${claims.length}</div><div class="small muted">共 ${claims.length} 条客户诉求</div></div>
            <div class="quote-card"><div class="small muted">存在不满的诉求</div><div class="emo-num">${dissatisfied}</div><div class="small muted">客户明确表达不满</div></div>
            <div class="quote-card"${escalationTotal ? ' style="border-color:#f6d5c4;background:#fffaf7"' : ''}><div class="small muted">投诉升级信号</div><div class="emo-num">${escalationTotal}</div><div class="small muted">需要重点关注</div></div>
          </div>
          ${
            labelCount.size
              ? `<div class="row wrap" style="gap:6px;margin-top:14px"><span class="small muted">情绪分布：</span>${[...labelCount.entries()]
                  .map(([l, n]) => `<span class="badge badge-violet">${esc(l)} · ${n}</span>`)
                  .join('')}</div>`
              : ''
          }
        </div>
      </section>`;

    const cards = claims
      .map((claim, i) => {
        const dispute = claim.dispute || {};
        const emotion = claim.emotion || {};
        const labels = Array.isArray(emotion.labels) ? emotion.labels : [];
        const triggers = Array.isArray(dispute.triggers) ? dispute.triggers : [];
        const repeated = Array.isArray(dispute.repeated) ? dispute.repeated : [];
        const escalation = Array.isArray(dispute.escalation) ? dispute.escalation : [];
        const confirmed = Array.isArray(dispute.confirmedFacts) ? dispute.confirmedFacts : [];
        const unverified = Array.isArray(dispute.unverified) ? dispute.unverified : [];
        return `<article class="emotion-card demand-card" id="emo-${esc(claim.id)}">
          <header class="dc-head">
            <span class="dc-id">${esc(claim.id || `C${i + 1}`)}</span>
            <div class="grow">
              <h4>${esc(claim.title || '客户诉求')}</h4>
              <div class="row wrap" style="gap:6px;margin-top:5px">
                ${claimBadge(claim.type)}
                ${statusBadgeOf(claim.status)}
                ${labels.map((l) => `<span class="badge badge-violet">${esc(l)}</span>`).join('')}
              </div>
            </div>
            <button class="btn btn-sm btn-ghost" data-back-report="${esc(claim.id)}">回到报告 ${icon('arrowRight', 12)}</button>
          </header>
          <div class="dc-body">
            <div class="grid grid-2" style="gap:10px">
              <div class="dc-fact"><span class="dc-fact-title">不满原因</span>${esc(dispute.dissatisfaction || '无明显不满')}</div>
              <div class="dc-fact"><span class="dc-fact-title">争议焦点</span>${esc(dispute.focus || '无明确争议')}</div>
            </div>
            ${
              triggers.length
                ? `<div class="dc-mini"><span class="dc-mini-title">触发不满的事件</span><ul class="bullets">${triggers
                    .map((t) => {
                      const it = normalizeItem(t);
                      return `<li>${esc(itemText(it))}${evChips(it.evidence, recordings)}</li>`;
                    })
                    .join('')}</ul></div>`
                : ''
            }
            ${
              repeated.length
                ? `<div class="dc-mini"><span class="dc-mini-title">反复追问</span><ul class="bullets">${repeated
                    .map((t) => {
                      const it = normalizeItem(t);
                      return `<li>${esc(itemText(it))}${evChips(it.evidence, recordings)}</li>`;
                    })
                    .join('')}</ul></div>`
                : ''
            }
            ${
              escalation.length
                ? `<div class="dc-mini"><span class="dc-mini-title">投诉升级信号</span><ul class="bullets">${escalation
                    .map((e) => {
                      const it = normalizeItem(e);
                      return `<li><span class="badge badge-${LEVEL_TONE[it.level] || 'gray'}" style="margin-right:5px">${esc(it.level || '关注')}</span>${esc(
                        itemText(it),
                      )}${evChips(it.evidence, recordings)}</li>`;
                    })
                    .join('')}</ul></div>`
                : `<div class="dc-mini"><span class="dc-mini-title">投诉升级信号</span><span class="muted-text">未发现明显升级信号</span></div>`
            }
            <div class="dc-facts3">
              <div class="dc-fact view"><span class="dc-fact-title">客户表达的不满（客户陈述）</span>${esc(dispute.customerView || dispute.dissatisfaction || '无')}</div>
              <div class="dc-fact fact"><span class="dc-fact-title">录音可确认的事实</span>${
                confirmed.length
                  ? `<ul class="bullets">${confirmed
                      .map((f) => {
                        const it = normalizeItem(f);
                        return `<li>${esc(itemText(it))}${evChips(it.evidence, recordings)}</li>`;
                      })
                      .join('')}</ul>`
                  : '<span class="muted-text">无法判断</span>'
              }</div>
              <div class="dc-fact pending"><span class="dc-fact-title">仍需核实的业务原因</span>${
                unverified.length
                  ? `<ul class="bullets">${unverified
                      .map((f) => {
                        const it = normalizeItem(f);
                        return `<li>${esc(itemText(it))}${it.reason ? `<span class="quote">核实原因：${esc(it.reason)}</span>` : ''}</li>`;
                      })
                      .join('')}</ul>`
                  : '<span class="muted-text">无需额外核实</span>'
              }</div>
            </div>
            <div class="emotion-note">
              <div class="row wrap" style="gap:5px;margin-bottom:5px">
                ${labels.map((l) => `<span class="badge badge-violet">${esc(l)}</span>`).join('')}
                <b class="small">情绪分析</b>
              </div>
              <div>${esc(emotion.narrative || '无法判断')}</div>
              ${
                Array.isArray(emotion.quotes) && emotion.quotes.length
                  ? `<ul class="bullets" style="margin-top:6px">${emotion.quotes
                      .map((q) => {
                        const it = normalizeItem(q);
                        return `<li>${esc(itemText(it))}${evChips(it.evidence, recordings)}</li>`;
                      })
                      .join('')}</ul>`
                  : ''
              }
            </div>
          </div>
        </article>`;
      })
      .join('');

    const riskHtml = risks.length
      ? `<section class="card" style="margin-bottom:16px" id="sec-risks">
          <div class="card-head"><div><h3>需要关注的风险信号</h3><div class="sub">仅作为关注提示，不等同于业务违规结论</div></div><span class="badge badge-amber">${risks.length} 项</span></div>
          <div style="padding:0 20px 18px">
            ${risks
              .map(
                (r) => `<div class="risk ${r.level === '紧急' ? 'high' : r.level === '预警' ? 'medium' : 'low'}" style="margin-top:8px">
                  <i class="sev"></i>
                  <div class="grow"><div class="row between"><div class="r-type">${esc(r.type || '风险信号')}</div><span class="badge badge-${LEVEL_TONE[r.level] || 'gray'}">${esc(r.level || '关注')}</span></div>
                  <div class="r-text">${esc(r.text || '')}</div>${evChips(r.evidence, recordings)}</div>
                </div>`,
              )
              .join('')}
          </div>
        </section>`
      : '';

    container.innerHTML = `
      <div class="report-layout">
        <div class="report-main">
          <div class="report-guide">
            <div class="rg-text">${icon('info', 14)}<div><b>情绪分析怎么用：</b>这里只放情绪、争议与投诉升级相关内容，与「分析报告」中的诉求一一对应。每条诉求区分「客户表达的不满」「录音可确认的事实」「仍需核实的业务原因」；风险信号仅作提示，不等同于业务违规结论。</div></div>
          </div>
          ${overview}
          <section class="card" style="margin-bottom:16px">
            <div class="card-head"><div><h3>按诉求的情绪与争议</h3><div class="sub">${claims.length} 条诉求 · 点击右侧目录可快速定位</div></div></div>
            <div class="demand-list">${cards}</div>
          </section>
          ${riskHtml}
        </div>

        <aside class="side-panel">
          <div class="card card-pad">
            <div class="section-title"><span class="bar"></span>诉求目录</div>
            <div class="emo-toc">
              ${claims
                .map(
                  (cl) =>
                    `<button class="emo-toc-item" data-emo-jump="${esc(cl.id)}"><span class="mono">${esc(cl.id)}</span><span>${esc(cl.title || '客户诉求')}</span></button>`,
                )
                .join('')}
            </div>
          </div>
          <div class="card card-pad">
            <div class="section-title"><span class="bar"></span>情绪概况</div>
            <div class="info-list">
              <div class="item"><span>客户诉求</span><b>${claims.length} 条</b></div>
              <div class="item"><span>存在不满</span><b>${dissatisfied} 条</b></div>
              <div class="item"><span>升级信号</span><b>${escalationTotal} 项</b></div>
              <div class="item"><span>风险信号</span><b>${risks.length} 项</b></div>
            </div>
          </div>
          <div class="alert info" style="font-size:11.5px">${icon('info')}<div>情绪与争议来自录音转写，请结合「录音原文」核实后再作为处理依据。</div></div>
        </aside>
      </div>`;

    container.querySelectorAll('[data-back-report]').forEach((btn) => {
      btn.onclick = () => {
        tab = 'report';
        render();
        setTimeout(() => {
          const el = view.querySelector(`#claim-${CSS.escape(btn.dataset.backReport)}`);
          el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          el?.classList.add('flash');
          setTimeout(() => el?.classList.remove('flash'), 1600);
        }, 80);
      };
    });
    container.querySelectorAll('[data-emo-jump]').forEach((btn) => {
      btn.onclick = () => {
        container.querySelector(`#emo-${CSS.escape(btn.dataset.emoJump)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
    container.querySelectorAll('[data-ev-rec]').forEach((chip) => {
      chip.onclick = () => openTranscriptAt(chip.dataset.evRec, Number(chip.dataset.evStart) || 0);
    });
    /* 从报告跳转过来时，定位到对应诉求并高亮 */
    if (emotionFocus) {
      const target = container.querySelector(`#emo-${CSS.escape(emotionFocus)}`);
      emotionFocus = null;
      setTimeout(() => {
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target?.classList.add('flash');
        setTimeout(() => target?.classList.remove('flash'), 1600);
      }, 60);
    }
  }

  function deepDiveHtml(claim, recordings) {
    const d = claim.deepDive || {};
    const points = Array.isArray(d.points) ? d.points : [];
    const checks = Array.isArray(d.checks) ? d.checks : [];
    const actions = Array.isArray(d.actions) ? d.actions : [];
    const knowledge = Array.isArray(d.knowledge) ? d.knowledge : [];
    return `<div class="deep-panel">
      <header>
        <div class="row" style="gap:7px">${icon('spark', 14)}<b>AI 深度分析</b><span class="badge badge-blue">${esc(claim.id)}</span></div>
        <span class="small muted">${fmtDateTime(d.generatedAt)}</span>
      </header>
      <p class="dc-main">${esc(d.conclusion || '无法判断')}</p>
      ${
        points.length
          ? `<ul class="bullets">${points
              .map((p) => {
                const it = normalizeItem(p);
                return `<li>${esc(itemText(it))}${it.basis ? `<span class="basis-tag">${esc(it.basis)}</span>` : ''}${evChips(it.evidence, recordings)}</li>`;
              })
              .join('')}</ul>`
          : ''
      }
      ${
        checks.length
          ? `<div class="dc-mini"><span class="dc-mini-title">需进一步核实</span><ul class="bullets">${checks
              .map((c) => {
                const it = normalizeItem(c);
                return `<li>${esc(itemText(it))}${it.reason ? `<span class="quote">原因：${esc(it.reason)}</span>` : ''}</li>`;
              })
              .join('')}</ul></div>`
          : ''
      }
      ${
        actions.length
          ? `<div class="dc-mini"><span class="dc-mini-title">建议动作</span><ul class="bullets numbered">${actions
              .map((a) => {
                const it = normalizeItem(a);
                const pr = it.priority === '高' ? 'red' : it.priority === '低' ? 'gray' : 'amber';
                return `<li>${it.priority ? `<span class="badge badge-${pr}" style="margin-right:5px">${esc(it.priority)}</span>` : ''}${esc(itemText(it))}</li>`;
              })
              .join('')}</ul></div>`
          : ''
      }
      ${d.script ? `<div class="script-box"><span class="dc-mini-title">建议沟通口径</span><p>${esc(d.script)}</p></div>` : ''}
      ${
        knowledge.length
          ? `<div class="basis-list">${knowledge
              .map((k) => `<span class="basis-chip" title="${esc(k.text || '')}">${icon('book', 11)} ${esc(k.docName)}</span>`)
              .join('')}</div>`
          : ''
      }
      ${d.missingBasis ? `<div class="alert" style="margin-top:8px;padding:8px 10px">${icon('info', 13)}<div>${esc(d.missingBasis)}</div></div>` : ''}
    </div>`;
  }

  /* ---------------- 录音原文 ---------------- */

  function openTranscriptAt(recId, start) {
    const idx = data.recordings.findIndex((r) => r.id === recId);
    tab = 'transcript';
    activeRec = Math.max(0, idx);
    highlightStart = start;
    render();
    setTimeout(() => {
      const audio = view.querySelector('#player-audio');
      if (audio) {
        audio.currentTime = start;
        audio.play().catch(() => {});
      }
      const seg = view.querySelector('.seg.hl');
      seg?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 60);
  }

  async function renderTranscripts(container, { recordings }) {
    if (!recordings.length) {
      container.innerHTML = `<div class="card empty">${icon('file')}<h4>案件下没有录音</h4></div>`;
      return;
    }
    const rec = recordings[Math.min(activeRec, recordings.length - 1)];
    activeRec = recordings.indexOf(rec);
    let transcript = null;
    try {
      const detail = await api(`/api/recordings/${rec.id}`);
      transcript = detail.transcript;
    } catch (err) {
      toast(err.message, 'error');
    }

    const segments = transcript?.segments || [];
    const roleSourceLabel =
      transcript?.roleSource === 'diarization+llm'
        ? '说话人分离 + AI 角色判断'
        : transcript?.roleSource === 'diarization'
          ? '说话人分离'
          : transcript?.roleSource === 'llm'
            ? 'AI 推断角色（建议复核）'
            : transcript?.roleSource === 'manual'
              ? '人工标注'
              : '未识别说话人';

    container.innerHTML = `
      <div class="transcript-layout">
        <div>
          <div class="rec-list">
            ${recordings
              .map(
                (r, i) => `
              <div class="rec-item ${i === activeRec ? 'active' : ''}" data-select-rec="${i}">
                <div class="t"><span class="badge badge-gray" style="height:18px;padding:0 5px">${i + 1}</span>${esc(r.recType || '沟通录音')}</div>
                <div class="f">${esc(r.filename)}</div>
                <div class="m"><span>${esc(r.recDate || '日期未知')}</span><span>${fmtDuration(r.duration)}</span><span>${r.segmentCount} 句</span></div>
                ${r.status !== 'transcribed' ? `<div style="margin-top:6px">${statusBadge(r.status)}</div>` : ''}
              </div>`,
              )
              .join('')}
          </div>
          <div class="card card-pad" style="margin-top:12px;padding:14px">
            <div class="small muted" style="margin-bottom:6px">说话人识别方式</div>
            <div style="font-size:12.5px;font-weight:500">${roleSourceLabel}</div>
            ${transcript?.notes?.length ? `<div class="small muted" style="margin-top:6px;line-height:1.6">${transcript.notes.map((n) => esc(n)).join('<br>')}</div>` : ''}
          </div>
        </div>

        <div class="card" style="overflow:hidden">
          <div class="player">
            <span class="badge badge-blue">录音 ${activeRec + 1}</span>
            <div class="grow">
              <div style="font-size:12.5px;font-weight:600">${esc(rec.filename)}</div>
              <div class="small muted">${fmtDuration(rec.duration)} · ${esc(rec.recDate || '日期未知')} · ${esc(rec.recType || '类型未知')}</div>
            </div>
            <a class="btn btn-sm" href="/api/recordings/${rec.id}/audio?download=1">${icon('download', 13)}下载</a>
          </div>
          <audio id="player-audio" controls preload="metadata" src="/api/recordings/${rec.id}/audio" style="width:100%;display:block;background:#f8fafc"></audio>
          ${
            rec.status === 'failed'
              ? `<div style="padding:20px"><div class="alert danger">${icon('alert')}<div class="grow"><b>转写失败：</b>${esc(rec.error || '未知错误')}</div>
                  <button class="btn btn-sm" data-retry-rec="${rec.id}">${icon('refresh', 13)}重新转写</button></div></div>`
              : ''
          }
          <div class="seg-list" id="seg-list">
            ${
              segments.length
                ? segments
                    .map(
                      (s) => `
                <div class="seg ${highlightStart !== null && Math.abs(s.start - highlightStart) < 1.5 ? 'hl' : ''}" data-seg="${s.idx}" data-start="${s.start}">
                  <div class="time" data-seek="${s.start}">${fmtDuration(s.start)}</div>
                  <div class="body">
                    <span class="who ${s.role || 'unknown'}" data-role-idx="${s.idx}">${esc(roleName(s.role))}</span>
                    <div class="txt">${esc(s.text)}</div>
                  </div>
                </div>`,
                    )
                    .join('')
                : `<div class="empty-inline">${rec.status === 'transcribed' ? '该录音没有可展示的转写内容' : '暂无转写结果'}</div>`
            }
          </div>
          ${
            segments.length
              ? `<div style="padding:10px 16px;border-top:1px solid var(--line);background:#fbfcfe" class="small muted">
                  提示：点击时间可跳转播放，点击说话人标签可人工修正角色。共 ${segments.length} 句 · ${transcript?.model ? `模型 ${esc(transcript.model)}` : ''}
                </div>`
              : ''
          }
        </div>
      </div>`;

    container.querySelectorAll('[data-select-rec]').forEach((el) => {
      el.onclick = () => {
        activeRec = Number(el.dataset.selectRec);
        highlightStart = null;
        renderTranscripts(container, { recordings });
      };
    });
    const audio = container.querySelector('#player-audio');
    container.querySelectorAll('[data-seek]').forEach((t) => {
      t.onclick = () => {
        if (!audio) return;
        audio.currentTime = Number(t.dataset.seek);
        audio.play().catch(() => {});
      };
    });
    if (audio) {
      audio.onloadedmetadata = () => {
        if (highlightStart) audio.currentTime = highlightStart;
      };
      audio.ontimeupdate = () => {
        playerTime = audio.currentTime;
        const segs = container.querySelectorAll('.seg');
        let current = null;
        for (const el of segs) {
          const start = Number(el.dataset.start);
          if (start <= playerTime + 0.2) current = el;
          else break;
        }
        segs.forEach((el) => el.classList.toggle('hl', el === current && !audio.paused));
        if (current && !audio.paused) {
          const list = container.querySelector('#seg-list');
          const rect = current.getBoundingClientRect();
          const lrect = list.getBoundingClientRect();
          if (rect.bottom > lrect.bottom - 10 || rect.top < lrect.top + 10) {
            current.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }
      };
    }
    container.querySelectorAll('[data-role-idx]').forEach((badge) => {
      badge.onclick = (e) => {
        e.stopPropagation();
        openRoleMenu(badge, rec.id, Number(badge.dataset.roleIdx), container, recordings);
      };
    });
    container.querySelectorAll('[data-retry-rec]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/api/recordings/${btn.dataset.retryRec}/retry`, { method: 'POST' });
          toast('已重新提交转写，稍后自动刷新', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      };
    });
    if (highlightStart !== null && audio) {
      audio.currentTime = highlightStart;
      audio.play().catch(() => {});
    }
  }

  function openRoleMenu(anchor, recId, segIdx, container, recordings) {
    document.querySelector('.role-menu')?.remove();
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'role-menu';
    menu.style.left = `${rect.left + window.scrollX}px`;
    menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
    menu.innerHTML = `
      <button data-role="agent">${icon('user', 13)} 理赔专员</button>
      <button data-role="customer">${icon('user', 13)} 客户</button>
      <button data-role="unknown">${icon('info', 13)} 未知</button>`;
    document.body.appendChild(menu);
    const close = () => menu.remove();
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
    menu.querySelectorAll('[data-role]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        try {
          await api(`/api/recordings/${recId}/transcript`, {
            method: 'PATCH',
            body: { segments: [{ idx: segIdx, role: btn.dataset.role }] },
          });
          close();
          toast('说话人角色已更新', 'success');
          const fresh = await api(`/api/cases/${caseId}`);
          data = fresh;
          renderTranscripts(container, { recordings: fresh.recordings });
        } catch (err) {
          toast(err.message, 'error');
        }
      };
    });
  }

  /* ---------------- AI 助手 ---------------- */

  function citationPanel(citations) {
    if (!citations) {
      return `<div class="card empty" style="padding:30px 18px">${icon('book')}<h4>引用资料</h4><p>提问后，这里会展示 AI 参考的案件原文片段与企业知识库内容</p></div>`;
    }
    const segs = citations.segments || [];
    const kbs = citations.knowledge || [];
    return `
      <div class="cite-block">
        <header>${icon('quote', 13)}案件录音片段 <span class="badge badge-blue" style="margin-left:auto">${segs.length}</span></header>
        <div class="body">
          ${
            segs.length
              ? segs
                  .map(
                    (s) => `
              <div class="cite-item" data-cite-seg="${esc(s.recordingId)}" data-cite-start="${s.start}">
                <div class="src"><span>录音${s.recordingIndex} · ${esc(s.time)}</span><span style="color:#98a2b3;font-weight:400">${esc(roleName(s.role))}</span></div>
                <div class="txt">${esc(s.text)}</div>
              </div>`,
                  )
                  .join('')
              : '<div class="empty-inline" style="padding:16px">未命中相关录音片段</div>'
          }
        </div>
      </div>
      <div class="cite-block">
        <header>${icon('book', 13)}企业知识库 <span class="badge badge-teal" style="margin-left:auto">${kbs.length}</span></header>
        <div class="body">
          ${
            kbs.length
              ? kbs
                  .map(
                    (k) => `
              <div class="cite-item">
                <div class="src"><span>${esc(k.docName)}</span><span style="color:#98a2b3;font-weight:400">${k.score}</span></div>
                <div class="txt">${esc(k.text)}</div>
              </div>`,
                  )
                  .join('')
              : '<div class="empty-inline" style="padding:16px">知识库未命中，AI 会明确提示无可靠依据</div>'
          }
        </div>
      </div>`;
  }

  function renderChat(container, { c, report }) {
    const messages = data.messages || [];
    const notReady = c.status !== 'ready';
    container.innerHTML = `
      <div class="chat-layout">
        <div class="chat-card">
          <div class="chat-head">
            <div class="assistant-id">
              <div class="bot">${icon('spark', 17)}</div>
              <div>
                <strong>AI 问答 · ${esc(c.code)}</strong>
                <small>结合录音原文${report ? '、分析报告' : ''}与企业知识库回答，可多轮追问</small>
              </div>
            </div>
            <div class="row">
              <button class="btn btn-sm btn-ghost" data-clear-chat ${messages.length ? '' : 'disabled'}>${icon('trash', 13)}清空对话</button>
            </div>
          </div>
          <div class="chat-log" id="chat-log">
            ${
              messages.length
                ? messages.map((m) => msgHtml(m.role, m.content)).join('')
                : `<div class="msg assistant"><div class="bubble">
                    <p>你好，我是本案的 AI 助手。我已阅读 <b>${esc(c.code)}</b> 的 ${data.recordings.length} 段通话录音${report ? '与案件分析报告' : ''}，可以帮你：</p>
                    <ul>
                      <li>梳理客户诉求、关键沟通与尚未解决的问题</li>
                      <li>分析理赔专员的回答是否充分、是否存在信息遗漏</li>
                      <li>结合企业条款与制度，给出有依据的处理建议和沟通口径</li>
                    </ul>
                    <p class="small muted">回答会尽量标注【录音N 时间】与【知识库：文档名】，方便你回听核实。</p>
                  </div></div>`
            }
          </div>
          <div class="composer">
            <div class="quick-asks">
              ${QUICK_QUESTIONS.map((q) => `<button class="chip" data-quick="${esc(q)}">${esc(q)}</button>`).join('')}
            </div>
            <div class="composer-box">
              <textarea id="chat-input" rows="1" placeholder="围绕本案提问，例如：客户还有哪些问题没解决？理赔专员的解释是否充分？">${esc(chatDraft)}</textarea>
              <button class="btn btn-primary" id="send-btn" ${notReady ? 'disabled title="案件尚未完成转写"' : ''}>${icon('send', 15)}发送</button>
            </div>
            <div class="composer-tip">
              <span>${notReady ? '案件尚未完成转写或分析，回答可能不完整' : 'AI 结合案件原文与企业知识库生成，请核实后使用'}</span>
              <span>Enter 发送 · Shift+Enter 换行</span>
            </div>
          </div>
        </div>
        <div class="citation-panel" id="citation-panel">
          <div class="card card-pad" style="padding:13px 15px">
            <div class="row between"><span class="small muted">本案进度</span>${statusBadge(c.status)}</div>
          </div>
          ${citationPanel(lastCitations || lastMessageCitations())}
        </div>
      </div>`;

    const log = container.querySelector('#chat-log');
    log.scrollTop = log.scrollHeight;

    container.querySelectorAll('[data-quick]').forEach((chip) => {
      chip.onclick = () => {
        const input = container.querySelector('#chat-input');
        input.value = chip.dataset.quick;
        chatDraft = input.value;
        input.focus();
      };
    });
    const input = container.querySelector('#chat-input');
    input.oninput = () => {
      chatDraft = input.value;
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(container, c);
      }
    };
    container.querySelector('#send-btn').onclick = () => send(container, c);
    container.querySelector('[data-clear-chat]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: '清空对话', message: '将删除本案的全部问答记录。', confirmText: '清空', danger: true });
      if (!ok) return;
      await api(`/api/cases/${caseId}/messages`, { method: 'DELETE' });
      data.messages = [];
      lastCitations = null;
      renderChat(container, { c, report });
    });
    bindCitationItems(container);
  }

  function lastMessageCitations() {
    const list = (data.messages || []).filter((m) => m.role === 'assistant' && m.citations);
    return list.length ? list[list.length - 1].citations : null;
  }

  function msgHtml(role, content) {
    return `<div class="msg ${role}">
      <div class="bubble">${role === 'assistant' ? renderMarkdown(content) : esc(content).replace(/\n/g, '<br>')}</div>
    </div>`;
  }

  function bindCitationItems(container) {
    container.querySelectorAll('[data-cite-rec], [data-cite-seg]').forEach((el) => {
      el.onclick = () => {
        if (el.dataset.citeSeg) openTranscriptAt(el.dataset.citeSeg, Number(el.dataset.citeStart) || 0);
        else if (el.dataset.citeRec) openTranscriptAt(el.dataset.citeRec, 0);
      };
    });
    container.querySelectorAll('[data-cite-kb]').forEach((el) => {
      el.onclick = () => {
        const panel = container.querySelector('#citation-panel');
        panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
    });
  }

  async function send(container, c) {
    if (chatting) return;
    const input = container.querySelector('#chat-input');
    const question = (input.value || '').trim();
    if (!question) return;
    chatting = true;
    chatDraft = '';
    input.value = '';
    input.style.height = 'auto';
    const log = container.querySelector('#chat-log');
    if (log.querySelector('.msg.assistant .bubble ul') && !data.messages?.length) log.innerHTML = '';
    log.insertAdjacentHTML('beforeend', msgHtml('user', question));
    log.insertAdjacentHTML(
      'beforeend',
      `<div class="msg assistant" id="streaming-msg"><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>`,
    );
    log.scrollTop = log.scrollHeight;
    const bubble = container.querySelector('#streaming-msg .bubble');
    const sendBtn = container.querySelector('#send-btn');
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<span class="spinner"></span> 生成中';

    let fullText = '';
    let frame = null;
    const paint = () => {
      frame = null;
      bubble.innerHTML = renderMarkdown(fullText) || '<span class="typing"><i></i><i></i><i></i></span>';
      const panel = container.querySelector('#citation-panel');
      bindCitationItems(panel);
      log.scrollTop = log.scrollHeight;
    };

    try {
      await streamAnswer(question, {
        onMeta: (payload) => {
          lastCitations = payload;
          const panel = container.querySelector('#citation-panel');
          panel.innerHTML = `<div class="card card-pad" style="padding:13px 15px"><div class="row between"><span class="small muted">本案进度</span>${statusBadge(c.status)}</div></div>${citationPanel(
            payload,
          )}`;
          bindCitationItems(panel);
        },
        onDelta: (text) => {
          fullText += text;
          if (!frame) frame = requestAnimationFrame(paint);
        },
      });
      if (frame) cancelAnimationFrame(frame);
      bubble.innerHTML = renderMarkdown(fullText || '（未返回内容）');
      data.messages = data.messages || [];
      data.messages.push({ role: 'user', content: question }, { role: 'assistant', content: fullText, citations: lastCitations });
    } catch (err) {
      bubble.innerHTML = `<span style="color:#d92d20">${esc(err.message)}</span>`;
      toast(err.message, 'error');
    } finally {
      chatting = false;
      sendBtn.disabled = false;
      sendBtn.innerHTML = `${icon('send', 15)}发送`;
      document.getElementById('streaming-msg')?.removeAttribute('id');
      bindCitationItems(container);
      log.scrollTop = log.scrollHeight;
    }
  }

  /* ---------------- 导出 ---------------- */

  function exportReport() {
    const report = data?.report;
    if (!report) return;
    const lines = [];
    const recs = data.recordings;
    const s = report.summary || {};
    lines.push(`# 案件分析报告 · ${data.case.code}`, '');
    lines.push(`- 理赔专员：${data.case.employeeId || '未知'}`);
    lines.push(`- 录音数量：${recs.length} 段（综合分析）`);
    lines.push(`- 生成时间：${fmtDateTime(report.meta?.generatedAt)}`);
    lines.push(`- 引用核验：${report.meta?.quotes?.verified || 0}/${report.meta?.quotes?.total || 0}`, '');
    const plain = (v) => (typeof v === 'string' ? v : v?.text || v?.description || v?.event || '');
    if (Array.isArray(report.claims) && report.claims.length) {
      lines.push('## 案件整体摘要');
      lines.push(`**整体概述**：${s.overview || '无法判断'}`);
      lines.push(`**核心诉求**：${s.mainClaim || '无法判断'}`);
      lines.push(`**处理进展**：${s.handlingStatus || '无法判断'}`);
      lines.push(`**情绪走向**：${s.emotionTrend || '无法判断'}`);
      lines.push(`**投诉与升级信号**：${s.escalationSummary || '未发现明显升级信号'}`, '');
      lines.push('## 沟通脉络');
      (report.communicationFlow || []).forEach((f) => {
        lines.push(`- ${f.date || '日期未知'}（${f.recording || ''} · ${f.stage || '沟通'}）：客户：${f.customer || '—'}；工作人员：${f.agent || '—'}；结果：${f.result || '—'}`);
      });
      lines.push('');
      (report.claims || []).forEach((cl, i) => {
        const resp = cl.response || {};
        const dispute = cl.dispute || {};
        const emotion = cl.emotion || {};
        const advice = cl.aiAdvice || {};
        lines.push(`## ${cl.id || `C${i + 1}`} ${cl.title || '客户诉求'}`);
        lines.push(`- 类型：${cl.type || '其他'}｜状态：${cl.status || '待核实'}${cl.priority === 'high' ? '｜高优先' : ''}`);
        lines.push(`- 客户诉求：${cl.demand || '无法判断'}`);
        lines.push(`- 工作人员回应：${resp.summary || '无法判断'}${resp.clarity ? `（${resp.clarity}）` : ''}`);
        (resp.promises || []).forEach((p) => lines.push(`  - 承诺：${plain(p)}（时限：${p.due || '未明确'}）`));
        lines.push(`- 不满原因：${dispute.dissatisfaction || '无明显不满'}`);
        lines.push(`- 争议焦点：${dispute.focus || '无明确争议'}`);
        (dispute.customerView ? [lines.push(`- 客户主张（客户陈述）：${dispute.customerView}`)] : []);
        (dispute.confirmedFacts || []).forEach((f) => lines.push(`  - 录音可确认：${plain(f)}`));
        (dispute.unverified || []).forEach((f) => lines.push(`  - 仍需核实：${plain(f)}${f.reason ? `（${f.reason}）` : ''}`));
        (dispute.escalation || []).forEach((e) => lines.push(`  - 升级信号[${e.level || '关注'}]：${plain(e)}`));
        lines.push(`- 情绪分析：${emotion.narrative || '无法判断'}`);
        lines.push(`- 沟通结果：${cl.outcome?.text || '无法判断'}`);
        (cl.pending || []).forEach((p) => lines.push(`  - 待核实：${plain(p)}`));
        (advice.actions || []).forEach((a) => lines.push(`  - 建议[${a.priority || '中'}]：${plain(a)}${a.basis ? `（依据：${a.basis}）` : ''}`));
        if (advice.missingBasis) lines.push(`  - 依据说明：${advice.missingBasis}`);
        if (cl.deepDive?.conclusion) lines.push(`- AI 深度分析：${cl.deepDive.conclusion}`);
        lines.push('');
      });
      lines.push('## 案件级处理建议');
      (report.recommendations?.verification || []).forEach((v) => lines.push(`- 核实：${plain(v)}`));
      (report.recommendations?.materials || []).forEach((v) => lines.push(`- 材料：${plain(v)}`));
      (report.recommendations?.nextActions || []).forEach((v) => lines.push(`- 行动：${plain(v)}`));
      lines.push('');
    } else {
      lines.push('## 案件核心摘要');
      lines.push(`**案件背景**：${s.background || '无法判断'}`);
      lines.push(`**主要事件**：${s.events || '无法判断'}`);
      lines.push(`**当前处理情况**：${s.currentStatus || '无法判断'}`);
      lines.push(`**客户核心诉求**：${s.customerDemands || '无法判断'}`, '');
      const section = (title, arr) => {
        lines.push(`## ${title}`);
        (arr || []).forEach((item) => lines.push(`- ${plain(item)}`));
        lines.push('');
      };
      section('事故经过', report.facts?.accident);
      section('客户陈述', report.facts?.customerStatements);
      section('尚待核实的信息', report.facts?.pending);
      section('客户主要问题', report.communication?.questions);
      section('客户不满事项', report.communication?.dissatisfactions);
      section('客户异议', report.communication?.objections);
      section('理赔专员回应情况', report.communication?.agentResponses);
      section('解释不充分或存在歧义的地方', report.communication?.unclearPoints);
      lines.push('## 问题与风险');
      (report.risks || []).forEach((r) => lines.push(`- [${r.severity || '中'}] ${r.type || ''}：${plain(r)}`));
      lines.push('');
      section('需要进一步核实', report.recommendations?.verification);
      section('需要补充的材料', report.recommendations?.materials);
      section('下一步行动', report.recommendations?.nextActions);
      section('沟通与业务改进建议', (report.suggestions || report.coach)?.actions);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${data.case.code}-案件分析报告.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('报告已导出', 'success');
  }

  await load();

  timer = setInterval(() => {
    if (document.hidden) return;
    if (!data) return;
    if (['queued', 'processing'].includes(data.case.status)) {
      const scrollY = window.scrollY;
      load(true).then(() => {
        if (tab !== 'chat') window.scrollTo(0, scrollY);
      });
    }
  }, 3000);

  return () => {
    clearInterval(timer);
    document.querySelector('.role-menu')?.remove();
  };
}
