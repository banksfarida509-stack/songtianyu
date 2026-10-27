// Normalise platform card data into one candidate shape, then screen it with
// deterministic rules. The verdict always comes from here, never from the LLM.
import { clip } from './util.js';

const EDU_RANK = { 初中: 0, 高中: 1, 中专: 1, 中技: 1, 大专: 2, 本科: 3, 硕士: 4, MBA: 4, EMBA: 4, 博士: 5 };
export const eduRank = e => {
  if (!e) return -1;
  for (const [k, v] of Object.entries(EDU_RANK)) if (String(e).includes(k)) return v;
  return -1;
};

const num = v => {
  const m = String(v ?? '').match(/\d+/);
  return m ? Number(m[0]) : null;
};

/** a full mainland mobile number in a text, or '' (masked numbers like 138****1234 do not count) */
export function mobileIn(text) {
  const m = String(text || '').replace(/[\s-]/g, '').match(/(?<!\d)1[3-9]\d{9}(?!\d)/);
  return m ? m[0] : '';
}

/**
 * Field whitelist: only what screening needs, plus the mobile number when the
 * platform already shows it in full to the recruiter. Photos and ID numbers are
 * never accepted even if a client sends them.
 */
export function normalizeZhaopin(raw) {
  const work = (raw.workExperiences || []).slice(0, 6).map(w => ({
    t: [w.beginDate, w.endDate].filter(Boolean).join('-'),
    org: clip(w.companyName, 60), role: clip(w.jobTitle || w.jobSubTitle, 40),
  }));
  const edus = (raw.educationExperiences || []).slice(0, 4).map(e => ({
    t: [e.beginDate, e.endDate].filter(Boolean).join('-'),
    school: clip(e.schoolName, 60), major: clip(e.majorName, 40), deg: clip(e.educationLevel, 10), tag: clip(e.schoolTag, 20), mode: clip(e.mode, 30),
    begin: clip(e.beginDate, 20), end: clip(e.endDate, 20),
  }));
  const top = edus[0] || {};
  return {
    // collapse a repeated platform prefix (an extension bug once produced “boss-boss-…-id”)
    uid: String(raw.resumeNumber || raw.uid || '').replace(/^(boss-)+/, 'boss-'),
    name: clip(raw.userName || raw.name, 20),
    gender: raw.gender ? clip(raw.gender, 4) : null,
    age: num(raw.age),
    edu: clip(raw.educationLevel || top.deg, 10),
    school: top.school || null,
    school_tag: top.tag || null,
    major: top.major || null,
    years: clip(raw.workYearsLabel || raw.workYears, 12),
    career_status: clip(raw.careerStatus, 20),
    expect: clip([raw.cityLabel || raw.desiredCity, raw.intentText || raw.desiredJobType, raw.desiredSalary].filter(x => typeof x === 'string' && x).join(' · '), 120),
    intent: clip(typeof raw.intentText === 'string' ? raw.intentText : typeof raw.desiredJobType === 'string' ? raw.desiredJobType : '', 200),
    work, edus,
    skills: (raw.skillTags || []).slice(0, 12).map(x => clip(x, 20)),
    certs: (raw.certificateNames || []).slice(0, 10).map(x => clip(x, 40)),
    self_eval: clip(raw.selfEvaluation, 400),
    phone: mobileIn(raw.phone),
    grad: clip(raw.gradText, 20), // graduation label / field from the card (screening only, not stored)
  };
}

// usual length of study, to estimate graduation when an education entry ends “至今”
const STUDY_YEARS = [['博士', 4], ['硕士', 3], ['本科', 4], ['大专', 3], ['专科', 3]];
/**
 * Graduation year: the latest end year among education entries; an entry still running
 * (“至今”) ends start year + usual length; else a “27届 / 2027届” label in the
 * resume text. null when unknown.
 */
