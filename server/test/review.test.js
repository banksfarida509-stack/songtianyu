import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReview } from '../src/ai.js';

test('按备注复核只放宽：不推荐 → 推荐 / 待确认 可以', () => {
  assert.equal(applyReview('不推荐', '推荐'), '推荐');
  assert.equal(applyReview('不推荐', '待确认'), '待确认');
  assert.equal(applyReview('待确认', '推荐'), '推荐');
});

test('复核不会把人判成不推荐；推荐最多降为待确认', () => {
  assert.equal(applyReview('推荐', '不推荐'), '推荐');
  assert.equal(applyReview('待确认', '不推荐'), '待确认');
  assert.equal(applyReview('推荐', '待确认'), '待确认');
  assert.equal(applyReview('推荐', '乱写'), '推荐');
});
