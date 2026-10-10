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

/**
 * Field whitelist: only what screening needs. Photos, phone numbers and
 * ID numbers are never accepted even if a client sends them.
 */
export function normalizeZhaopin(raw) {
  const work = (raw.workExperiences || []).slice(0, 6).map(w => ({
    t: [w.beginDate, w.endDate].filter(Boolean).join('-'),
    org: clip(w.companyName, 60), role: clip(w.jobTitle || w.jobSubTitle, 40),
  }));
  const edus = (raw.educationExperiences || []).slice(0, 4).map(e => ({
    t: [e.beginDate, e.endDate].filter(Boolean).join('-'),
    school: clip(e.schoolName, 60), major: clip(e.majorName, 40), deg: clip(e.educationLevel, 10), tag: clip(e.schoolTag, 20),
  }));
  const top = edus[0] || {};
  return {
    uid: String(raw.resumeNumber || raw.uid || ''),
    name: clip(raw.userName || raw.name, 20),
    gender: raw.gender ? clip(raw.gender, 4) : null,
    age: num(raw.age),
    edu: clip(raw.educationLevel || top.deg, 10),
    school: top.school || null,
    school_tag: top.tag || null,
    major: top.major || null,
    years: clip(raw.workYearsLabel || raw.workYears, 12),
    career_status: clip(raw.careerStatus, 20),
    expect: clip([raw.cityLabel || raw.desiredCity, raw.desiredJobType, raw.desiredSalary].filter(x => typeof x === 'string' && x).join(' · '), 80),
    work, edus,
    skills: (raw.skillTags || []).slice(0, 12).map(x => clip(x, 20)),
    certs: (raw.certificateNames || []).slice(0, 10).map(x => clip(x, 40)),
    self_eval: clip(raw.selfEvaluation, 400),
  };
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

  const verdict = r.some(x => x.ok === false) ? '不推荐' : r.some(x => x.ok === null) ? '待确认' : '推荐';
  const yrs = num(c.years) ?? 0;
  let score = 55 + (schoolTeach ? 12 : 0) + (normal ? 8 : 0) + (/985|211|双一流/.test(c.school_tag || '') ? 8 : 0)
    + Math.min(yrs, 3) * 4 + (eduRank(c.edu) >= 4 ? 4 : 0) + (hasCert ? 4 : 0) - (trainTeach && !schoolTeach ? 6 : 0);
  if (verdict === '不推荐') score = Math.min(score, 40);
  score = Math.max(0, Math.min(98, score));

  const f = r.find(x => x.ok === false), u = r.find(x => x.ok === null);
  let reason;
  if (verdict === '推荐') reason = `${c.school || ''}${c.school_tag ? ' ' + c.school_tag : ''} ${c.major || ''}；${schoolTeach ? schoolTeach.role || '学校教学经历' : '师范背景'}${hasCert ? '；有教师资格证' : '；资格证待追问'}`;
  else if (verdict === '待确认') reason = `${u.ev}，需你确认`;
  else reason = f.id === 'R01' ? `年龄 ${c.age} 岁，超过 ${rules.maxAge} 岁上限` : f.id === 'R02' ? `${c.edu}学历，要求${rules.minEdu}及以上` : f.id === 'R03' ? `${c.major || '专业'}与岗位科目不对口` : `无学校教学经历：${f.ev}`;
  return { verdict, score, rules: r, reason: clip(reason.trim(), 80) };
}
