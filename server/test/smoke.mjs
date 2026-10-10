// End-to-end smoke test against a running server.
// usage: node test/smoke.mjs http://127.0.0.1:3199/hr admin <password> [extToken]
const [base, user, pass] = process.argv.slice(2);
let cookie = '';
const call = async (path, { method, body, token } = {}) => {
  const r = await fetch(base + '/api' + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', cookie, ...(token ? { 'X-HR-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error(`${path} ${r.status} ${t.slice(0, 200)}`);
  return d;
};
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL ' + msg); console.log('ok -', msg); };

ok((await call('/health')).ok, 'health');
await call('/login', { body: { username: user, password: pass } });
ok((await call('/me')).user === user, 'login');
const st = await call('/settings');
const token = st.extToken;
ok(token && token.length > 10, 'ext token present');
// extension: screen two cards (shape of the real 智联 props)
const cards = [
  { resumeNumber: 'SMOKE1', userName: '测试甲', age: '27', educationLevel: '本科', workYears: '3年', workExperiences: [{ beginDate: '2023.07', endDate: '至今', companyName: '某县第一中学', jobTitle: '高一物理教师' }], educationExperiences: [{ schoolName: '东北师范大学', majorName: '物理学', educationLevel: '本科', schoolTag: '211' }], certificateNames: [] },
  { resumeNumber: 'SMOKE2', userName: '测试乙', age: '38', educationLevel: '硕士', workYears: '10年', workExperiences: [{ companyName: '某培训学校', jobTitle: '化学教研组长' }], educationExperiences: [{ schoolName: '辽宁大学', majorName: '化学', educationLevel: '硕士' }] },
];
const sr = await call('/ext/screen', { body: { platform: 'zhaopin', job: '理科老师', cards }, token });
ok(sr.results.length === 2 && sr.results[0].verdict === '推荐' && sr.results[1].verdict === '不推荐', 'ext screen verdicts');
let bad = false; try { await call('/ext/screen', { body: { cards }, token: 'wrong' }); } catch { bad = true; }
ok(bad, 'ext rejects wrong token');
const rs = await call('/ext/reasons', { body: { platform: 'zhaopin', uids: ['SMOKE1'] }, token });
ok(typeof rs.reasons === 'object', 'ext reasons endpoint answers' + (rs.error ? ` (LLM: ${rs.error.slice(0, 60)})` : ''));
// chat suggestion through extension path
const cs = await call('/ext/chat/suggest', { body: { platform: 'zhaopin', uid: 'SMOKE1', name: '测试甲', job: '理科老师', messages: [{ dir: 'out', text: '你好，方便聊聊吗？' }, { dir: 'in', text: '明天下午可以去面试' }] }, token });
ok(cs.draft && cs.draft.reply, `chat suggest: intent=${cs.draft.intent} action=${cs.draft.action} model=${cs.draft.model}`);
if (cs.draft.action === '约面试') {
  await call('/ext/chat/applied', { body: { candidateId: cs.candidateId, draft: cs.draft }, token });
  const c = await call('/candidates/' + cs.candidateId);
  ok(c.appt && c.attend === '待确认', `booked ${c.appt.date} ${c.appt.slot}`);
}
// admin chat test: confirm
const ct = await call(`/candidates/${cs.candidateId}/chat-test`, { body: { text: '好的，我会准时到', apply: true } });
ok(ct.draft.intent, 'chat-test intent ' + ct.draft.intent + ' → ' + ct.candidate.attend);
// schedule + auto
await call('/demo/seed', { body: {} });
const sch = await call('/schedule');
ok(Array.isArray(sch.days) && sch.days.length >= 5, 'schedule days ' + sch.days.map(d => d.date + ':' + d.n).join(' '));
const au = await call('/schedule/auto', { body: {} });
ok(au.placed.length >= 1, 'auto schedule placed ' + au.placed.map(p => p.name + '@' + p.date + ' ' + p.slot).join(', '));
const stats = await call('/stats');
ok(stats.total >= 12, 'stats total ' + stats.total);
const risk = await call('/tools/riskcheck', { body: { text: '关注公众号 123456789' } });
ok(risk.platform.length === 2, 'risk check');
const cl = await call('/demo/clear', { body: {} });
ok(cl.removed >= 12, 'demo cleared ' + cl.removed);
console.log('ALL OK');
