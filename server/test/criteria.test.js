// 岗位筛选标准（后台逐项设置，结论只由标准决定）
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZhaopin, screen, applyGradRule } from '../src/rules.js';
import { screenCriteria, defaultCriteria, fullCriteria, salaryFloor, ITEM_KEYS } from '../src/criteria.js';
import { DEFAULT_SETTINGS } from '../src/db.js';
import { DEFAULT_ROLES } from '../src/roles.js';

const rules = DEFAULT_SETTINGS.rules;
const card = (o = {}) => normalizeZhaopin({ resumeNumber: 'x', userName: '张三', age: 25, educationLevel: '本科', intentText: '初中数学老师',
  educationExperiences: [{ schoolName: '沈阳大学', majorName: '数学', educationLevel: '本科', mode: '统招', beginDate: '2018.09', endDate: '2022.07' }], workExperiences: [], ...o });
const work = (org, role, b, e) => ({ companyName: org, jobTitle: role, beginDate: b, endDate: e });
const teacherCr = () => defaultCriteria('teacher', DEFAULT_ROLES.teacher, rules);
// 只开某几项的标准
const only = (items, base = 60) => ({ enabled: true, base, items: Object.fromEntries(ITEM_KEYS.map(k => [k, { mode: 'off', points: 0, missing: 'pending', aiWiden: true, ...(items[k] || {}) }])) });

test('教师岗：按旧赋分标准换算出的筛选标准，结论和分数与原来完全一致', () => {
  const cases = [
    card(), card({ intentText: '家教' }), card({ age: 31 }), card({ intentText: '会计' }), card({ intentText: '' }), card({ age: null }),
    card({ educationLevel: '大专', educationExperiences: [{ schoolName: 'XX 职业学院', educationLevel: '大专', beginDate: '2018.09', endDate: '2021.07' }] }),
    card({ educationLevel: '硕士', educationExperiences: [{ schoolName: '东北师范大学', educationLevel: '硕士', beginDate: '2022.09', endDate: '2025.07' }, { schoolName: '辽宁大学', educationLevel: '本科', beginDate: '2018.09', endDate: '2022.07' }] }),
    card({ age: 35, workExperiences: [work('XX 培训学校', '数学老师', '2024.01', '2026.01')] }),
    card({ age: 43, workExperiences: [work('XX 中学', '物理教师', '2010.09', '2026.01')] }),
    card({ age: 42, workExperiences: [work('XX 中学', '物理教师', '2010.09', '2026.01')] }),
    card({ age: 28, workYearsLabel: '3年', workExperiences: [{ companyName: '新东方', jobTitle: '英语老师' }] }),
    card({ age: 26, workExperiences: [work('XX 科技有限公司', '销售', '2023.01', '2026.01')] }),
    // 专升本、还在上学
    card({ educationExperiences: [{ schoolName: '沈阳大学', educationLevel: '本科', beginDate: '2020.09', endDate: '2022.07' }, { schoolName: 'XX 职业学院', educationLevel: '大专', beginDate: '2017.09', endDate: '2020.07' }] }),
    card({ age: 21, educationExperiences: [{ schoolName: '沈阳大学', educationLevel: '本科', beginDate: '2024.09', endDate: '至今' }] }),
  ];
  for (const c of cases) {
    const old = applyGradRule(screen(c, rules), c, rules.maxGradYear), now = screenCriteria(c, teacherCr());
    assert.equal(now.verdict, old.verdict, `${JSON.stringify(c.edus)} ${c.age} ${c.intent}: ${now.reason} / ${old.reason}`);
    assert.equal(now.score, old.score, `${c.age} ${c.intent}: ${now.rules.find(r => r.id === 'S').ev}`);
  }
});

test('必须满足：任一不满足 → 不推荐，理由写明是哪一项', () => {
  const cr = only({ age: { mode: 'must', min: 22, max: 35 }, edu: { mode: 'must', min: '本科' } });
  assert.equal(screenCriteria(card({ age: 25 }), cr).verdict, '推荐');
  const r = screenCriteria(card({ age: 21 }), cr);
  assert.equal(r.verdict, '不推荐'); assert.match(r.reason, /年龄 22–35 岁不满足：21 岁/);
  assert.equal(screenCriteria(card({ educationLevel: '大专', educationExperiences: [] }), cr).verdict, '不推荐');
});

test('缺信息时：待确认 / 不推荐 / 算满足，每项单独设', () => {
  const at = missing => screenCriteria(card({ age: null }), only({ age: { mode: 'must', max: 35, missing } })).verdict;
  assert.equal(at('pending'), '待确认');
  assert.equal(at('fail'), '不推荐');
  assert.equal(at('pass'), '推荐');
});

