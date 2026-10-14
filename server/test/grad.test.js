import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZhaopin, gradYearOf, applyGradRule, screen } from '../src/rules.js';
import { DEFAULT_SETTINGS } from '../src/db.js';
import { screenRole, DEFAULT_ROLES } from '../src/roles.js';

const card = (edu, extra = {}) => normalizeZhaopin({ resumeNumber: 'X', userName: '甲', age: '22', educationLevel: '本科', workYears: '应届', workExperiences: [], educationExperiences: [{ schoolName: '沈阳师范大学', majorName: '数学', educationLevel: '本科', ...edu }], ...extra });

test('毕业年份：结束时间、至今、届数标签', () => {
  assert.equal(gradYearOf(card({ beginDate: '2023.09', endDate: '2027.06' })), 2027);
  assert.equal(gradYearOf(card({ beginDate: '2019.09', endDate: '2023.06' })), 2023);
  assert.equal(gradYearOf(card({ beginDate: '2024.09', endDate: '至今' })), 2028); // 本科 4 年
  assert.equal(gradYearOf(card({ beginDate: '2023.09' })), null); // 只有开始时间：不猜
  assert.equal(gradYearOf(card({}, { gradText: '27届' })), 2027);
  assert.equal(gradYearOf(card({}, { gradText: '2029-06' })), 2029);
  assert.equal(gradYearOf(card({}, { workYearsLabel: '28届应届生' })), 2028);
  assert.equal(gradYearOf(card({}, { gradText: '在校生' })), new Date().getFullYear() + 1);
  assert.equal(gradYearOf(card({}, { gradText: '27年应届' })), 2027); // 智联 graduates 字段
  assert.equal(gradYearOf(card({}, { gradText: '20年' })), null); // 工作年限，不是毕业年份
  assert.equal(gradYearOf(card({ beginDate: '2020.09', endDate: '2024.06' }, { gradText: '在校生' })), 2024); // 有结束时间时以结束时间为准
  // older rows without separate begin/end
  assert.equal(gradYearOf({ edus: [{ t: '2023.09-2027.06', deg: '本科' }] }), 2027);
  assert.equal(gradYearOf({ edus: [{ t: '2023.09', deg: '本科' }] }), null);
});

test('2027 年及以后毕业：所有岗位都不推荐；2026 及以前不受影响', () => {
  const rules = DEFAULT_SETTINGS.rules;
  assert.equal(rules.maxGradYear, 2026);
  for (const y of ['2027.06', '2028.06', '2029.06', '2031.06']) {
    const c = card({ beginDate: '2023.09', endDate: y }, { desiredJobType: '初中数学教师' });
    const t = applyGradRule(screen(c, rules), c, rules.maxGradYear);
    assert.equal(t.verdict, '不推荐', `教师 ${y}`);
    assert.match(t.reason, /还在上学/);
    assert.ok(t.rules.some(r => r.id === 'G01' && r.hard && r.ok === false));
    for (const key of ['xueguan', 'zixun']) {
      const r = applyGradRule(screenRole(c, DEFAULT_ROLES[key]), c, rules.maxGradYear);
      assert.equal(r.verdict, '不推荐', `${key} ${y}`);
    }
  }
  const ok = card({ beginDate: '2022.09', endDate: '2026.06' }, { desiredJobType: '初中数学教师' });
  const base = screen(ok, rules);
  const t = applyGradRule(base, ok, rules.maxGradYear);
  assert.equal(t.verdict, base.verdict);
  assert.ok(t.rules.some(r => r.id === 'G01' && r.ok === true));
  // unknown graduation year: no change
  const unk = card({ beginDate: '2023.09' });
  assert.deepEqual(applyGradRule(screen(unk, rules), unk, rules.maxGradYear), screen(unk, rules));
  // 0 = no limit
  const c27 = card({ beginDate: '2023.09', endDate: '2027.06' });
  assert.equal(applyGradRule(screen(c27, rules), c27, 0).verdict, screen(c27, rules).verdict);
});
