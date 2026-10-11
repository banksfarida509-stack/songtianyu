// Job roles (岗位). Each role has its own screening rules, the basic facts the AI
// should learn in chat, and talking points. The role of a candidate is decided by
// the platform's job title. 教师 keeps its original rules (settings.rules).
import { eduRank } from './rules.js';
import { clip } from './util.js';

export const DEFAULT_ROLES = {
  teacher: {
    name: '教师',
    jobKeywords: ['教师', '老师', '讲师', '教研', '助教'],
    questions: [
      ['employed', '现在是在职还是已经离职'],
      ['live', '现在住在哪里，来学校方不方便'],
      ['subject', '想教哪个科目'],
      ['arrive', '什么时候可以开始工作'],
    ],
    // 岗位要求与特殊情况备注：负责人写的放宽 / 补充条件，AI 复核初筛时使用
    notes: '',
    focus: '教师资格证只是加分项、不是必须：不要主动追问；对方提到或问起时，说有的话更好、没有也可以先来面试。',
  },
  xueguan: {
    name: '学管师',
    jobKeywords: ['学管', '学习管理', '学习规划', '班主任', '教务', '学员管理', '学业'],
    rules: {
      maxAge: 35, minEdu: '大专', youngMaxAge: 28, requireTongzhao: true, eduSalesException: false,
      expKeywords: ['学管', '班主任', '教务', '学习管理', '学习规划', '助教', '辅导员', '客服', '家长', '学员', '课程顾问', '教育', '培训', '运营', '前台'],
      majorKeywords: ['教育', '心理', '汉语言', '英语', '数学', '管理'],
      intentKeywords: ['学管', '班主任', '教务', '助教', '学习规划', '教育', '客服', '运营'],
    },
    questions: [
      ['employed', '现在是在职还是已经离职'],
      ['live', '现在住在哪里，来校区方不方便'],
      ['tongzhao', '大专学历是统招全日制的吗'],
      ['exp', '之前有没有做过教育、客服或班主任这类和学生、家长打交道的工作'],
      ['weekend', '能不能接受周末上班、工作日轮休'],
      ['arrive', '什么时候可以开始工作'],
    ],
    // 岗位要求与特殊情况备注：负责人写的放宽 / 补充条件，AI 复核初筛时使用
    notes: '',
    focus: '学管师负责学员的学习跟进、家长沟通、排课和课时管理、续费服务。沟通时了解对方的沟通能力、耐心和稳定性；没有教育行业经验但做过客服、运营等服务工作的也欢迎。周末是教培行业的上课高峰，要提前说明作息并确认对方能接受。',
  },
  zixun: {
    name: '咨询师',
    jobKeywords: ['咨询', '课程顾问', '学习顾问', '教育顾问', '招生', '销售', '顾问'],
    rules: {
      // 统招大专及以上；在教育行业做过销售的，非统招大专也可以
      maxAge: 35, minEdu: '大专', youngMaxAge: 30, requireTongzhao: true, eduSalesException: true,
      expKeywords: ['课程顾问', '咨询', '招生', '销售', '电销', '电话销售', '顾问', '客户经理', '市场', '邀约', '房产', '保险', '地产', '业务'],
      majorKeywords: ['市场营销', '营销', '工商管理', '教育', '心理'],
      intentKeywords: ['课程顾问', '咨询', '销售', '招生', '顾问', '市场', '业务'],
    },
    questions: [
      ['employed', '现在是在职还是已经离职'],
      ['live', '现在住在哪里，来校区方不方便'],
      ['tongzhao', '大专学历是统招全日制的吗'],
      ['exp', '之前有没有做过销售、招生或课程顾问'],
      ['salary', '能不能接受底薪加提成的薪资结构'],
      ['arrive', '什么时候可以开始工作'],
    ],
    // 岗位要求与特殊情况备注：负责人写的放宽 / 补充条件，AI 复核初筛时使用
    notes: '',
    focus: '咨询师（课程顾问）负责接待家长咨询、了解学生情况、推荐课程并促成报名，收入和业绩挂钩。沟通时了解对方的销售意愿、抗压能力和表达能力；做过其他行业销售（房产、保险、电销等）的也欢迎。收入、提成只能用资料里的事实，资料没有就说面试时详细介绍。',
  },
};