export function gradYearOf(c) {
  let best = null;
  const take = y => { if (y && (best == null || y > best)) best = y; };
  const yearIn = s => { const m = String(s || '').match(/(?:19|20)\d{2}/); return m ? Number(m[0]) : null; };
  const study = e => (STUDY_YEARS.find(([k]) => String(e.deg || '').includes(k)) || [0, 4])[1];
  for (const e of c.edus || []) {
    if ('end' in e || 'begin' in e) {
      // separate start / end (cards read since v0.9.3)
      if (yearIn(e.end)) take(yearIn(e.end));
      else if (/至今|今|在读/.test(e.end || '') && yearIn(e.begin)) take(yearIn(e.begin) + study(e));
      continue;
    }
    // older rows: only “start-end” text; a single year without “至今” could be either, so it is skipped
    const t = String(e.t || '');
    const ys = (t.match(/(?:19|20)\d{2}/g) || []).map(Number);
    if (/至今|今|在读/.test(t) && ys.length === 1) take(ys[0] + study(e));
    else if (ys.length >= 2) take(Math.max(...ys));
  }
  if (best == null) take(yearIn(c.grad));
  // the platform's “在校生” mark: still at school, so graduating next year at the earliest
  if (best == null && /在校/.test(c.grad || '')) take(new Date().getFullYear() + 1);
  if (best == null) {
    const m = `${c.grad || ''} ${c.years || ''} ${c.intent || ''} ${c.expect || ''} ${c.self_eval || ''}`.match(/(?<!\d)(20)?(\d{2})\s*(?:届|年毕业|年应届)/);
    if (m) take(2000 + Number(m[2]));
  }
  return best;
}
/**
 * Hard rule for every role: people graduating after `maxGradYear` (still at school) are
 * 不推荐. Not widened by the AI notes review (rule G01 has hard: true).
 */
export function applyGradRule(sc, c, maxGradYear) {
  const max = Number(maxGradYear);
  if (!max) return sc;
  const y = gradYearOf(c);
  if (y == null) return sc;
  const rule = { id: 'G01', name: `毕业年份 ${max} 年及以前`, ok: y <= max, ev: `${y} 年毕业`, hard: true };
  if (y <= max) return { ...sc, rules: [...sc.rules, rule] };
  return { ...sc, verdict: '不推荐', score: Math.min(sc.score, 40), rules: [...sc.rules, rule], reason: `${y} 年毕业（还在上学），只招 ${max} 年及以前毕业的`, gradFail: true };
}

const NON_TZ = /非统招|自考|成人|函授|网络|业余|非全日制|开放|夜大/;
const ZHUAN_SCHOOL = /职业学院|职业技术学院|高等专科|专科学校|高职|职业大学(?!.*本科)|专修学院/;
const yearOf = s => { const m = String(s || '').match(/(?:19|20)\d{2}/); return m ? Number(m[0]) : null; };
// start / end year of an education entry (separate fields since v0.9.3, else the “start-end” text)
const spanOf = e => {
  if ('begin' in e || 'end' in e) return [yearOf(e.begin), /至今|今|在读/.test(e.end || '') ? null : yearOf(e.end)];
  const ys = (String(e.t || '').match(/(?:19|20)\d{2}/g) || []).map(Number);
  return ys.length >= 2 ? [ys[0], ys[ys.length - 1]] : [null, null];
};
/**
 * 统招全日制本科 as the first degree. Returns { ok, ev }: ok false for 专升本 (a 大专 entry
 * before the 本科, or a 本科 of two years or less), a 本科 marked 非统招 / 自考 …, or no 本科 at all;
 * null when the resume has no 本科 entry details to judge from.
 */
