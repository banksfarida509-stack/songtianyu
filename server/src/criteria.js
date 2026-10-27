// 岗位筛选标准（后台「岗位配置 → 筛选标准」逐项设置）。
// 每一项：不看 / 必须满足 / 加分；可填加分、缺信息时怎么判、AI 能不能按备注放宽。
// 结论只由这里决定：
//   任一「必须满足」项不满足 → 不推荐；否则任一缺信息（按「待确认」处理）→ 待确认；否则 → 推荐。
// 分数 = 基础分 + 满足的项的加分（教育经验按档位只取一档），只用来排序；不推荐的封顶 40。
// 「AI 可放宽」没勾的项是硬条件：岗位备注的 AI 复核不会放宽它。
import { eduRank, bachelorCheck, gradYearOf, is985or211, isEduWork, monthsOf, monthOf } from './rules.js';
import { tongzhaoOf, eduSalesOf } from './roles.js';
import { clip } from './util.js';

const kwList = v => (Array.isArray(v) ? v : String(v || '').split(/[,，、\s]+/)).map(x => String(x).trim()).filter(Boolean);
const numOrNull = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const num = v => { const m = String(v ?? '').match(/\d+/); return m ? Number(m[0]) : null; };
// “年龄 22–35 岁” “年龄 ≤ 35 岁” “毕业年份 ≥ 2020 年”
const range = (label, lo, hi, unit) => (lo != null && hi != null ? `${label} ${lo}–${hi}${unit}` : hi != null ? `${label} ≤ ${hi}${unit}` : lo != null ? `${label} ≥ ${lo}${unit}` : `${label}不限`);
const span = m => (m >= 12 ? `${Math.floor(m / 12)} 年${m % 12 ? m % 12 + ' 个月' : ''}` : `${m} 个月`);
const isMasterOf = c => eduRank(c.edu) >= 4 || (c.edus || []).some(e => eduRank(e.deg) >= 4);
const intentOf = c => `${c.intent || ''} ${c.expect || ''}`.trim();
const resumeText = c => [c.school, c.major, c.expect, c.intent, c.self_eval, c.career_status, c.years,
  ...(c.work || []).map(w => `${w.org || ''} ${w.role || ''}`), ...(c.edus || []).map(e => `${e.school || ''} ${e.major || ''} ${e.deg || ''} ${e.mode || ''}`),
  ...(c.skills || []), ...(c.certs || [])].filter(Boolean).join(' | ');
const hitIn = (kws, text) => kws.find(k => text.includes(k));
// 期望薪资的下限（元/月）：“8-10K”“8千-1万”“8000-10000元”；面议 / 认不出 → null
export function salaryFloor(text) {
  const t = String(text || '').replace(/\s/g, '');
  const m = t.match(/(\d+(?:\.\d+)?)\s*([kK千wW万])?\s*(?:-|~|～|至|到)\s*(\d+(?:\.\d+)?)\s*([kK千wW万])?/) || t.match(/(\d+(?:\.\d+)?)\s*([kK千wW万])(?:以上|起)?/);
  if (!m) { const y = t.match(/(\d{4,6})元/); return y ? Number(y[1]) : null; }
  const unit = m[2] || m[4] || '';
  const mul = /[kK千]/.test(unit) ? 1000 : /[wW万]/.test(unit) ? 10000 : 1;
  const v = Number(m[1]) * mul;
  return v >= 500 && v <= 200000 ? v : null;
}
// 有相关经历：教育工作经验，或职位 / 公司名命中关键词
const eduWorkOf = c => (c.work || []).filter(isEduWork);
const relWorkOf = (c, kws) => (kws.length ? (c.work || []).filter(w => kws.some(k => `${w.role || ''}${w.org || ''}`.includes(k))) : []);
const monthsSum = ws => { const k = ws.map(monthsOf).filter(m => m != null); return k.length ? k.reduce((a, b) => a + b, 0) : null; };

/**
 * 所有可选的标准项。params：UI 要显示的输入框（key, label, type: num | kw | select | tiers | check, options）。
 * test(c, p, ctx) → { ok: true | false | null(缺信息), ev: 依据 }
 */
