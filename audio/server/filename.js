const TYPE_TERMS = [
  '首次沟通', '二次沟通', '三次沟通', '首次联系', '再次沟通', '客户回访', '电话回访', '回访',
  '材料催收', '资料催收', '补充材料', '定损沟通', '查勘沟通', '现场查勘', '报价沟通',
  '拒赔沟通', '拒赔通知', '调解沟通', '协商沟通', '赔付沟通', '结案沟通', '投诉沟通',
  '事故核实', '责任认定', '理赔沟通', '沟通', '回访记录',
];

export function formatDate(compact) {
  if (!compact || compact.length !== 8) return '';
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

export function parseRecordingName(filename) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const warnings = [];
  let rest = base;

  // 日期：20261118 / 2026-11-18 / 2026_11_18
  let date = '';
  const compactDate = rest.match(/(20\d{2})(\d{2})(\d{2})/);
  const sepDate = rest.match(/(20\d{2})[-_.](\d{1,2})[-_.](\d{1,2})/);
  if (sepDate) {
    const mm = sepDate[2].padStart(2, '0');
    const dd = sepDate[3].padStart(2, '0');
    date = `${sepDate[1]}-${mm}-${dd}`;
    rest = rest.replace(sepDate[0], ' ');
  } else if (compactDate) {
    const mm = compactDate[2];
    const dd = compactDate[3];
    date = `${compactDate[1]}-${mm}-${dd}`;
    rest = rest.replace(compactDate[0], ' ');
  } else {
    warnings.push('文件名中未识别到日期');
  }

  // 案件号：CASE1001 / CLM2026001 / 案件号：XXX
  let caseCode = '';
  const prefixed = rest.match(/(?:案件号|案件编号|案号)?\s*[:：]?\s*((?:CASE|CLM|CLAIM|AJ|LB)[-_]?[A-Za-z0-9]{3,})/i);
  if (prefixed) {
    caseCode = normalizeCaseCode(prefixed[1]);
    rest = rest.replace(prefixed[0], ' ');
  } else {
    const generic = rest.match(/(?<![A-Za-z0-9])([A-Z]{2,4}\d{4,})(?![A-Za-z0-9])/);
    if (generic) {
      caseCode = normalizeCaseCode(generic[1]);
      rest = rest.replace(generic[0], ' ');
      warnings.push('案件编号为推断结果，请人工确认');
    }
  }
  if (!caseCode) warnings.push('文件名中未识别到案件编号，需要人工指定');

  // 员工编号：5 位纯数字（4-6 位，且不是日期残留）
  let employeeId = '';
  const emp = rest.match(/(?<!\d)(\d{4,6})(?!\d)/);
  if (emp) {
    employeeId = emp[1];
    rest = rest.replace(emp[0], ' ');
  }

  // 录音类型
  let recType = '';
  for (const term of TYPE_TERMS) {
    if (rest.includes(term)) {
      recType = term;
      break;
    }
  }
  if (!recType) {
    const tokens = rest.split(/[_\-—\s（）()【】\[\]]+/).filter(Boolean);
    const candidate = tokens.find((t) => /[\u4e00-\u9fa5]{2,}/.test(t) && !/案件/.test(t));
    if (candidate) recType = candidate.slice(0, 20);
  }
  if (!recType) warnings.push('未识别到录音类型');

  const confidence = caseCode ? (warnings.includes('案件编号为推断结果，请人工确认') ? 'medium' : 'high') : 'low';

  return { date, caseCode, employeeId, recType, confidence, warnings };
}

export function normalizeCaseCode(raw) {
  if (!raw) return '';
  return raw
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[-_](?=[A-Z0-9])/g, '')
    .replace(/^(CLAIM)/, 'CLM');
}

const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'amr', 'wma', 'webm', 'mp4']);

export function isAudioFile(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return AUDIO_EXT.has(ext);
}

export function extOf(name) {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

export function isZipName(name) {
  return /\.zip$/i.test(name);
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