export function bachelorCheck(c) {
  const edus = c.edus || [];
  const bach = edus.filter(e => eduRank(e.deg) === 3);
  if (!bach.length) {
    if (eduRank(c.edu) >= 0 && eduRank(c.edu) < 3) return { ok: false, ev: `${c.edu}学历` };
    return { ok: null, ev: '简历没有本科学历的详细信息' };
  }
  const isZhuan = e => eduRank(e.deg) === 2 || (eduRank(e.deg) < 0 && ZHUAN_SCHOOL.test(e.school || ''));
  // a 大专 counts only when it came before the 本科 (a language school after graduating does not)
  const bachStart = Math.min(...bach.map(e => spanOf(e)[0] || Infinity));
  const zhuan = edus.find(e => { if (!isZhuan(e)) return false; const zEnd = spanOf(e)[1]; return !zEnd || !Number.isFinite(bachStart) || zEnd <= bachStart + 1; });
  if (zhuan) return { ok: false, ev: `专升本（大专：${zhuan.school || '专科院校'}）` };
  const short = bach.find(e => { const [b, en] = spanOf(e); return b && en && en - b <= 2; });
  if (short) { const [b, en] = spanOf(short); return { ok: false, ev: `本科只读了 ${en - b} 年（${short.school || ''} ${b}–${en}），按专升本处理` }; }
  if (bach.every(e => NON_TZ.test(e.mode || ''))) return { ok: false, ev: `本科非统招（${bach[0].mode}）` };
  return { ok: true, ev: `${bach[0].school || ''} 本科${/统招|全日制/.test(bach[0].mode || '') ? '（统招）' : ''}` };
}

// ---------- 教师岗赋分标准（负责人在后台填的，rules.scoring） ----------
// 985 / 211 院校（院校名去掉括号里的校区后完全一致才算，避免“XX大学城市科技学院”这类独立学院误判）
const U985 = '清华大学 北京大学 中国人民大学 北京航空航天大学 北京理工大学 中国农业大学 北京师范大学 中央民族大学 南开大学 天津大学 大连理工大学 东北大学 吉林大学 哈尔滨工业大学 复旦大学 同济大学 上海交通大学 华东师范大学 南京大学 东南大学 浙江大学 中国科学技术大学 厦门大学 山东大学 中国海洋大学 武汉大学 华中科技大学 湖南大学 中南大学 中山大学 华南理工大学 四川大学 电子科技大学 重庆大学 西安交通大学 西北工业大学 西北农林科技大学 兰州大学 国防科技大学'.split(' ');
const U211 = '北京交通大学 北京工业大学 北京科技大学 北京化工大学 北京邮电大学 北京林业大学 北京中医药大学 北京外国语大学 中国传媒大学 中央财经大学 对外经济贸易大学 北京体育大学 中央音乐学院 中国政法大学 华北电力大学 中国矿业大学 中国石油大学 中国地质大学 天津医科大学 河北工业大学 太原理工大学 内蒙古大学 辽宁大学 大连海事大学 延边大学 东北师范大学 哈尔滨工程大学 东北农业大学 东北林业大学 华东理工大学 东华大学 上海外国语大学 上海财经大学 上海大学 苏州大学 南京航空航天大学 南京理工大学 河海大学 江南大学 南京农业大学 中国药科大学 南京师范大学 安徽大学 合肥工业大学 福州大学 南昌大学 郑州大学 武汉理工大学 华中农业大学 华中师范大学 中南财经政法大学 湖南师范大学 暨南大学 华南师范大学 广西大学 海南大学 西南交通大学 四川农业大学 西南财经大学 西南大学 贵州大学 云南大学 西藏大学 西北大学 西安电子科技大学 长安大学 陕西师范大学 青海大学 宁夏大学 新疆大学 石河子大学 海军军医大学 空军军医大学 第二军医大学 第四军医大学'.split(' ');
const TOP_SET = new Set([...U985, ...U211]);
/** 一段教育经历的学校是不是 985 / 211：平台给的院校标签，或院校名在名单里 */
export function is985or211(e) {
  if (/985|211/.test(`${e.tag || ''}`)) return true;
  const name = String(e.school || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '').replace(/(分校|校区|医学部|本部)$/, '');
  return TOP_SET.has(name);
}
// 年月：“2020.09” “2020-9” “2020年9月” → 月序号；“至今 / 今”→ 现在
export const monthOf = s => {
  const t = String(s || '');
  if (/至今|今|现在/.test(t)) { const d = new Date(); return d.getFullYear() * 12 + d.getMonth(); }
  const m = t.match(/((?:19|20)\d{2})(?:\D{1,2}(\d{1,2}))?/);
  return m ? Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0) : null;
};
/** 一段工作经历的月数；起止都认不出时 null */
export function monthsOf(w) {
  const t = String(w.t || '');
  const parts = t.split(/\s*(?:-|–|—|~|至(?!今))\s*/).filter(Boolean);
  if (parts.length < 2) return null;
  const a = monthOf(parts[0]), b = monthOf(parts[parts.length - 1]);
  return a != null && b != null && b >= a ? b - a + 1 : null;
}
// 教育工作：公立 / 私立学校、任何教育机构都算，不看规模；或者职位本身是教学类
const EDU_WORK_ORG = /学校|中学|小学|一中|二中|三中|附中|实验|学院|大学|幼儿园|教育|培训|辅导|学堂|课堂|网校|教培|书院|托管|早教|学而思|新东方|好未来|学大|精锐|昂立|卓越|猿辅导|作业帮|高途|掌门|豆神|思维/;
const EDU_WORK_ROLE = /教师|老师|讲师|助教|家教|教研|班主任|教学|辅导|授课|主讲|学科|教练/;
export const isEduWork = w => EDU_WORK_ROLE.test(w.role || '') || (EDU_WORK_ORG.test(w.org || '') && !/销售|顾问|招生|市场|财务|会计|行政|人事|司机|保安|保洁|厨师|IT|开发|设计/.test(w.role || ''));