export const ITEMS = [
  // ---------- 基本条件 ----------
  { key: 'age', group: '基本条件', label: '年龄', params: [{ key: 'min', label: '最小', type: 'num' }, { key: 'max', label: '最大', type: 'num' }],
    test(c, p) {
      if (c.age == null) return { ok: null, ev: '页面没显示年龄' };
      const lo = numOrNull(p.min), hi = numOrNull(p.max);
      return { ok: (lo == null || c.age >= lo) && (hi == null || c.age <= hi), ev: `${c.age} 岁` };
    }, name: p => range('年龄', numOrNull(p.min), numOrNull(p.max), ' 岁') },
  { key: 'edu', group: '基本条件', label: '最低学历', params: [{ key: 'min', label: '', type: 'select', options: ['中专', '大专', '本科', '硕士', '博士'] }],
    test(c, p) { return eduRank(c.edu) < 0 ? { ok: null, ev: '页面没显示学历' } : { ok: eduRank(c.edu) >= eduRank(p.min || '大专'), ev: c.edu }; },
    name: p => `学历 ${p.min || '大专'}及以上` },
  { key: 'tongzhao', group: '基本条件', label: '学历是统招全日制', params: [{ key: 'exemptEduSales', label: '在教育行业做过销售的可以不统招', type: 'check' }],
    test(c, p, ctx) {
      const tz = tongzhaoOf(c.edus, ctx.minEdu);
      const es = p.exemptEduSales ? eduSalesOf(c.work) : null;
      if (tz === true) return { ok: true, ev: '统招' };
      if (es) return { ok: true, ev: `${tz === false ? '非统招，' : ''}有教育行业销售经验（${es.org} ${es.role}）` };
      return tz === false ? { ok: false, ev: '非统招学历' } : { ok: null, ev: '简历没写是否统招' };
    } },
  { key: 'firstBachelor', group: '基本条件', label: '第一学历统招本科（不要专升本、非统招本科）', params: [],
    test(c) { return bachelorCheck(c); } },
  { key: 'gradYear', group: '基本条件', label: '毕业年份', params: [{ key: 'min', label: '最早', type: 'num' }, { key: 'max', label: '最晚', type: 'num' }],
    test(c, p) {
      const y = gradYearOf(c);
      if (y == null) return { ok: null, ev: '看不出毕业年份' };
      const lo = numOrNull(p.min) || null, hi = numOrNull(p.max) || null;
      return { ok: (lo == null || y >= lo) && (hi == null || y <= hi), ev: `${y} 年毕业` };
    }, name: p => range('毕业年份', numOrNull(p.min) || null, numOrNull(p.max) || null, ' 年') },
  { key: 'fresh', group: '基本条件', label: '应届生', params: [{ key: 'want', label: '', type: 'select', options: ['只要应届生', '不要应届生'] }],
    test(c, p) {
      const y = gradYearOf(c), now = new Date().getFullYear();
      let isFresh = null;
      if (/应届|在校/.test(`${c.years || ''} ${c.grad || ''}`)) isFresh = true;
      else if (y != null) isFresh = y >= now - 1 && !(c.work || []).some(w => (monthsOf(w) || 0) >= 12);
      else if (num(c.years) != null) isFresh = false;
      if (isFresh == null) return { ok: null, ev: '看不出是不是应届' };
      return { ok: (p.want || '只要应届生') === '只要应届生' ? isFresh : !isFresh, ev: isFresh ? '应届生' : '非应届' };
    }, name: p => p.want || '只要应届生' },
  { key: 'master', group: '学历加分', label: '研究生学历', params: [],
    test(c) { return eduRank(c.edu) < 0 && !(c.edus || []).length ? { ok: null, ev: '页面没显示学历' } : { ok: isMasterOf(c), ev: isMasterOf(c) ? '研究生' : c.edu || '非研究生' }; } },
  { key: 'bach985', group: '学历加分', label: '本科 985 / 211', params: [],
    test(c) {
      const bach = (c.edus || []).filter(e => eduRank(e.deg) === 3);
      const ok = bach.some(is985or211) || (/985|211/.test(c.school_tag || '') && !isMasterOf(c) && !bach.length && eduRank(c.edu) === 3);
      return { ok, ev: ok ? `${(bach.find(is985or211) || {}).school || c.school || ''}` : '本科不是 985 / 211' };
    } },
  { key: 'mast985', group: '学历加分', label: '研究生 985 / 211', params: [],
    test(c) {
      const mast = (c.edus || []).filter(e => eduRank(e.deg) >= 4);
      const ok = mast.some(is985or211) || (/985|211/.test(c.school_tag || '') && isMasterOf(c) && !mast.length);
      return { ok, ev: ok ? `${(mast.find(is985or211) || {}).school || c.school || ''}` : isMasterOf(c) ? '研究生院校不是 985 / 211' : '不是研究生' };
    } },
  { key: 'normal', group: '学历加分', label: '师范院校或教育类专业', params: [],
    test(c) {
      const e = (c.edus || []).find(x => /师范/.test(x.school || '') || /教育|学科教学/.test(x.major || ''));
      const ok = !!e || /师范/.test(c.school || '') || /教育|学科教学/.test(c.major || '');
      return { ok, ev: ok ? `${(e || c).school || ''} ${(e || c).major || ''}`.trim() : `${c.school || ''} ${c.major || ''}`.trim() || '非师范' };
    } },
  { key: 'major', group: '学历加分', label: '专业包含关键词', params: [{ key: 'kw', label: '关键词', type: 'kw' }],
    test(c, p) {
      const majors = [c.major, ...(c.edus || []).map(e => e.major)].filter(Boolean).join(' ');
      if (!majors) return { ok: null, ev: '简历没写专业' };
      const h = hitIn(kwList(p.kw), majors);
      return { ok: !!h, ev: h ? `命中“${h}”` : majors };
    } },
  { key: 'schoolKw', group: '学历加分', label: '毕业院校包含关键词', params: [{ key: 'kw', label: '院校名', type: 'kw' }],
    test(c, p) {
      const schools = [c.school, ...(c.edus || []).map(e => e.school)].filter(Boolean).join(' ');
      if (!schools) return { ok: null, ev: '简历没写院校' };
      const h = hitIn(kwList(p.kw), schools);
      return { ok: !!h, ev: h ? `命中“${h}”` : schools };
    } },

  // ---------- 工作经验 ----------
  { key: 'expYears', group: '工作经验', label: '总工作年限（年）', params: [{ key: 'min', label: '最少', type: 'num' }, { key: 'max', label: '最多', type: 'num' }],
    test(c, p) {
      const y = /应届|在校|无经验/.test(c.years || '') ? 0 : num(c.years);
      if (y == null) return { ok: null, ev: '页面没显示工作年限' };
      const lo = numOrNull(p.min), hi = numOrNull(p.max);
      return { ok: (lo == null || y >= lo) && (hi == null || y <= hi), ev: c.years || `${y} 年` };
    } },
  { key: 'eduExp', group: '工作经验', label: '教育工作经验（公立 / 私立学校、任何教育机构都算）', params: [{ key: 'minMonths', label: '至少几个月（0 = 有就行）', type: 'num' }, { key: 'tiers', label: '按经验长短加分（只取一档）', type: 'tiers' }],
    test(c, p) {
      const ws = eduWorkOf(c);
      if (!ws.length) return { ok: false, ev: '无教育工作经历', months: 0 };
      let m = monthsSum(ws);
      if (m == null) { const y = num(c.years); m = y != null ? y * 12 : null; }
      const need = numOrNull(p.minMonths) || 0;
      const head = `${ws[0].org || ''} ${ws[0].role || ''}`.trim();
      if (m == null) return { ok: need ? null : true, ev: `${head}，年限未知`, months: null };
      return { ok: m >= need, ev: `${head}，共约 ${span(m)}`, months: m };
    } },
  { key: 'relExp', group: '工作经验', label: '相关工作经历（职位或公司名含关键词）', params: [{ key: 'kw', label: '关键词', type: 'kw' }, { key: 'minMonths', label: '至少几个月（0 = 有就行）', type: 'num' }],
    test(c, p) {
      const kws = kwList(p.kw);
      const ws = relWorkOf(c, kws);
      if (!ws.length) return { ok: false, ev: (c.work || []).length ? `经历不含：${kws.slice(0, 4).join('、')}` : '无工作经历' };
      const m = monthsSum(ws), need = numOrNull(p.minMonths) || 0;
      const hit = kws.find(k => `${ws[0].role || ''}${ws[0].org || ''}`.includes(k));
      if (m == null) return { ok: need ? null : true, ev: `命中“${hit}”，年限未知` };
      return { ok: m >= need, ev: `命中“${hit}”（${ws[0].org || ''} ${ws[0].role || ''}），共约 ${span(m)}` };
    } },
  { key: 'schoolTeach', group: '工作经验', label: '学校任教经历（不算培训机构）', params: [{ key: 'kw', label: '学校关键词', type: 'kw' }, { key: 'exclude', label: '不算的（培训机构）', type: 'kw' }],
    test(c, p) {
      const inc = kwList(p.kw), exc = kwList(p.exclude);
      const w = (c.work || []).find(x => inc.some(k => `${x.org || ''}${x.role || ''}`.includes(k)) && !exc.some(k => (x.org || '').includes(k)));
      return w ? { ok: true, ev: `${w.org || ''} ${w.role || ''}`.trim() } : { ok: false, ev: (c.work || []).length ? '没有学校任教经历' : '无工作经历' };
    } },
  { key: 'noExpCond', group: '工作经验', label: '没有相关经验时：年龄和求职方向要求', params: [{ key: 'expBy', label: '“有经验”指', type: 'select', options: ['教育工作经验', '相关工作经历'] }, { key: 'maxAge', label: '年龄不超过', type: 'num' }, { key: 'kw', label: '求职方向关键词（空 = 不看）', type: 'kw' }],
    test(c, p, ctx) {
      const has = (p.expBy || '教育工作经验') === '教育工作经验' ? eduWorkOf(c).length > 0 : relWorkOf(c, kwList(ctx.relKw)).length > 0;
      if (has) return { ok: true, ev: '有相关经验，这条不看' };
      const kws = kwList(p.kw), it = intentOf(c), hi = numOrNull(p.maxAge);
      if (kws.length && !it) return { ok: null, ev: '没有经验，简历没写求职方向' };
      const h = kws.length ? hitIn(kws, it) : '';
      if (kws.length && !h) return { ok: false, ev: '没有经验，求职方向也不对口' };
      if (hi != null && c.age == null) return { ok: null, ev: '没有经验，页面没显示年龄' };
      if (hi != null && c.age > hi) return { ok: false, ev: `没有经验，${c.age} 岁超过 ${hi} 岁` };
      return { ok: true, ev: `没有经验，${c.age ?? '?'} 岁${h ? `，求职方向含“${h}”` : ''}` };
    } },
  { key: 'intent', group: '工作经验', label: '求职方向包含关键词', params: [{ key: 'kw', label: '关键词', type: 'kw' }],
    test(c, p) {
      const it = intentOf(c);
      if (!it) return { ok: null, ev: '简历没写求职方向' };
      const h = hitIn(kwList(p.kw), it);
      return { ok: !!h, ev: h ? `求职方向含“${h}”` : '求职方向不对口' };
    } },
  { key: 'eduSales', group: '工作经验', label: '在教育行业做过销售 / 招生 / 顾问', params: [],
    test(c) { const w = eduSalesOf(c.work); return w ? { ok: true, ev: `${w.org} ${w.role}` } : { ok: false, ev: '没有教育行业销售经历' }; } },
  { key: 'manage', group: '工作经验', label: '有管理 / 带团队经历', params: [{ key: 'kw', label: '职位关键词', type: 'kw' }],
    test(c, p) {
      const kws = kwList(p.kw).length ? kwList(p.kw) : ['主管', '经理', '组长', '校长', '负责人', '总监', '主任'];
      const w = (c.work || []).find(x => kws.some(k => (x.role || '').includes(k)));
      return w ? { ok: true, ev: `${w.org || ''} ${w.role}` } : { ok: false, ev: '没有管理岗位经历' };
    } },
  { key: 'jobHop', group: '工作经验', label: '不频繁跳槽', params: [{ key: 'shortMonths', label: '干不满几个月算短', type: 'num' }, { key: 'maxCount', label: '短的最多几段', type: 'num' }],
    test(c, p) {
      const ws = c.work || [];
      if (!ws.length) return { ok: true, ev: '无工作经历' };
      const short = numOrNull(p.shortMonths) ?? 12, maxN = numOrNull(p.maxCount) ?? 2;
      const known = ws.filter(w => !/至今|今/.test(w.t || '')).map(monthsOf).filter(m => m != null);
      if (!known.length) return { ok: null, ev: '看不出每段工作多久' };
      const n = known.filter(m => m < short).length;
      return { ok: n <= maxN, ev: `不满 ${short} 个月的工作 ${n} 段` };
    } },
  { key: 'gap', group: '工作经验', label: '空窗期（离开上一份工作）不超过几个月', params: [{ key: 'maxMonths', label: '最多几个月', type: 'num' }],
    test(c, p) {
      const ws = c.work || [];
      if (!ws.length) return { ok: null, ev: '无工作经历' };
      if (ws.some(w => /至今|今/.test(w.t || '')) || /在职/.test(c.career_status || '')) return { ok: true, ev: '在职' };
      const ends = ws.map(w => { const parts = String(w.t || '').split(/\s*(?:-|–|—|~|至(?!今))\s*/).filter(Boolean); return parts.length >= 2 ? monthOf(parts[parts.length - 1]) : null; }).filter(m => m != null);
      if (!ends.length) return { ok: null, ev: '看不出上一份工作什么时候结束' };
      const d = new Date(), gap = d.getFullYear() * 12 + d.getMonth() - Math.max(...ends);
      const hi = numOrNull(p.maxMonths) ?? 6;
      return { ok: gap <= hi, ev: `已离职约 ${span(Math.max(0, gap))}` };
    } },

  // ---------- 备注选项 ----------
  { key: 'cert', group: '备注选项', label: '有教师资格证', params: [{ key: 'kw', label: '科目 / 学段（空 = 任意）', type: 'kw' }],
    test(c, p) {
      const t = [...(c.certs || []), ...(c.skills || []), c.self_eval || ''].join(' ');
      if (!/教师资格|教资/.test(t)) return { ok: null, ev: '简历没写教师资格证' };
      const kws = kwList(p.kw);
      if (!kws.length) return { ok: true, ev: '有教师资格证' };
      const h = hitIn(kws, t);
      return h ? { ok: true, ev: `教师资格证含“${h}”` } : { ok: null, ev: '有教师资格证，科目没对上或没写' };
    } },
  { key: 'certKw', group: '备注选项', label: '证书 / 技能包含关键词', params: [{ key: 'kw', label: '关键词', type: 'kw' }],
    test(c, p) {
      const t = [...(c.certs || []), ...(c.skills || [])].join(' ');
      const h = hitIn(kwList(p.kw), `${t} ${c.self_eval || ''}`);
      return h ? { ok: true, ev: `含“${h}”` } : { ok: null, ev: t ? '证书 / 技能里没有' : '简历没写证书和技能' };
    } },
  { key: 'gender', group: '备注选项', label: '性别', params: [{ key: 'want', label: '', type: 'select', options: ['女', '男'] }],
    test(c, p) { return !c.gender ? { ok: null, ev: '页面没显示性别' } : { ok: String(c.gender).includes(p.want || '女'), ev: c.gender }; }, name: p => `性别 ${p.want || '女'}` },
  { key: 'status', group: '备注选项', label: '求职状态', params: [{ key: 'want', label: '', type: 'select', options: ['离职', '在职'] }],
    test(c, p) { return !c.career_status ? { ok: null, ev: '页面没显示求职状态' } : { ok: String(c.career_status).includes(p.want || '离职'), ev: c.career_status }; }, name: p => `求职状态：${p.want || '离职'}` },
  { key: 'city', group: '备注选项', label: '期望城市 / 地区包含', params: [{ key: 'kw', label: '城市或区', type: 'kw' }],
    test(c, p) {
      const t = c.expect || '';
      if (!t) return { ok: null, ev: '简历没写期望城市' };
      const h = hitIn(kwList(p.kw), t);
      return h ? { ok: true, ev: `期望含“${h}”` } : { ok: null, ev: `期望：${clip(t, 30)}（没写到这些城市）` };
    } },
  { key: 'salaryMax', group: '备注选项', label: '期望薪资不高于（元 / 月）', params: [{ key: 'max', label: '上限', type: 'num' }],
    test(c, p) {
      const v = salaryFloor(c.expect);
      if (v == null) return { ok: null, ev: '看不出期望薪资' };
      const hi = numOrNull(p.max);
      return { ok: hi == null || v <= hi, ev: `期望 ${v} 元起` };
    } },
  { key: 'includeKw', group: '备注选项', label: '简历里必须出现的词（任一）', params: [{ key: 'kw', label: '关键词', type: 'kw' }],
    test(c, p) { const h = hitIn(kwList(p.kw), resumeText(c)); return { ok: !!h, ev: h ? `含“${h}”` : '简历里没有这些词' }; } },
  { key: 'excludeKw', group: '备注选项', label: '简历里不能出现的词（任一）', params: [{ key: 'kw', label: '关键词', type: 'kw' }],
    test(c, p) { const h = hitIn(kwList(p.kw), resumeText(c)); return { ok: !h, ev: h ? `含“${h}”` : '没有排除词' }; } },
];
export const ITEM_KEYS = ITEMS.map(x => x.key);
export const GROUPS = [...new Set(ITEMS.map(x => x.group))];