export const ROLE_KEYS = Object.keys(DEFAULT_ROLES);

// Knowledge-base templates added (disabled) on first run: the structure is filled in,
// the facts are left for the school to write. They are enabled once filled.
export const ROLE_KB_TEMPLATES = [
  ['xueguan', '【模板·请填写后启用】学管师岗位资料', `【岗位职责】
（请填写：例如 负责学员学习跟进、家长沟通、排课与课时管理、续费服务……）

【任职要求】
（请填写：学历、年龄、是否需要教育行业经验……）

【工作时间 / 作息】
（请填写：上班时间、周末是否上班、轮休方式、寒暑假安排……）

【薪资福利】
（请填写：底薪、绩效 / 续费提成、五险一金、餐补等。不想让 AI 对外说的不要写）

【培训与发展】
（请填写：入职培训、晋升路径，例如 学管师 → 学管主管 → 校区校长……）

【工作地点】
（请填写：校区地址、交通）

【常见问题】
问：周末要上班吗？
答：（请填写）
问：需要有教育行业经验吗？
答：（请填写）
问：工资怎么算？
答：（请填写）`],
  ['zixun', '【模板·请填写后启用】咨询师岗位资料', `【岗位职责】
（请填写：例如 接待家长咨询、了解学生情况、推荐课程、促成报名、维护老客户转介绍……）

【任职要求】
（请填写：学历、年龄、是否需要销售经验……）

【工作时间 / 作息】
（请填写：上班时间、周末是否上班、轮休方式……）

【薪资结构】
（请填写：底薪、提成比例或阶梯、绩效奖金、五险一金等。不想让 AI 对外说的不要写）

【客户来源】
（请填写：例如 是否有市场部提供的意向客户、是否需要自己拓客、电话邀约量……）

【培训与发展】
（请填写：销售培训、晋升路径，例如 咨询师 → 咨询主管 → 校区校长……）

【工作地点】
（请填写：校区地址、交通）

【常见问题】
问：底薪多少？提成怎么算？
答：（请填写）
问：有没有业绩压力 / 考核？
答：（请填写）
问：没做过教育行业可以吗？
答：（请填写）`],
];

/** Which role a job title belongs to: specific roles first, 教师 is the default. */
export function roleFor(job, roles) {
  const t = String(job || '');
  for (const key of ROLE_KEYS.filter(k => k !== 'teacher')) {
    const r = roles[key];
    if (r && r.enabled !== false && (r.jobKeywords || []).some(k => k && t.includes(k))) return key;
  }
  return 'teacher';
}

// 统招 status of the degrees that meet the minimum level: true / false / null (not shown)
const NON_TZ = /非统招|自考|成人|函授|网络|业余|非全日制|开放|夜大/;
export function tongzhaoOf(edus, minEdu) {
  const rel = (edus || []).filter(e => eduRank(e.deg) >= eduRank(minEdu || '大专'));
  if (!rel.length) return null;
  if (rel.some(e => /统招|全日制/.test(e.mode || '') && !NON_TZ.test(e.mode || ''))) return true;
  if (rel.every(e => NON_TZ.test(e.mode || ''))) return false;
  return null;
}
// a sales-type job at an education company (培训机构、学校 …)
const EDU_ORG = /教育|培训|学校|学堂|课堂|辅导|学院|教培|网校|少儿|书院|思维|英语|艺术|早教|托管|学而|学大|好未来|新东方|精锐|昂立|卓越|启德/;
const SALES_ROLE = /销售|顾问|招生|咨询|市场|业务|电销|邀约/;
export const eduSalesOf = work => (work || []).find(w => SALES_ROLE.test(w.role || '') && EDU_ORG.test(w.org || '')) || null;

/**
 * Screening for non-teacher roles. Same verdict shape as rules.screen().
 * R01 age, R02 education, R03 related experience (job titles / major / skills),
 * R04 job intention. Experience → 推荐; no experience but the intention fits and
 * young enough → 推荐 (意向型); otherwise 待确认 (younger) or 不推荐.
 */