export const DEFAULT_SCORING = {
  enabled: true,
  base: 60,              // 本科，应届或毕业后 30 岁以内、求职方向是教学类 → 60 分
  freshMaxAge: 30,       // 没有教育工作经验时的年龄上限
  maxAge: 42,            // 超过一律不合适
  masterBonus: 5,        // 研究生学历
  bach985: 5,            // 本科 985 / 211
  master985: 5,          // 研究生 985 / 211（再加）
  // 教育工作经验（月数 → 加分），不叠加，取够得着的最高一档
  exp: [[6, 5], [12, 10], [36, 15], [60, 20]],
  intentKeywords: ['家教', '教学', '教师', '老师', '理科教师', '文科教师', '高中教师', '初中教师', '小学教师', '助教', '讲师', '教研', '班主任'],
};

/**
 * 教师岗：按负责人的赋分标准判定和打分。结论：
 *   超过 maxAge 岁 / 学历不够 / 非统招本科（开关）→ 不推荐
 *   有教育工作经验（学校、任何教育机构）→ 推荐
 *   没有经验：≤ freshMaxAge 岁且求职方向是教学类 → 推荐；超龄或方向不对 → 不推荐；简历没写方向 → 待确认
 * 分数：base + 研究生 + 本科 985/211 + 研究生 985/211 + 教育经验档位（不叠加）。不推荐的封顶 40。
 */
