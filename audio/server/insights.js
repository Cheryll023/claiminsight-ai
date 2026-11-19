import { jsonParse } from './db.js';

/**
 * 汇总一个批次内所有已分析案件，生成批量业务洞察。
 * 仅基于结构化报告聚合，不额外调用大模型，保证无 API Key 时也能查看。
 */
export function computeBatchInsights(cases) {
  const analyzed = cases.filter((c) => c.status === 'ready' && c.report_json);
  const byType = new Map();
  const byStatus = new Map();
  const emotions = new Map();
  const triggerMap = new Map();
  const dissatisfactionMap = new Map();
  const escalations = [];
  const pending = [];
  const advice = [];
  const caseBriefs = [];

  const bump = (map, key, info) => {
    if (!key) return;
    const text = String(key).trim();
    if (!text) return;
    const item = map.get(text) || { text, count: 0, cases: new Set() };
    item.count += 1;
    if (info?.caseCode) item.cases.add(info.caseCode);
    map.set(text, item);
  };

  for (const row of analyzed) {
    const report = jsonParse(row.report_json, null);
    if (!report) continue;
    const claims = Array.isArray(report.claims) ? report.claims : [];
    let escalationCount = 0;
    let pendingCount = 0;

    for (const claim of claims) {
      bump(byType, claim.type || '其他', { caseCode: row.code });
      bump(byStatus, claim.status || '待核实');
      for (const label of claim.emotion?.labels || []) bump(emotions, label);
      for (const t of claim.dispute?.triggers || []) bump(triggerMap, t.text, { caseCode: row.code });
      if (claim.dispute?.dissatisfaction && claim.dispute.dissatisfaction !== '无明显不满') {
        bump(dissatisfactionMap, claim.dispute.dissatisfaction, { caseCode: row.code });
      }
      for (const e of claim.dispute?.escalation || []) {
        escalationCount += 1;
        escalations.push({
          caseCode: row.code,
          caseId: row.id,
          claimId: claim.id,
          claimTitle: claim.title,
          level: e.level || '关注',
          text: e.text || '',
        });
      }
      for (const p of claim.pending || []) {
        pendingCount += 1;
        pending.push({
          caseCode: row.code,
          caseId: row.id,
          claimId: claim.id,
          claimTitle: claim.title,
          text: p.text || '',
          reason: p.reason || '',
        });
      }
      for (const a of claim.aiAdvice?.actions || []) {
        advice.push({
          caseCode: row.code,
          caseId: row.id,
          claimId: claim.id,
          claimTitle: claim.title,
          text: a.text || '',
          priority: a.priority || '',
          basis: a.basis || '',
        });
      }
    }

    for (const s of report.riskSignals || []) {
      if (s.type !== '投诉升级' || claims.length) continue;
      escalationCount += 1;
      escalations.push({
        caseCode: row.code,
        caseId: row.id,
        claimId: s.claimId || '',
        claimTitle: s.claimId ? claims.find((c) => c.id === s.claimId)?.title || '' : '',
        level: s.level || '关注',
        text: s.text || '',
      });
    }

    caseBriefs.push({
      id: row.id,
      code: row.code,
      employeeId: row.employee_id,
      claimCount: claims.length,
      escalationCount,
      pendingCount,
      mainClaim: report.summary?.mainClaim || report.summary?.overview || '',
    });
  }

  const sortMap = (map) =>
    [...map.values()]
      .map((v) => ({ text: v.text, count: v.count, cases: [...v.cases].slice(0, 6) }))
      .sort((a, b) => b.count - a.count);

  const listCount = (map) => [...map.values()].map((v) => ({ label: v.text, count: v.count })).sort((a, b) => b.count - a.count);

  const levelWeight = { 紧急: 3, 预警: 2, 关注: 1 };
  escalations.sort((a, b) => (levelWeight[b.level] || 0) - (levelWeight[a.level] || 0));

  const totalClaims = byType.size ? [...byType.values()].reduce((s, v) => s + v.count, 0) : 0;
  return {
    totalCases: cases.length,
    analyzedCases: analyzed.length,
    claimCount: totalClaims,
    pendingCount: pending.length,
    escalationCount: escalations.length,
    byType: listCount(byType).map((x) => ({ ...x, ratio: totalClaims ? Math.round((x.count / totalClaims) * 100) : 0 })),
    byStatus: listCount(byStatus),
    emotions: listCount(emotions),
    escalations: escalations.slice(0, 8),
    triggers: sortMap(triggerMap).slice(0, 6),
    dissatisfactions: sortMap(dissatisfactionMap).slice(0, 6),
    pending: pending.slice(0, 10),
    advice: advice.slice(0, 8),
    cases: caseBriefs,
  };
}
