// Smoke test for the daily greeting caps and the 消息-page heartbeat (v0.9.0).
// usage: node test/greet.smoke.mjs http://127.0.0.1:3199/hr admin <password>
const [base, user, pass] = process.argv.slice(2);
let cookie = '';
const call = async (path, { method, body, token } = {}) => {
  const r = await fetch(base + '/api' + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', cookie, ...(token ? { 'X-HR-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
};
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL ' + msg); console.log('ok -', msg); };

await call('/login', { body: { username: user, password: pass } });
const st = await call('/settings');
const token = st.extToken;
ok(st.greet.daily.teacher === 100 && st.greet.daily.xueguan === 50 && st.greet.daily.zixun === 50, 'default caps 教师 100 / 学管师 50 / 课程顾问 50');
ok(st.autoReply.keepImTab === true, 'keepImTab on by default');

// the recommend page alone: 消息 page reported as not open
let p = await call('/ext/ping', { body: { page: '/app/recommend', version: '0.9.0', platform: 'zhaopin', kind: 'rec' }, token });
ok(p.imAlive.zhaopin === false && p.auto.keepImTab === true, 'recommend only → 消息页 not alive');
p = await call('/ext/ping', { body: { page: '/app/im', version: '0.9.0', platform: 'zhaopin', kind: 'im' }, token });
ok(p.imAlive.zhaopin === true && p.imAlive.boss === false, '消息页 ping → alive for 智联 only');

// caps: a small cap for 学管师 so the limit is reached
await call('/settings', { method: 'PUT', body: { greet: { continuous: true, daily: { teacher: 100, xueguan: 2, zixun: 50, other: 30 } } } });
let q = await call('/ext/greet/quota', { body: { platform: 'zhaopin', job: '学管师' }, token });
ok(q.role === 'xueguan' && q.cap === 2 && q.used === 0 && q.left === 2 && q.continuous, 'quota for 学管师 job');
let g = await call('/ext/greeted', { body: { platform: 'zhaopin', uid: 'G1', name: '甲', job: '学管师' }, token });
ok(g.quota.used === 1 && g.quota.left === 1, 'greeting counted (even for an unknown candidate)');
g = await call('/ext/greeted', { body: { platform: 'zhaopin', uid: 'G2', name: '乙', job: '学管师' }, token });
ok(g.quota.left === 0, 'cap reached');
q = await call('/ext/greet/quota', { body: { platform: 'boss', job: '学管师' }, token });
ok(q.used === 0 && q.left === 2, 'BOSS counted separately');
q = await call('/ext/greet/quota', { body: { platform: 'zhaopin', job: '初中数学老师' }, token });
ok(q.role === 'teacher' && q.cap === 100 && q.used === 0, '教师 counted separately');
const stats = await call('/stats');
ok(stats.greetToday.zhaopin.xueguan === 2 && stats.imAlive.zhaopin === true && stats.greet.daily.xueguan === 2, 'dashboard shows counts and page status');

// 同事聊过: from the card, or from our own records (an earlier greeting)
const card = (id, peerChat) => ({ resumeNumber: id, userName: '测试' + id, age: '26', educationLevel: '本科', workYears: '2年', workExperiences: [{ companyName: '某中学', jobTitle: '数学教师' }], educationExperiences: [{ schoolName: '沈阳师范大学', majorName: '数学', educationLevel: '本科' }], peerChat });
let sr = await call('/ext/screen', { body: { platform: 'zhaopin', job: '初中数学老师', cards: [card('P1', '同事王老师 3天前沟通过'), card('P2', ''), card('G1', '')] }, token });
const by = Object.fromEntries(sr.results.map(x => [x.uid, x]));
ok(by.P1.peer === '同事王老师 3天前沟通过', 'peer from the card');
ok(by.P2.peer === '', 'no peer for a fresh candidate');
await call('/ext/greeted', { body: { platform: 'zhaopin', uid: 'P2', name: '乙', job: '初中数学老师' }, token });
sr = await call('/ext/screen', { body: { platform: 'zhaopin', job: '初中数学老师', cards: [card('P2', '')] }, token });
ok(sr.results[0].peer === '系统里已有沟通记录', 'peer from our own greeting record');

// one automatic reply per candidate message, whichever page asks first
let cl = await call('/ext/chat/claim', { body: { candidateId: by.P1.id, sig: 's1:m9', by: 'tabA' }, token });
ok(cl.ok === true, 'first page claims the reply');
cl = await call('/ext/chat/claim', { body: { candidateId: by.P1.id, sig: 's1:m9', by: 'tabB' }, token });
ok(cl.ok === false && /另一个页面/.test(cl.why), 'second page is refused');
cl = await call('/ext/chat/claim', { body: { candidateId: by.P1.id, sig: 's1:m9', by: 'tabA' }, token });
ok(cl.ok === true, 'same page may retry');
cl = await call('/ext/chat/claim', { body: { candidateId: by.P1.id, sig: 's1:m10', by: 'tabB' }, token });
ok(cl.ok === true, 'a new candidate message can be answered again');

await call('/ext/diag', { body: { kind: 'greet', data: { end: '停止：测试' } }, token });
const d = await call('/diag');
ok(d.greet && d.greet.list.length === 1, 'greet stop report stored');
console.log('all greet checks passed');