export function screenTeacherStd(c, rules) {
  const S = { ...DEFAULT_SCORING, ...(rules.scoring || {}) };
  const exp = Array.isArray(S.exp) && S.exp.length ? [...S.exp].sort((a, b) => a[0] - b[0]) : DEFAULT_SCORING.exp;
  const r = [];
  r.push({ id: 'R01', name: `年龄 ≤ ${S.maxAge}`, ok: c.age == null ? null : c.age <= S.maxAge, ev: c.age == null ? '页面未显示年龄' : `${c.age} 岁`, hard: true });
  r.push({ id: 'R02', name: `学历 ${rules.minEdu}及以上`, ok: eduRank(c.edu) < 0 ? null : eduRank(c.edu) >= eduRank(rules.minEdu), ev: c.edu || '页面未显示学历', hard: true });
  const bc = rules.requireTongzhaoBachelor ? bachelorCheck(c) : null;
  if (bc && bc.ok !== null) r.push({ id: 'R06', name: '统招全日制本科（不含专升本、非统招）', ok: bc.ok, ev: bc.ev, hard: true });

  // 教育工作经验：能算出月数的经历加起来；都算不出时，用简历上的总工作年限
  const eduWork = (c.work || []).filter(isEduWork);
  let months = null;
  if (eduWork.length) {
    const known = eduWork.map(monthsOf).filter(m => m != null);
    if (known.length) months = known.reduce((a, b) => a + b, 0);
    else { const y = num(c.years); months = y != null ? y * 12 : null; }
  }
  const tier = months == null ? null : [...exp].reverse().find(([m]) => months >= m) || null;
  const expTxt = months == null ? '' : months >= 12 ? `${Math.floor(months / 12)} 年${months % 12 ? months % 12 + ' 个月' : ''}` : `${months} 个月`;
  r.push({ id: 'R04', name: '教育工作经验（公立 / 私立学校、任何教育机构都算）', ok: eduWork.length ? true : false,
    ev: eduWork.length ? `${eduWork[0].org || ''} ${eduWork[0].role || ''}${expTxt ? `，共约 ${expTxt}` : '，年限未知'}` : '无教育工作经历' });

  const intentText = `${c.intent || ''} ${c.expect || ''}`;
  const kws = [...new Set([...(S.intentKeywords || []), ...(rules.intentKeywords || [])])];
  const intentHit = kws.find(k => k && intentText.includes(k));
  const fresh = !eduWork.length;
  if (fresh) r.push({ id: 'R05', name: `没有经验：${S.freshMaxAge} 岁以内、求职方向是教学类`, ok: !intentText.trim() ? null : !!intentHit && (c.age == null ? null : c.age <= S.freshMaxAge),
    ev: !intentText.trim() ? '简历没写求职方向' : intentHit ? `求职方向含“${intentHit}”，${c.age ?? '?'} 岁` : '求职方向不是教学类' });

  // 分数
  const isMaster = eduRank(c.edu) >= 4 || (c.edus || []).some(e => eduRank(e.deg) >= 4);
  const bach = (c.edus || []).filter(e => eduRank(e.deg) === 3), mast = (c.edus || []).filter(e => eduRank(e.deg) >= 4);
  // 只有顶部学校标签、没有逐段信息时，标签算在最高学历上
  const topTag = /985|211/.test(c.school_tag || '');
  const bachTop = bach.some(is985or211) || (topTag && !isMaster && !bach.length && eduRank(c.edu) === 3);
  const mastTop = mast.some(is985or211) || (topTag && isMaster && !mast.length);
  const parts = [[`基础分（${rules.minEdu}${fresh ? `，${S.freshMaxAge} 岁以内求职教学类` : ''}）`, S.base]];
  if (isMaster) parts.push(['研究生学历', S.masterBonus]);
  if (bachTop) parts.push(['本科 985 / 211', S.bach985]);
  if (mastTop) parts.push(['研究生 985 / 211', S.master985]);
  if (tier) parts.push([`教育工作经验 ${expTxt}（满 ${tier[0] >= 12 ? tier[0] / 12 + ' 年' : tier[0] + ' 个月'}档）`, tier[1]]);
  const raw = parts.reduce((a, [, v]) => a + (Number(v) || 0), 0);

  const live = r;
  const hardFail = live.find(x => x.hard && x.ok === false);
  let verdict;
  if (hardFail) verdict = '不推荐';
  else if (!fresh) verdict = live.some(x => x.ok === null) ? '待确认' : '推荐';
  else { const r5 = r.find(x => x.id === 'R05'); verdict = r5.ok === false ? '不推荐' : r5.ok === null || live.some(x => x.ok === null) ? '待确认' : '推荐'; }
  const score = Math.max(0, Math.min(100, verdict === '不推荐' ? Math.min(raw, 40) : raw));
  r.push({ id: 'S', name: '赋分明细', ok: true, ev: parts.map(([k, v]) => `${k} +${v}`).join('；').replace('+' + S.base, S.base) + ` = ${raw}`, raw });

  let reason;
  const f = hardFail || r.find(x => x.id === 'R05' && x.ok === false);
  if (verdict === '不推荐') reason = !f ? '不符合赋分标准' : f.id === 'R01' ? `年龄 ${c.age} 岁，超过 ${S.maxAge} 岁一律不合适` : f.id === 'R02' ? `${c.edu}学历，要求${rules.minEdu}及以上`
    : f.id === 'R06' ? `${f.ev}，教师岗要求统招全日制本科` : intentHit ? `没有教育工作经验，${c.age} 岁超过 ${S.freshMaxAge} 岁` : '没有教育工作经验，求职方向也不是教学类';
  else if (verdict === '待确认') reason = `${(r.find(x => x.ok === null) || {}).ev || '信息不全'}，需你确认`;
  else reason = `${c.age ?? ''}岁 ${c.edu || ''}${bachTop || mastTop ? '（985/211）' : ''}；${fresh ? `无经验，求职方向“${intentHit}”` : `教育经验${expTxt || ''}`}；${raw} 分`;
  return { verdict, score, rules: r, reason: clip(reason.trim(), 80) };
}

