import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZhaopin, screen, bachelorCheck } from '../src/rules.js';
import { DEFAULT_SETTINGS } from '../src/db.js';

const rules = DEFAULT_SETTINGS.rules;
const card = (edus, extra = {}) => normalizeZhaopin({ resumeNumber: 'X', userName: '甲', age: '27', educationLevel: '本科', workYears: '3年',
  workExperiences: [{ companyName: '某中学', jobTitle: '物理教师' }], educationExperiences: edus, ...extra });

test('截图里的三位专升本：教师岗不推荐，且是硬规则', () => {
  const cases = [
    [{ schoolName: '沈阳工业大学', majorName: '机械设计制造及其自动化', educationLevel: '本科', beginDate: '2023.09', endDate: '2025.06' }, { schoolName: '抚顺师范高等专科学校', majorName: '数学教育', educationLevel: '大专', beginDate: '2020.10', endDate: '2023.07' }],
    [{ schoolName: '辽宁科技大学', majorName: '软件工程', educationLevel: '本科', beginDate: '2024.09', endDate: '2026.07' }, { schoolName: '北京农业职业学院', majorName: '园林技术', educationLevel: '大专', beginDate: '2015.09', endDate: '2018.06' }],
    [{ schoolName: '沈阳大学', majorName: '旅游管理', educationLevel: '本科', beginDate: '2021.09', endDate: '2023.07' }, { schoolName: '辽宁政法职业学院', majorName: '司法助理', educationLevel: '大专', beginDate: '2018.09', endDate: '2021.07' }],
  ];
  for (const edus of cases) {
    const sc = screen(card(edus), rules);
    assert.equal(sc.verdict, '不推荐', edus[0].schoolName);
    const r6 = sc.rules.find(r => r.id === 'R06');
    assert.ok(r6 && r6.ok === false && r6.hard, edus[0].schoolName);
    assert.match(sc.reason, /专升本/);
  }
});

test('专升本的其他写法：大专学校没写学历、本科只读两年', () => {
  assert.equal(bachelorCheck(card([{ schoolName: '沈阳大学', educationLevel: '本科', beginDate: '2021.09', endDate: '2023.07' }])).ok, false);
  assert.equal(bachelorCheck(card([{ schoolName: '沈阳大学', educationLevel: '本科', beginDate: '2017.09', endDate: '2021.07' }, { schoolName: '辽宁职业技术学院', beginDate: '2014.09', endDate: '2017.07' }])).ok, false);
});

test('本科毕业后才读的“大专”（如国外语言学校）不算专升本', () => {
  const c = card([{ schoolName: '辽宁财贸学院', educationLevel: '本科', beginDate: '2011.09', endDate: '2015.07' }, { schoolName: '日本长野县ici语言学校', educationLevel: '大专', beginDate: '2016.10', endDate: '2017.10' }]);
  assert.equal(bachelorCheck(c).ok, true);
});

test('大专、非统招本科：不推荐；统招四年本科、硕士：不受影响', () => {
  assert.equal(screen(card([{ schoolName: '辽宁职业学院', educationLevel: '大专', beginDate: '2018.09', endDate: '2021.07' }], { educationLevel: '大专' }), rules).verdict, '不推荐');
  const nt = screen(card([{ schoolName: '沈阳师范大学', majorName: '物理学', educationLevel: '本科', beginDate: '2017.09', endDate: '2021.07', mode: '自考' }]), rules);
  assert.equal(nt.verdict, '不推荐');
  assert.match(nt.reason, /非统招/);
  const okc = screen(card([{ schoolName: '沈阳师范大学', majorName: '物理学', educationLevel: '本科', beginDate: '2017.09', endDate: '2021.07' }]), rules);
  assert.equal(okc.verdict, '推荐');
  assert.equal(okc.rules.find(r => r.id === 'R06').ok, true);
  const ms = screen(card([{ schoolName: '东北师范大学', majorName: '物理学', educationLevel: '硕士', beginDate: '2021.09', endDate: '2024.06' }, { schoolName: '沈阳师范大学', majorName: '物理学', educationLevel: '本科', beginDate: '2017.09', endDate: '2021.07' }], { educationLevel: '硕士' }), rules);
  assert.equal(ms.verdict, '推荐');
  // 关掉开关：回到只看最高学历
  assert.equal(screen(card([{ schoolName: '沈阳大学', majorName: '物理学', educationLevel: '本科', beginDate: '2021.09', endDate: '2023.07' }, { schoolName: '辽宁政法职业学院', educationLevel: '大专', beginDate: '2018.09', endDate: '2021.07' }]), { ...rules, requireTongzhaoBachelor: false }).rules.some(r => r.id === 'R06'), false);
});