const blank = () => ({ mode: 'off', points: 0, missing: 'pending', aiWiden: true });

/** 从旧规则换算出一份等价的筛选标准（第一次打开后台时预填） */
export function defaultCriteria(roleKey, role, rules) {
  const it = Object.fromEntries(ITEM_KEYS.map(k => [k, blank()]));
  const set = (k, o) => { it[k] = { ...it[k], ...o }; };
  const maxGrad = Number(rules.maxGradYear) || 0;
  if (maxGrad) set('gradYear', { mode: 'must', max: maxGrad, missing: 'pass', aiWiden: false });
  set('cert', { mode: 'off', points: 4 });
  set('jobHop', { shortMonths: 12, maxCount: 2 });
  set('gap', { maxMonths: 6 });
  set('salaryMax', { max: 8000 });
  set('city', { kw: ['沈阳'] });
  set('schoolTeach', { kw: (String(rules.schoolPattern || '中学|小学|学校').split('|')), exclude: String(rules.trainingPattern || '培训|机构').split('|') });
  if (roleKey === 'teacher') {
    const S = { base: 60, freshMaxAge: 30, maxAge: 42, masterBonus: 5, bach985: 5, master985: 5, exp: [[6, 5], [12, 10], [36, 15], [60, 20]], intentKeywords: [], ...(rules.scoring || {}) };
    set('age', { mode: 'must', max: S.maxAge, missing: 'pending', aiWiden: false });
    set('edu', { mode: 'must', min: rules.minEdu || '本科', missing: 'pending', aiWiden: false });
    if (rules.requireTongzhaoBachelor !== false) set('firstBachelor', { mode: 'must', missing: 'pass', aiWiden: false });
    set('master', { mode: 'bonus', points: S.masterBonus });
    set('bach985', { mode: 'bonus', points: S.bach985 });
    set('mast985', { mode: 'bonus', points: S.master985 });
    set('eduExp', { mode: 'bonus', points: 0, minMonths: 0, tiers: S.exp });
    set('noExpCond', { mode: 'must', expBy: '教育工作经验', maxAge: S.freshMaxAge, kw: [...new Set([...(S.intentKeywords || []), ...(rules.intentKeywords || [])])], missing: 'pending', aiWiden: true });
    set('major', { kw: rules.subjectKeywords || [] });
    return { enabled: true, base: S.base, items: it };
  }
  const R = role.rules || {};
  set('age', { mode: 'must', max: R.maxAge ?? 35, missing: 'pending', aiWiden: true });
  set('edu', { mode: 'must', min: R.minEdu || '大专', missing: 'pending', aiWiden: false });
  if (R.requireTongzhao) set('tongzhao', { mode: 'must', exemptEduSales: !!R.eduSalesException, missing: 'pending', aiWiden: false });
  set('relExp', { mode: 'bonus', points: 15, kw: R.expKeywords || [], minMonths: 0 });
  set('intent', { mode: 'bonus', points: 8, kw: R.intentKeywords || [] });
  set('major', { mode: (R.majorKeywords || []).length ? 'bonus' : 'off', points: 4, kw: R.majorKeywords || [] });
  set('noExpCond', { mode: 'must', expBy: '相关工作经历', maxAge: R.youngMaxAge ?? 28, kw: R.intentKeywords || [], missing: 'pending', aiWiden: true });
  return { enabled: true, base: 55, items: it };
}