export function screenRole(c, role) {
  const R = role.rules || {};
  const hay = [...c.work.map(w => `${w.org} ${w.role}`), ...(c.skills || [])].join(' | ');
  const expHit = (R.expKeywords || []).find(k => k && c.work.some(w => `${w.role || ''}${w.org || ''}`.includes(k)));
  const majorHit = (R.majorKeywords || []).find(k => k && (c.major || '').includes(k));
  const intentText = `${c.intent || ''} ${c.expect || ''} ${c.self_eval || ''}`;
  const intentHit = (R.intentKeywords || []).find(k => k && intentText.includes(k));
  const young = c.age != null && c.age <= (R.youngMaxAge ?? 28);
  const yrs = Number(String(c.years || '').match(/\d+/)?.[0] || 0);

  const r = [];
  r.push({ id: 'R01', name: `年龄 ≤ ${R.maxAge ?? 35}`, ok: c.age == null ? null : c.age <= (R.maxAge ?? 35), ev: c.age == null ? '页面未显示年龄' : `${c.age} 岁` });
  r.push({ id: 'R02', name: `学历 ${R.minEdu || '大专'}及以上`, ok: eduRank(c.edu) < 0 ? null : eduRank(c.edu) >= eduRank(R.minEdu || '大专'), ev: c.edu || '页面未显示学历' });
  r.push({ id: 'R03', name: `${role.name}相关经历`, ok: !!expHit, ev: expHit ? `命中“${expHit}”` : (hay || '无工作经历') });
  r.push({ id: 'R04', name: '求职意向相关', ok: !!intentHit, ev: intentHit ? `求职方向含“${intentHit}”` : '求职方向未体现' });
  // R05 统招: required unless (咨询师) the candidate sold for an education company
  let tz = null, eduSales = null;
  if (R.requireTongzhao) {
    tz = tongzhaoOf(c.edus, R.minEdu);
    eduSales = R.eduSalesException ? eduSalesOf(c.work) : null;
    const ok = tz === true || (eduSales ? true : tz);
    r.push({ id: 'R05', name: `统招${R.minEdu || '大专'}及以上${R.eduSalesException ? '（教育行业销售经验可放宽）' : ''}`, ok,
      ev: tz === true ? '统招' : eduSales ? `${tz === false ? '非统招，' : ''}有教育行业销售经验（${eduSales.org} ${eduSales.role}）` : tz === false ? '非统招学历' : '简历未显示是否统招' });
  }
  const tzRule = r.find(x => x.id === 'R05');

  let verdict;
  if (r[0].ok === false || r[1].ok === false || tzRule?.ok === false) verdict = '不推荐';
  else if (expHit) verdict = r[0].ok === null || r[1].ok === null || tzRule?.ok === null ? '待确认' : '推荐';
  else if (intentHit && (young || c.age == null)) verdict = c.age == null || tzRule?.ok === null ? '待确认' : '推荐';
  else verdict = young || c.age == null ? '待确认' : '不推荐';

  let score = 55 + (expHit ? 15 : 0) + (intentHit ? 8 : 0) + (majorHit ? 4 : 0) + (eduRank(c.edu) >= 3 ? 5 : 0) + Math.min(yrs, 4) * 3;
  if (!expHit) score = Math.min(score, 68);
  if (verdict === '不推荐') score = Math.min(score, 40);
  score = Math.max(0, Math.min(98, score));

  let reason;
  if (verdict === '不推荐') reason = r[0].ok === false ? `年龄 ${c.age} 岁，超过 ${R.maxAge ?? 35} 岁上限` : r[1].ok === false ? `${c.edu}学历，要求${R.minEdu || '大专'}及以上`
    : tzRule?.ok === false ? `非统招学历，${role.name}要求统招${R.minEdu || '大专'}及以上${R.eduSalesException ? '（有教育行业销售经验可放宽）' : ''}` : `没有${role.name}相关经历，求职方向也不相关`;
  else if (verdict === '推荐') reason = expHit ? `${c.age ?? ''}岁 ${c.edu || ''}；有相关经历（${expHit}）${intentHit ? '，求职方向也对口' : ''}` : `${c.age} 岁 ${c.edu || ''}；没有相关经历，但求职方向是“${intentHit}”（意向型）`;
  else reason = `${(r.find(x => x.ok === null) || r[2]).ev}，需你确认`;
  return { verdict, score, rules: r, reason: clip(reason.trim(), 80), role: role.name };
}
