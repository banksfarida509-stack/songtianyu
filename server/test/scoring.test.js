// 教师岗赋分标准（负责人 2026-10-20 定）：
// 本科、30 岁以内、无教育经验但求职方向是教学类 → 60；研究生 +5；本科 985/211 +5；研究生 985/211 再 +5；
// 教育工作经验 半年-1年 +5、1-3年 +10、3-5年 +15、5年以上 +20（不叠加）；学校、任何教育机构都算；超过 42 岁不合适。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZhaopin, screen } from '../src/rules.js';
import { DEFAULT_SETTINGS } from '../src/db.js';

const rules = { ...DEFAULT_SETTINGS.rules, requireTongzhaoBachelor: false };
const card = (o = {}) => normalizeZhaopin({ resumeNumber: 'x', userName: '张三', age: 25, educationLevel: '本科', intentText: '初中数学老师',
  educationExperiences: [{ schoolName: '沈阳大学', majorName: '数学', educationLevel: '本科', beginDate: '2018.09', endDate: '2022.07' }], workExperiences: [], ...o });
const work = (org, role, b, e) => ({ companyName: org, jobTitle: role, beginDate: b, endDate: e });

test('本科、30 岁以内、无经验、求职方向是教学类：60 分推荐', () => {
  const r = screen(card(), rules);
  assert.equal(r.verdict, '推荐'); assert.equal(r.score, 60);
});
test('求职“家教”也算教学类', () => {
  assert.equal(screen(card({ intentText: '家教' }), rules).score, 60);
});
test('研究生 +5；研究生 985/211 再 +5；本科 985/211 +5', () => {
  const edus = [{ schoolName: '东北师范大学', educationLevel: '硕士', beginDate: '2022.09', endDate: '2025.07' }, { schoolName: '辽宁大学', educationLevel: '本科', beginDate: '2018.09', endDate: '2022.07' }];
  assert.equal(screen(card({ educationLevel: '硕士', educationExperiences: edus }), rules).score, 75);
  assert.equal(screen(card({ educationLevel: '硕士', educationExperiences: [edus[0], { ...edus[1], schoolName: '沈阳大学' }] }), rules).score, 70);
  assert.equal(screen(card({ educationExperiences: [{ schoolName: '北京师范大学', educationLevel: '本科', beginDate: '2018.09', endDate: '2022.07' }] }), rules).score, 65);
  assert.equal(screen(card({ educationExperiences: [{ schoolName: '沈阳大学', educationLevel: '本科', schoolTag: '211', beginDate: '2018.09', endDate: '2022.07' }] }), rules).score, 65);
});
test('独立学院不算 985/211', () => {
  assert.equal(screen(card({ educationExperiences: [{ schoolName: '重庆大学城市科技学院', educationLevel: '本科', beginDate: '2018.09', endDate: '2022.07' }] }), rules).score, 60);
});
test('教育工作经验按年限一档加分，不叠加；私立学校、培训机构都算', () => {
  const at = (b, e) => screen(card({ age: 35, workExperiences: [work('XX 培训学校', '数学老师', b, e)] }), rules);
  assert.equal(at('2026.01', '2026.05').score, 60);  // 不到半年
  assert.equal(at('2025.10', '2026.06').score, 65);  // 9 个月
  assert.equal(at('2024.01', '2026.01').score, 70);  // 2 年
  assert.equal(at('2022.01', '2026.01').score, 75);  // 4 年
  assert.equal(at('2018.01', '2026.01').score, 80);  // 8 年
  assert.equal(at('2024.01', '2026.01').verdict, '推荐'); // 35 岁有经验也推荐
  // 两段经历加起来算年限，只取一档
  const two = screen(card({ age: 33, workExperiences: [work('XX 实验中学', '语文教师', '2019.09', '2022.08'), work('学而思', '主讲老师', '2022.09', '2025.08')] }), rules);
  assert.equal(two.score, 80);
});
test('只有总年限、经历没写起止时间：按总年限算', () => {
  assert.equal(screen(card({ age: 28, workYearsLabel: '3年', workExperiences: [{ companyName: '新东方', jobTitle: '英语老师' }] }), rules).score, 75);
});
test('超过 42 岁一律不合适；42 岁可以', () => {
  const w = [work('XX 中学', '物理教师', '2010.09', '2026.01')];
  assert.equal(screen(card({ age: 43, workExperiences: w }), rules).verdict, '不推荐');
  assert.equal(screen(card({ age: 42, workExperiences: w }), rules).verdict, '推荐');
  assert.equal(screen(card({ age: 42, workExperiences: w }), rules).score, 80);
});
test('没有经验：超过 30 岁、或求职方向不是教学类 → 不推荐；没写方向 → 待确认', () => {
  assert.equal(screen(card({ age: 31 }), rules).verdict, '不推荐');
  assert.equal(screen(card({ intentText: '会计' }), rules).verdict, '不推荐');
  assert.equal(screen(card({ intentText: '' }), rules).verdict, '待确认');
});
test('非教育类工作不算教育经验', () => {
  const r = screen(card({ age: 26, workExperiences: [work('XX 科技有限公司', '销售', '2023.01', '2026.01')] }), rules);
  assert.equal(r.score, 60);
  assert.equal(screen(card({ age: 26, workExperiences: [work('XX 教育科技', '课程顾问', '2023.01', '2026.01')] }), rules).score, 60);
});
test('赋分明细写在规则列表里', () => {
  const r = screen(card({ educationLevel: '硕士', educationExperiences: [{ schoolName: '华中师范大学', educationLevel: '硕士', beginDate: '2022.09', endDate: '2025.07' }] }), rules);
  const s = r.rules.find(x => x.id === 'S');
  assert.match(s.ev, /研究生学历 \+5/); assert.match(s.ev, /研究生 985 \/ 211 \+5/); assert.equal(s.raw, 70);
});
test('后台改了分值就按新分值算', () => {
  const r = screen(card({ workExperiences: [work('XX 中学', '教师', '2024.01', '2026.01')] }), { ...rules, scoring: { ...rules.scoring, base: 50, exp: [[6, 3], [12, 8], [36, 12], [60, 18]] } });
  assert.equal(r.score, 58);
});