/** 保存的标准补齐新加的项（以后再加新选项时，旧配置也能用） */
export function fullCriteria(roleKey, role, rules) {
  const d = defaultCriteria(roleKey, role, rules);
  const cr = role.criteria;
  if (!cr) return { ...d, saved: false };
  const items = {};
  for (const k of ITEM_KEYS) items[k] = { ...blank(), ...((cr.items || {})[k] || (d.items[k].mode === 'off' ? d.items[k] : { ...d.items[k], mode: 'off' })) };
  return { enabled: cr.enabled !== false, base: Number.isFinite(Number(cr.base)) ? Number(cr.base) : d.base, items, saved: true };
}

/** 按筛选标准判定。返回和 rules.screen() 一样的 { verdict, score, rules, reason }，另带 criteria: true */
export function screenCriteria(c, cr) {
  const items = cr.items || {};
  const ctx = { minEdu: (items.edu && items.edu.mode !== 'off' && items.edu.min) || '大专', relKw: (items.relExp || {}).kw || [] };
  const out = [], parts = [[`基础分`, Number(cr.base) || 0]];
  for (const def of ITEMS) {
    const p = items[def.key];
    if (!p || p.mode === 'off' || !p.mode) continue;
    let r;
    try { r = def.test(c, p, ctx) || { ok: null, ev: '' }; } catch { r = { ok: null, ev: '判断出错' }; }
    let ok = r.ok, ev = r.ev || '';
    if (ok === null && p.missing === 'fail') { ok = false; ev += '（缺信息按不满足）'; }
    else if (ok === null && p.missing === 'pass') { ok = true; ev += '（缺信息按满足）'; }
    const must = p.mode === 'must';
    out.push({ id: `C:${def.key}`, name: `${must ? '' : '加分：'}${def.name ? def.name(p) : def.label}`, ok, ev, hard: must && p.aiWiden === false, must, missing: r.ok === null });
    if (ok === true && Number(p.points)) parts.push([def.label, Number(p.points)]);
    // 教育经验按档位加分（只取够得着的最高一档）
    if (def.key === 'eduExp' && Array.isArray(p.tiers) && r.months != null && r.months > 0) {
      const tier = [...p.tiers].filter(t => Array.isArray(t) && Number.isFinite(Number(t[0]))).sort((a, b) => a[0] - b[0]).reverse().find(([m]) => r.months >= Number(m));
      if (tier && Number(tier[1])) parts.push([`教育工作经验 ${span(r.months)}（满 ${tier[0] >= 12 ? tier[0] / 12 + ' 年' : tier[0] + ' 个月'}档）`, Number(tier[1])]);
    }
  }
  const musts = out.filter(x => x.must);
  const failed = musts.find(x => x.ok === false), unknown = musts.find(x => x.ok === null);
  const verdict = failed ? '不推荐' : unknown ? '待确认' : '推荐';
  const raw = parts.reduce((a, [, v]) => a + v, 0);
  const score = Math.max(0, Math.min(100, verdict === '不推荐' ? Math.min(raw, 40) : raw));
  out.push({ id: 'S', name: '赋分明细', ok: true, ev: parts.map(([k, v], i) => (i ? `${k} +${v}` : `${k} ${v}`)).join('；') + ` = ${raw}`, raw });
  let reason;
  if (failed) reason = `${failed.name.replace(/^加分：/, '')}不满足：${failed.ev}`;
  else if (unknown) reason = `${unknown.ev}，需你确认`;
  else {
    const good = out.filter(x => x.ok === true && x.id !== 'S' && !x.missing && !['C:gradYear', 'C:age', 'C:edu'].includes(x.id)).map(x => x.ev).filter(Boolean);
    reason = `${c.age ?? ''}岁 ${c.edu || ''}；${good.slice(0, 2).join('；') || '符合全部必须条件'}；${raw} 分`;
  }
  return { verdict, score, rules: out, reason: clip(reason.trim(), 80), criteria: true };
}