export function screen(c, rules) {
  // 后台填了赋分标准（默认开）：教师岗完全按它判定和打分
  if (rules.scoring && rules.scoring.enabled !== false) return screenTeacherStd(c, rules);
  const re = p => new RegExp(p);
  const titles = c.work.map(w => `${w.org} ${w.role}`).join(' | ');
  const kwHit = rules.subjectKeywords.find(k => (c.major || '').includes(k) || c.work.some(w => (w.role || '').includes(k)) || c.skills.some(x => x.includes(k)));
  const schoolTeach = c.work.find(w => re(rules.schoolPattern).test(`${w.org}${w.role}`) && !re(rules.trainingPattern).test(w.org || ''));
  const trainTeach = c.work.find(w => re(rules.trainingPattern).test(w.org || '') && /教|师|辅导|讲/.test(w.role || ''));
  const normal = c.edus.some(e => /师范/.test(e.school || '')) || /学科教学|教育/.test(c.major || '');
  const fresh = !c.work.length || /应届/.test(c.years || '');
  const hasCert = c.certs.some(x => /教师资格/.test(x));

  const r = [];
  r.push({ id: 'R01', name: `年龄 ≤ ${rules.maxAge}`, ok: c.age == null ? null : c.age <= rules.maxAge, ev: c.age == null ? '页面未显示年龄' : `${c.age} 岁` });
  // education is a hard requirement: the AI notes review never widens it
  r.push({ id: 'R02', name: `学历 ${rules.minEdu}及以上`, ok: eduRank(c.edu) < 0 ? null : eduRank(c.edu) >= eduRank(rules.minEdu), ev: c.edu || '页面未显示学历', hard: true });
  // 统招全日制本科, first degree 本科 (no 专升本 / 非统招)
  const bc = rules.requireTongzhaoBachelor ? bachelorCheck(c) : null;
  if (bc && bc.ok !== null) r.push({ id: 'R06', name: '统招全日制本科（不含专升本、非统招）', ok: bc.ok, ev: bc.ev, hard: true });
  r.push({ id: 'R03', name: '专业或教学经历对口', ok: !!kwHit, ev: kwHit ? `命中“${kwHit}”：${c.major || ''}` : `${c.major || '专业未知'}；${titles || '无工作经历'}` });
  let r4ok, r4ev;
  if (schoolTeach) { r4ok = true; r4ev = `${schoolTeach.org} · ${schoolTeach.role}`; }
  else if (normal) { r4ok = true; r4ev = `${c.school}（师范 / 教育类）`; }
  else if (trainTeach) { r4ok = null; r4ev = `只有培训机构经历：${trainTeach.org}`; }
  else if (fresh) { r4ok = null; r4ev = '应届，非师范，无教学经历'; }
  else { r4ok = false; r4ev = titles || '无教学经历'; }
  r.push({ id: 'R04', name: '学校教学经历或师范院校', ok: r4ok, ev: r4ev });

  // R05 意向型：年轻、学历够、求职方向是教师类，没有教学经验 / 专业不对口也可以打招呼
  const intentText = `${c.intent || ''} ${c.expect || ''}`;
  const intentHit = (rules.intentKeywords || []).find(k => k && intentText.includes(k));
  const young = c.age != null && c.age <= (rules.intentMaxAge ?? 30) && eduRank(c.edu) >= eduRank(rules.intentMinEdu || '本科');
  const intentPass = rules.intentTrack !== false && !!intentHit && young && !schoolTeach && !normal;
  if (intentPass) {
    for (const x of r) if ((x.id === 'R03' || x.id === 'R04') && x.ok !== true) { x.waived = true; x.ev += '（意向型放宽）'; }
    r.push({ id: 'R05', name: `意向型：${rules.intentMinEdu || '本科'}+、≤${rules.intentMaxAge ?? 30} 岁、求职方向含教师类关键词`, ok: true, ev: `${c.age} 岁 ${c.edu}，求职方向命中“${intentHit}”` });
  }

  const live = r.filter(x => !x.waived);
  const verdict = live.some(x => x.ok === false) ? '不推荐' : live.some(x => x.ok === null) ? '待确认' : '推荐';
  const yrs = num(c.years) ?? 0;
  let score = 55 + (schoolTeach ? 12 : 0) + (normal ? 8 : 0) + (/985|211|双一流/.test(c.school_tag || '') ? 8 : 0)
    + Math.min(yrs, 3) * 4 + (eduRank(c.edu) >= 4 ? 4 : 0) + (hasCert ? 4 : 0) - (trainTeach && !schoolTeach ? 6 : 0);
  if (intentPass) score = Math.min(score, 66) - (kwHit ? 0 : 4);
  if (verdict === '不推荐') score = Math.min(score, 40);
  score = Math.max(0, Math.min(98, score));

  const f = live.find(x => x.ok === false), u = live.find(x => x.ok === null);
  let reason;
  if (verdict === '推荐' && intentPass) reason = `${c.age} 岁 ${c.edu}，${c.school || ''} ${c.major || ''}；无教学经验，但求职方向是“${intentHit}”（意向型）`;
  else if (verdict === '推荐') reason = `${c.school || ''}${c.school_tag ? ' ' + c.school_tag : ''} ${c.major || ''}；${schoolTeach ? schoolTeach.role || '学校教学经历' : '师范背景'}${hasCert ? '；有教师资格证' : '；资格证待追问'}`;
  else if (verdict === '待确认') reason = `${u.ev}，需你确认`;
  else reason = f.id === 'R06' ? `${f.ev}，教师岗要求统招全日制本科` : f.id === 'R01' ? `年龄 ${c.age} 岁，超过 ${rules.maxAge} 岁上限` : f.id === 'R02' ? `${c.edu}学历，要求${rules.minEdu}及以上` : f.id === 'R03' ? `${c.major || '专业'}与岗位科目不对口` : `无学校教学经历：${f.ev}`;
  return { verdict, score, rules: r, reason: clip(reason.trim(), 80) };
}
