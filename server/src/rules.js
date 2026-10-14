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

export function screen(c, rules) {
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
  r.push({ id: 'R02', name: `学历 ${rules.minEdu}及以上`, ok: eduRank(c.edu) < 0 ? null : eduRank(c.edu) >= eduRank(rules.minEdu), ev: c.edu || '页面未显示学历' });
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
  else reason = f.id === 'R01' ? `年龄 ${c.age} 岁，超过 ${rules.maxAge} 岁上限` : f.id === 'R02' ? `${c.edu}学历，要求${rules.minEdu}及以上` : f.id === 'R03' ? `${c.major || '专业'}与岗位科目不对口` : `无学校教学经历：${f.ev}`;
  return { verdict, score, rules: r, reason: clip(reason.trim(), 80) };
}
