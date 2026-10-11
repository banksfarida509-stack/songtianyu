import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJson } from '../src/llm.js';

test('JSON 前面有 [卡片] 之类的文字也能解析', () => {
  assert.deepEqual(parseJson('[卡片] {"intent":"提问","reply":"好的"}'), { intent: '提问', reply: '好的' });
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('结果：[{"key":"x","reason":"y"}]'), [{ key: 'x', reason: 'y' }]);
  assert.deepEqual(parseJson('{"reply":"见 [D1]"} 以上'), { reply: '见 [D1]' });
  assert.throws(() => parseJson('[卡片] 没有 JSON'));
});
