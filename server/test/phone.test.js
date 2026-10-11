import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mobileIn } from '../src/rules.js';

test('识别完整的 11 位手机号（允许空格 / 横线），隐藏号码不算', () => {
  assert.equal(mobileIn('我的电话是 138 1234 5678，随时联系'), '13812345678');
  assert.equal(mobileIn('手机号：139-0000-1111'), '13900001111');
  assert.equal(mobileIn('138****5678'), '');
  assert.equal(mobileIn('订单号 2138123456789'), '');      // part of a longer number
  assert.equal(mobileIn('12345678901'), '');               // not a mobile prefix
  assert.equal(mobileIn(''), '');
});