test('加分项不影响推荐与否，只加分', () => {
  const cr = only({ age: { mode: 'must', max: 35 }, normal: { mode: 'bonus', points: 8 }, master: { mode: 'bonus', points: 5 } });
  const a = screenCriteria(card(), cr), b = screenCriteria(card({ educationExperiences: [{ schoolName: '沈阳师范大学', educationLevel: '本科', beginDate: '2018.09', endDate: '2022.07' }] }), cr);
  assert.equal(a.verdict, '推荐'); assert.equal(a.score, 60);
  assert.equal(b.verdict, '推荐'); assert.equal(b.score, 68);
});

test('没勾「AI 可放宽」的必须项是硬条件（AI 复核不会放宽）', () => {
  const r = screenCriteria(card({ age: 40 }), only({ age: { mode: 'must', max: 35, aiWiden: false }, edu: { mode: 'must', min: '本科', aiWiden: true } }));
  assert.equal(r.rules.find(x => x.id === 'C:age').hard, true);
  assert.equal(r.rules.find(x => x.id === 'C:edu').hard, false);
});

test('备注选项：性别、求职状态、期望城市、期望薪资', () => {
  const c = normalizeZhaopin({ resumeNumber: 'y', age: 26, educationLevel: '本科', gender: '女', careerStatus: '离职-随时到岗', cityLabel: '沈阳', desiredSalary: '6-8K', intentText: '老师' });
  assert.equal(screenCriteria(c, only({ gender: { mode: 'must', want: '女' } })).verdict, '推荐');
  assert.equal(screenCriteria(c, only({ gender: { mode: 'must', want: '男' } })).verdict, '不推荐');
  assert.equal(screenCriteria(c, only({ status: { mode: 'must', want: '在职' } })).verdict, '不推荐');
  assert.equal(screenCriteria(c, only({ city: { mode: 'must', kw: ['沈阳'] } })).verdict, '推荐');
  assert.equal(screenCriteria(c, only({ salaryMax: { mode: 'must', max: 7000 } })).verdict, '推荐');
  assert.equal(screenCriteria(c, only({ salaryMax: { mode: 'must', max: 5000 } })).verdict, '不推荐');
  assert.equal(salaryFloor('8千-1万'), 8000); assert.equal(salaryFloor('面议'), null); assert.equal(salaryFloor('8000-10000元/月'), 8000);
});

test('备注选项：排除词、必须词、频繁跳槽、教育工作经验月数', () => {
  const c = card({ age: 30, workExperiences: [work('A 公司', '销售', '2021.01', '2021.05'), work('B 公司', '客服', '2021.07', '2021.12'), work('C 学校', '老师', '2022.01', '2024.12')] });
  assert.equal(screenCriteria(c, only({ excludeKw: { mode: 'must', kw: ['销售'] } })).verdict, '不推荐');
  assert.equal(screenCriteria(c, only({ includeKw: { mode: 'must', kw: ['老师'] } })).verdict, '推荐');
  assert.equal(screenCriteria(c, only({ jobHop: { mode: 'must', shortMonths: 12, maxCount: 1 } })).verdict, '不推荐');
  assert.equal(screenCriteria(c, only({ jobHop: { mode: 'must', shortMonths: 12, maxCount: 2 } })).verdict, '推荐');
  assert.equal(screenCriteria(c, only({ eduExp: { mode: 'must', minMonths: 24 } })).verdict, '推荐');
  assert.equal(screenCriteria(c, only({ eduExp: { mode: 'must', minMonths: 48 } })).verdict, '不推荐');
});

test('教师资格证：简历没写 → 缺信息（不当成没有）', () => {
  assert.equal(screenCriteria(card(), only({ cert: { mode: 'must' } })).verdict, '待确认');
  assert.equal(screenCriteria(card({ certificateNames: ['高中数学教师资格证'] }), only({ cert: { mode: 'must', kw: ['数学'] } })).verdict, '推荐');
});

test('保存过的标准补齐以后新加的项（新项默认不看）', () => {
  const role = { ...DEFAULT_ROLES.xueguan, criteria: { enabled: true, base: 50, items: { age: { mode: 'must', max: 30 } } } };
  const f = fullCriteria('xueguan', role, rules);
  assert.equal(f.saved, true); assert.equal(f.base, 50);
  assert.equal(f.items.age.max, 30); assert.equal(f.items.edu.mode, 'off');
  assert.equal(fullCriteria('xueguan', DEFAULT_ROLES.xueguan, rules).saved, false);
});
