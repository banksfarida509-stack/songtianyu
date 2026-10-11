// Runs in the page's own JS world (MAIN) so it can read the data the page has
// already loaded (Vue component props / Vuex store). It makes NO network
// requests. It only reads, plus three explicit actions requested by the
// content script after the recruiter clicks: fill the input box, click a native
// button, click 打招呼 on one card.
(() => {
  if (window.__hraMain) return;
  window.__hraMain = true;
  const post = (type, data) => window.postMessage({ __hra: 'main', type, data }, location.origin);
  const pickArr = (a, n, f) => (Array.isArray(a) ? a.slice(0, n).map(f) : []);

  function rootVm() {
    for (const el of document.querySelectorAll('#app, body > div')) if (el.__vue__) return el.__vue__.$root;
    for (const el of document.querySelectorAll('body *')) if (el.__vue__) return el.__vue__.$root;
    return null;
  }
  function cardVm(el) {
    for (let e = el, k = 0; e && k < 5; e = e.parentElement, k++) if (e.__vue__ && e.__vue__.$props && e.__vue__.$props.candidate) return e.__vue__;
    return null;
  }
  // job-intention fields come as string / array / object depending on the page;
  // collect their text only.
  function texts(v, d = 0, out = []) {
    if (v == null || d > 3 || out.length > 20) return out;
    if (typeof v === 'string') { const t = v.replace(/<[^>]+>/g, '').trim(); if (t && t.length < 60 && !out.includes(t)) out.push(t); }
    else if (Array.isArray(v)) v.slice(0, 10).forEach(x => texts(x, d + 1, out));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!/id$|code|num|url|img|avatar|phone|mobile/i.test(k)) texts(x, d + 1, out);
    return out;
  }
  // whitelist: no avatar, phone, ids beyond resumeNumber
  function pick(c) {
    return {
      intentText: texts([c.desiredJobType, c.preferredJobType, c.desiredJobTypeHighlights, c.desiredJobTypeName, c.jobIntention, c.purposeJobType]).join(' ').slice(0, 200),
      resumeNumber: c.resumeNumber, userName: c.userName, gender: c.gender, age: c.age, educationLevel: c.educationLevel,
      workYears: c.workYears, workYearsLabel: c.workYearsLabel, careerStatus: c.careerStatus, desiredSalary: c.desiredSalary,
      cityLabel: c.cityLabel, desiredJobType: typeof c.desiredJobType === 'string' ? c.desiredJobType : '',
      workExperiences: pickArr(c.workExperiences, 6, w => ({ beginDate: w.beginDate, endDate: w.endDate, companyName: w.companyName, jobTitle: w.jobTitle, jobSubTitle: w.jobSubTitle })),
      educationExperiences: pickArr(c.educationExperiences, 4, e => ({ beginDate: e.beginDate, endDate: e.endDate, schoolName: e.schoolName, majorName: e.majorName, educationLevel: e.educationLevel, schoolTag: e.schoolTag })),
      skillTags: pickArr(c.skillTags, 12, x => String(x)), certificateNames: pickArr(c.certificateNames, 10, x => String(x)),
      selfEvaluation: typeof c.selfEvaluation === 'string' ? c.selfEvaluation.slice(0, 400) : '',
    };
  }
  function currentJob() {
    try {
      const num = new URLSearchParams(location.search).get('jobNumber');
      const list = rootVm()?.$store?.state?.jobs?.jobList || [];
      const j = list.find(x => x.jobNumber === num);
      return (j && (j.jobTitle || j.jobName || j.title)) || '';
    } catch { return ''; }
  }

  // ---------- recommend page ----------
  let lastSig = '';
  function readRecommend() {
    const els = [...document.querySelectorAll('.recommend-item__inner')];
    const cards = [];
    for (const el of els) {
      const vm = cardVm(el);
      const c = vm && vm.$props.candidate;
      if (!c || !c.resumeNumber) continue;
      el.setAttribute('data-hra-uid', c.resumeNumber);
      cards.push(pick(c));
    }
    const sig = cards.map(c => c.resumeNumber).join(',');
    if (sig && sig !== lastSig) { lastSig = sig; post('recommend', { cards, job: currentJob() }); }
  }

  // ---------- chat page ----------
  // resume data for the open conversation: the platform keeps it in some component
  // or in the session object; find an object that looks like a resume.
  const looksResume = o => o && typeof o === 'object' && !Array.isArray(o) &&
    (Array.isArray(o.workExperiences) || Array.isArray(o.educationExperiences) || ('educationLevel' in o && ('age' in o || 'workYears' in o || 'workYearsLabel' in o)));
  function findResume(root, uid, depth = 0, seen = new Set()) {
    if (!root || typeof root !== 'object' || depth > 3 || seen.has(root)) return null;
    seen.add(root);
    if (looksResume(root) && (!uid || !root.resumeNumber || root.resumeNumber === uid)) return root;
    for (const v of Object.values(root)) { if (v && typeof v === 'object') { const r = findResume(v, uid, depth + 1, seen); if (r) return r; } }
    return null;
  }
  function resumeFor(sess) {
    const uid = sess.resumeNumber || '';
    let r = findResume(sess, uid);
    if (!r) {
      let n = 0;
      for (const el of document.querySelectorAll('div, section, aside')) {
        if (++n > 4000) break;
        const vm = el.__vue__;
        if (!vm || vm.$el !== el) continue;
        r = findResume(vm.$props, uid) || findResume(vm.$data, uid);
        if (r) break;
      }
    }
    return r ? { ...pick(r), resumeNumber: r.resumeNumber || uid } : null;
  }
  // who started the conversation: candidate (applied / wrote first) or us (greeted)
  function originOf(tl) {
    const first = tl.find(m => m && (m.flow === 'in' || m.flow === 'out'));
    const applied = tl.some(m => m && m.type !== 'text' && /投递|简历|resume|deliver/i.test(JSON.stringify(m).slice(0, 2000)) && m.flow === 'in');
    if (applied) return 'applied';
    return !first ? 'unknown' : first.flow === 'in' ? 'applied' : 'greeted';
  }
  // Text of any timeline item. Besides plain text, candidates send cards
  // (附件简历, 交换微信, 面试邀约 …) whose text sits in other fields or in a JSON
  // string; those count as messages too, marked with [卡片].
  function cardText(m) {
    const seen = [];
    const walk = (v, d) => {
      if (v == null || d > 3 || seen.length > 6) return;
      if (typeof v === 'string') {
        const s = v.trim();
        if (/^[[{]/.test(s)) { try { return walk(JSON.parse(s), d + 1); } catch { /* plain text */ } }
        if (s && s.length < 200 && !/^https?:|^\d+$|^[\w-]{16,}$/.test(s) && /[一-龥]/.test(s) && !seen.includes(s)) seen.push(s);
        return;
      }
      if (Array.isArray(v)) return v.slice(0, 6).forEach(x => walk(x, d + 1));
      if (typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!/avatar|icon|url|img|phone|mobile|token|sign/i.test(k)) walk(x, d + 1);
    };
    for (const k of ['text', 'content', 'custom', 'attach', 'body', 'title', 'desc', 'msg', 'data', 'pushContent', 'tip']) walk(m[k], 0);
    return seen.slice(0, 3).join(' ');
  }
  function toMsgs(tl, n) {
    const out = [];
    for (const m of tl) {
      if (!m || (m.flow !== 'in' && m.flow !== 'out')) continue;
      let text = m.type === 'text' ? m.text : cardText(m);
      if (!text) continue;
      if (m.type !== 'text') text = `[卡片${/简历|附件/.test(text) ? '·附件简历' : ''}] ${text}`;
      out.push({ id: m.idServer || m.idClient, dir: m.flow === 'in' ? 'in' : 'out', text: String(text).slice(0, 500), at: m.time ? new Date(m.time).toISOString() : '' });
    }
    return out.slice(-n);
  }
  let lastChatSig = '';
  const profileCache = new Map();
  function readChat() {
    const st = rootVm()?.$store?.state?.im;
    if (!st || !st.activeSessionId) return;
    const sess = st.currentSession || sessionsOf(st).find(s => sessId(s) === st.activeSessionId) || {};
    const tl = (st.timelineMap?.[st.activeSessionId]?.timeline) || [];
    const msgs = toMsgs(tl, 30);
    const sig = st.activeSessionId + ':' + (msgs.length ? msgs[msgs.length - 1].id : '');
    if (sig === lastChatSig) return;
    lastChatSig = sig;
    // the resume panel may render after the messages; retry until found
    if (!profileCache.get(st.activeSessionId)) { try { profileCache.set(st.activeSessionId, resumeFor(sess)); } catch { /* try again next time */ } }
    post('chat', { sessionId: st.activeSessionId, uid: sess.resumeNumber || '', name: nameOf(sess), job: sess.jobTitle || '', state: sess.candidateState || '',
      origin: originOf(tl), profile: profileCache.get(st.activeSessionId), messages: msgs });
  }

  // ---------- actions (only on explicit request from the recruiter) ----------
  function fill(text) {
    const ta = document.querySelector('textarea.km-input__original[placeholder*="对话"]') || document.querySelector('.im-sender textarea, textarea.km-input__original');
    if (!ta) return post('actionResult', { ok: false, msg: '没找到聊天输入框' });
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    post('actionResult', { ok: true, msg: '已填入输入框，请检查后点“发送”' });
  }
  // ---------- full-auto helpers ----------
  const chatInput = () => document.querySelector('textarea.km-input__original[placeholder*="对话"]') || document.querySelector('.im-sender textarea, textarea.km-input__original');
  function sendBtn(ta) {
    for (let box = ta, k = 0; box && k < 8; box = box.parentElement, k++) {
      const b = [...box.querySelectorAll('button, .km-button, [class*="send"]')].find(e => visible(e) && /^发\s*送$/.test((e.innerText || '').trim()));
      if (b) return b;
    }
    return [...document.querySelectorAll('button, .km-button')].find(e => visible(e) && /^发\s*送$/.test((e.innerText || '').trim())) || null;
  }
  // fill and send one bubble; types it in a few chunks so the page sees input events like a person
  async function sendText(text, reqId) {
    const ta = chatInput();
    if (!ta) return post('sendResult', { reqId, ok: false, msg: '没找到聊天输入框' });
    if (ta.value.trim()) return post('sendResult', { reqId, ok: false, msg: '输入框里有你正在写的内容，已跳过自动发送' });
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    ta.focus();
    const step = Math.max(4, Math.ceil(text.length / 4));
    for (let i = step; i < text.length + step; i += step) {
      setter.call(ta, text.slice(0, i)); ta.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(250 + Math.random() * 400);
    }
    await wait(300 + Math.random() * 500);
    const b = sendBtn(ta);
    if (b) realClick(b);
    else for (const t of ['keydown', 'keypress', 'keyup']) ta.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    for (let k = 0; k < 10; k++) { await wait(300); if (!ta.value.trim()) return post('sendResult', { reqId, ok: true, msg: '已发送' }); }
    post('sendResult', { reqId, ok: false, msg: '点了发送，但输入框没清空，可能被平台拦截，请看一下页面' });
  }
  const unreadOf = s => { for (const [k, v] of Object.entries(s || {})) if (/unread/i.test(k) && typeof v === 'number') return v; return 0; };
  const sessId = s => s && (s.sessionId || s.id || s.sessionID);
  const nameOf = s => (s && (s.name || s.userName || s.nickName || s.nick || s.candidateName)) || '';
  // the conversation list: usually state.im.sessions, otherwise the array (or id→session map)
  // in the im state whose items look like sessions
  function sessionsOf(st) {
    if (!st) return [];
    if (Array.isArray(st.sessions) && st.sessions.length) return st.sessions;
    let best = [];
    for (const v of Object.values(st)) {
      const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : null;
      if (!arr || arr.length <= best.length) continue;
      const ok = arr.filter(x => x && typeof x === 'object' && sessId(x) && nameOf(x)).length;
      if (ok && ok >= arr.length * 0.6) best = arr.filter(x => x && typeof x === 'object' && sessId(x));
    }
    return best;
  }
  // the active id may be formatted differently from the list's id (prefixes), so compare loosely
  function isActive(st, s) {
    const a = String(st.activeSessionId || ''), id = String(sessId(s) || '');
    if (!a || !id) return false;
    if (a === id || a.endsWith(id) || id.endsWith(a)) return true;
    const cur = st.currentSession;
    return !!(cur && ((sessId(cur) && String(sessId(cur)) === id) || (nameOf(s) && nameOf(cur) === nameOf(s) && cur.jobTitle === s.jobTitle)));
  }
  function sessionEl(sess) {
    const id = sessId(sess);
    // prefer the Vue component that owns this session
    for (const el of document.querySelectorAll('li, [class*="session"], [class*="conversation"], [class*="item"]')) {
      const vm = el.__vue__;
      if (vm && visible(el) && vm.$props && Object.values(vm.$props).some(p => p && typeof p === 'object' && sessId(p) === id)) return el;
    }
    // fall back to the list row whose text contains the name, in the left part of the screen
    const name = nameOf(sess);
    if (!name) return null;
    const rows = [...document.querySelectorAll('li, [class*="session"], [class*="item"]')].filter(e => {
      if (!visible(e) || !(e.innerText || '').includes(name)) return false;
      const r = e.getBoundingClientRect();
      return r.left < window.innerWidth * 0.45 && r.height > 30 && r.height < 140;
    });
    return rows.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0] || null;
  }
  // Switch to a conversation and verify it really became the active one. Several
  // ways are tried in turn (row click, name click, the row component's own click
  // handler, the store's "switch session" action); the one that works is reused.
  const SAFE_ACTION = /(active|current|select|switch|open|enter|change)_?session/i;
  const UNSAFE = /delete|remove|top|mute|clear|read|hide|block|close|del/i;
  let openHow = null;
  function openWays(sess) {
    const id = sessId(sess), ways = [];
    const el = sessionEl(sess);
    if (el) {
      ways.push(['点会话行', () => realClick(el)]);
      const nm = nameOf(sess).trim();
      const nameEl = nm && [...el.querySelectorAll('*')].find(e => e.children.length === 0 && (e.innerText || '').trim() === nm);
      if (nameEl) ways.push(['点姓名', () => realClick(nameEl)]);
      for (let vm = el.__vue__, k = 0; vm && k < 3; vm = vm.$parent, k++) {
        for (const m of Object.keys(vm.$options?.methods || {})) {
          if (/click|select|choose|open|switch|change|enter/i.test(m) && !UNSAFE.test(m)) ways.push([`组件方法 ${vmName(vm)}.${m}`, () => vm[m](sess)]);
        }
      }
    }
    const store = rootVm()?.$store;
    for (const a of Object.keys(store?._actions || {})) {
      if (SAFE_ACTION.test(a.replace(/\//g, '_')) && !UNSAFE.test(a)) { ways.push([`store.dispatch ${a}(id)`, () => store.dispatch(a, id)]); ways.push([`store.dispatch ${a}(session)`, () => store.dispatch(a, sess)]); }
    }
    if (openHow) ways.sort((x, y) => (y[0] === openHow) - (x[0] === openHow));
    return ways;
  }
  async function activate(st, sess) {
    if (isActive(st, sess)) return { ok: true, how: '已在会话' };
    const ways = openWays(sess);
    for (const [how, fn] of ways) {
      try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch { continue; }
      for (let k = 0; k < 8; k++) {
        await wait(250);
        if (isActive(st, sess)) { openHow = how; return { ok: true, how }; }
      }
    }
    return { ok: false, tried: ways.map(w => w[0]) };
  }
  async function openSession(id, reqId) {
    const st = rootVm()?.$store?.state?.im;
    const sess = sessionsOf(st).find(s => sessId(s) === id);
    if (!sess) return post('openResult', { reqId, ok: false, msg: '没找到这个会话' });
    const r = await activate(st, sess);
    if (r.ok) return post('openResult', { reqId, ok: true, how: r.how, msg: `打开会话：${nameOf(sess)}（${r.how}）` });
    post('openResult', { reqId, ok: false, failed: true, id, msg: `打不开会话「${nameOf(sess)}」，已跳过（试过：${r.tried.join('、') || '没找到会话行'}）` });
  }
  // sessions whose row in the left list shows a red number badge (when the unread
  // count is not readable from the store)
  // rows in the left list that show a red number badge (unread), top to bottom
  function badgeRows() {
    const badges = [...document.querySelectorAll('[class*="badge"], [class*="unread"], [class*="count"], [class*="num"], [class*="dot"], sup')]
      .filter(e => visible(e) && /^\d{1,3}\+?$/.test((e.innerText || '').trim()) && e.getBoundingClientRect().left < window.innerWidth * 0.45);
    const rows = [];
    for (const b of badges) {
      let row = b;
      // climb to the list row: the ancestor that is about as tall as one conversation entry
      for (let k = 0; k < 10 && row && row.getBoundingClientRect().height < 50; k++) row = row.parentElement;
      if (!row || row.getBoundingClientRect().height > 160) continue;
      // first word that is not the badge number or the “在线” tag
      const name = (row.innerText || '').trim().split(/\s+/).find(w => !/^\d+\+?$/.test(w) && w !== '在线') || '';
      if (!rows.some(r => r.row === row)) rows.push({ row, name, top: row.getBoundingClientRect().top });
    }
    return rows.sort((a, b) => a.top - b.top);
  }
  function badgeSessions(st) {
    const sessions = sessionsOf(st), out = [];
    for (const { row } of badgeRows()) {
      const text = row.innerText || '';
      const s = sessions.find(x => nameOf(x) && text.includes(nameOf(x)) && (!x.jobTitle || text.includes(x.jobTitle)));
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  }
  // click a badge row directly (used when the session list cannot be read) and verify the switch
  async function openRow({ row, name }, reqId) {
    const st = rootVm()?.$store?.state?.im;
    const before = st?.activeSessionId;
    const targets = [row, ...[...row.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.innerText || '').trim() === name)];
    for (const t of targets) {
      realClick(t);
      for (let k = 0; k < 8; k++) { await wait(250); if (st?.activeSessionId && st.activeSessionId !== before) return post('openResult', { reqId, ok: true, how: '点未读行', msg: `打开会话：${name}（点未读行）` }); }
    }
    post('openResult', { reqId, ok: false, failed: true, id: `row:${name}`, msg: `打不开会话「${name}」，已跳过（试过：点未读行）` });
  }
  // next conversation with unread messages
  function nextUnread(reqId, skip) {
    const st = rootVm()?.$store?.state?.im;
    if (!st) return post('openResult', { reqId, ok: false, msg: '未读到聊天数据（页面还在加载？）' });
    if ((chatInput()?.value || '').trim()) return post('openResult', { reqId, ok: false, msg: '输入框有内容，暂不切换会话' });
    const usable = s => !isActive(st, s) && !(skip || []).includes(sessId(s));
    let cand = sessionsOf(st).filter(s => usable(s) && unreadOf(s) > 0);
    if (!cand.length) cand = badgeSessions(st).filter(usable);
    if (cand.length) return openSession(sessId(cand[0]), reqId);
    // session list not readable: open the first red-badge row that is not the current one
    const cur = nameOf(st.currentSession || {});
    const row = badgeRows().find(r => r.name && r.name !== cur && !(skip || []).includes(`row:${r.name}`));
    if (row) return openRow(row, reqId);
    post('openResult', { reqId, ok: false, none: true, msg: '没有未读会话', sessions: sessionsOf(st).length, badges: badgeRows().length });
  }

  // read past conversations one by one (opens each; never types or sends).
  // Sessions with unread messages are skipped so they are not marked as read.
  const msgsOf = (st, sid) => toMsgs((st.timelineMap?.[sid]?.timeline) || [], 200);
  let collecting = false;
  async function collectHistory(reqId, max) {
    const st = rootVm()?.$store?.state?.im;
    if (!st) return post('historyResult', { reqId, ok: false, msg: '未读到会话列表' });
    if (collecting) return post('historyResult', { reqId, ok: false, msg: '正在采集中' });
    collecting = true;
    const list = sessionsOf(st).filter(s => unreadOf(s) === 0).slice(0, max || 30);
    const out = []; let skipped = sessionsOf(st).length - list.length;
    for (let i = 0; i < list.length && collecting; i++) {
      const s = list[i], id = sessId(s);
      let msgs = msgsOf(st, id);
      if (!msgs.length || !isActive(st, s)) {
        const r = await activate(st, s);
        if (!r.ok) { skipped++; continue; }
        for (let k = 0; k < 12; k++) { if (msgsOf(st, st.activeSessionId).length) break; await wait(300); }
        await wait(500 + Math.random() * 800);
        msgs = msgsOf(st, st.activeSessionId);
      }
      const cur = st.currentSession && sessId(st.currentSession) === id ? st.currentSession : s;
      if (msgs.length) out.push({ sessionId: id, uid: cur.resumeNumber || s.resumeNumber || '', name: nameOf(cur) || nameOf(s), job: cur.jobTitle || s.jobTitle || '', messages: msgs });
      post('historyProgress', { reqId, done: i + 1, total: list.length, name: nameOf(s) });
    }
    collecting = false;
    post('historyResult', { reqId, ok: true, sessions: out, skipped });
  }

  // ---------- interview invitation (平台「约面试」) ----------
  const dialogs = () => [...document.querySelectorAll('.km-modal, .km-dialog, [role="dialog"], .el-dialog, .km-drawer')].filter(visible);
  const inviteDialog = () => dialogs().find(d => /面试/.test(d.innerText || '')) || null;
  const vmsIn = root => { const out = new Set(); for (const el of [root, ...root.querySelectorAll('*')]) if (el.__vue__) out.add(el.__vue__); return [...out]; };
  const vmName = vm => (vm.$options && (vm.$options.name || vm.$options._componentTag)) || '';
  const labelOf = el => {
    const item = el.closest('[class*="form-item"], [class*="formItem"], tr, li') || el.parentElement;
    const lab = item && item.querySelector('label, [class*="label"]');
    return ((lab && lab.innerText) || '').replace(/\s+/g, '').slice(0, 20);
  };
  // structure of the open invite dialog (labels, component types, buttons) — no personal values
  function describeDialog(d) {
    const fields = vmsIn(d).filter(vm => vm.$props && 'value' in vm.$props && vm.$el && visible(vm.$el)).map(vm => {
      const v = vm.$props.value;
      return { label: labelOf(vm.$el), comp: vmName(vm), type: v instanceof Date ? 'Date' : Array.isArray(v) ? 'Array' : typeof v,
        sample: v instanceof Date ? 'Date' : typeof v === 'string' ? (/\d{6,}/.test(v) ? '<数字>' : v.slice(0, 20)) : typeof v === 'number' ? 'number' : Array.isArray(v) ? `len ${v.length}` : String(v).slice(0, 20) };
    });
    const buttons = [...d.querySelectorAll('button, .km-button')].filter(visible).map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 12);
    const labels = [...d.querySelectorAll('label, [class*="label"]')].map(l => (l.innerText || '').trim()).filter(Boolean).slice(0, 30);
    return { title: (d.querySelector('[class*="title"], [class*="header"]')?.innerText || '').trim().slice(0, 30), fields, labels, buttons };
  }
  function setVm(vm, value) { vm.$emit('input', value); vm.$emit('change', value); }
  async function sendInvite(reqId, { date, slot, place }) {
    if (!clickByText('约面试')) return post('inviteResult', { reqId, ok: false, msg: '没找到「约面试」按钮' });
    let d = null;
    for (let k = 0; k < 15 && !d; k++) { await wait(300); d = inviteDialog(); }
    if (!d) return post('inviteResult', { reqId, ok: false, msg: '点了「约面试」，但没弹出邀约窗口' });
    const [h, mi] = String(slot || '09:00').split(':').map(Number);
    const at = new Date(`${date}T00:00:00`); at.setHours(h, mi, 0, 0);
    const filled = [];
    // only the outermost value-holding component of each field (not the inner text box of a picker)
    const all = vmsIn(d).filter(vm => vm.$props && 'value' in vm.$props && vm.$el && visible(vm.$el));
    const outer = all.filter(vm => { for (let p = vm.$parent; p; p = p.$parent) if (all.includes(p)) return false; return true; });
    for (const vm of outer) {
      try {
      const name = vmName(vm), lab = labelOf(vm.$el);
      if (/date|time|picker/i.test(name) || /时间|日期/.test(lab)) {
        const v = vm.$props.value;
        const val = /time/i.test(name) && !/date/i.test(name) && typeof v === 'string' ? slot : /date/i.test(name) && !/time/i.test(name) ? new Date(`${date}T00:00:00`) : at;
        setVm(vm, val); filled.push(lab || name);
      } else if (place && /地点|地址/.test(lab) && typeof vm.$props.value === 'string' && !vm.$props.value) {
        setVm(vm, place); filled.push(lab);
      }
      } catch { /* leave this field for the recruiter */ }
    }
    await wait(600);
    const ok = [...d.querySelectorAll('button, .km-button')].filter(visible).find(b => /^(发送|确定|确认|发送邀请|发出邀请|立即邀约|发送面试邀请)$/.test((b.innerText || '').trim()));
    if (!ok) return post('inviteResult', { reqId, ok: false, keepOpen: true, msg: `邀约窗口已打开并填了：${filled.join('、') || '无'}；没找到发送按钮，请你确认后点发送`, shape: describeDialog(d) });
    realClick(ok);
    for (let k = 0; k < 12; k++) {
      await wait(300);
      if (!document.contains(d) || !visible(d)) return post('inviteResult', { reqId, ok: true, msg: `已发送面试邀约：${date} ${slot}` });
    }
    const errs = [...d.querySelectorAll('[class*="error"], [class*="tip"]')].filter(visible).map(e => e.innerText.trim()).filter(Boolean).slice(0, 3).join('；');
    post('inviteResult', { reqId, ok: false, keepOpen: true, msg: `邀约窗口没能自动提交${errs ? '：' + errs : ''}，请你在窗口里补全后点发送`, shape: describeDialog(d) });
  }
  // when the recruiter sends an invite by hand, remember the dialog's shape so automation can be tuned
  document.addEventListener('click', e => {
    if (!e.isTrusted) return;
    const d = inviteDialog();
    const b = e.target.closest && e.target.closest('button, .km-button');
    if (d && b && d.contains(b) && /发送|确定|确认|邀约|邀请/.test((b.innerText || '').trim())) post('inviteShape', describeDialog(d));
  }, true);
  function clickByText(name) {
    const b = [...document.querySelectorAll('button, .km-button, div, span, a')].filter(e => visible(e) && e.children.length <= 2 && (e.innerText || '').trim() === name);
    const inner = b.filter(x => !b.some(o => o !== x && x.contains(o)));
    const t = inner.find(e => e.tagName === 'BUTTON') || inner[0];
    if (!t) return false;
    realClick(t); return true;
  }
  // what the page exposes for the open conversation (key names / types only), for tuning
  function diagnose() {
    const st = rootVm()?.$store?.state?.im;
    const shape = (o, d = 0) => {
      if (o == null || typeof o !== 'object') return typeof o;
      if (d > 2) return Array.isArray(o) ? 'array' : 'object';
      if (Array.isArray(o)) return o.length ? [shape(o[0], d + 1)] : [];
      return Object.fromEntries(Object.keys(o).slice(0, 60).map(k => [k, shape(o[k], d + 1)]));
    };
    const sess = st && (st.currentSession || {});
    const tl = (st && st.timelineMap?.[st.activeSessionId]?.timeline) || [];
    return {
      url: location.pathname, session: shape(sess), messageTypes: [...new Set(tl.map(m => `${m.type}/${m.flow}`))],
      firstMessage: tl[0] ? { type: tl[0].type, flow: tl[0].flow, keys: Object.keys(tl[0]).slice(0, 30) } : null,
      resumeFound: !!resumeFor(sess || {}), openHow,
      imKeys: Object.keys(st || {}).slice(0, 60), sessionsFound: sessionsOf(st).length,
      unreadInStore: sessionsOf(st).filter(s => unreadOf(s) > 0).map(nameOf).slice(0, 10), badgeRows: badgeRows().map(r => r.name).slice(0, 10),
      sessionActions: Object.keys(rootVm()?.$store?._actions || {}).filter(a => /session/i.test(a)).slice(0, 40),
      sessionMutations: Object.keys(rootVm()?.$store?._mutations || {}).filter(a => /session/i.test(a)).slice(0, 40),
      unreadKeys: Object.keys(sessionsOf(st)[0] || {}).filter(k => /unread|read/i.test(k)),
      sessionRow: (() => { const s0 = sessionsOf(st)[0]; const el = s0 && sessionEl(s0); return el ? { tag: el.tagName, cls: String(el.className).slice(0, 80), vm: el.__vue__ ? vmName(el.__vue__) : '', methods: Object.keys(el.__vue__?.$options?.methods || {}).slice(0, 20) } : null; })(),
      quickButtons: [...document.querySelectorAll('button, .km-button')].filter(visible).map(b => (b.innerText || '').trim()).filter(t => t && t.length < 8).slice(0, 30),
    };
  }

  function clickNative(name) {
    const b = [...document.querySelectorAll('button, div, span')].find(e => e.offsetParent && e.children.length <= 2 && (e.innerText || '').trim() === name);
    if (!b) return post('actionResult', { ok: false, msg: `没找到“${name}”按钮` });
    b.click();
    post('actionResult', { ok: true, msg: `已点平台“${name}”，请在弹出的窗口里完成` });
  }
  // The card's action buttons are only rendered while the mouse is over it, so
  // hover first, then look for a visible button by its text.
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const visible = e => !!(e && e.offsetParent && e.getClientRects().length);
  const GREET_RE = /^(打招呼|继续沟通|已沟通|立即沟通)$/;
  // Pick the innermost visible element with the label, preferring a real <button>
  // (clicking the wrapper div does not reach the platform's click handler).
  function findGreetBtn(scope) {
    const hits = [...scope.querySelectorAll('button, .resume-button, .km-button, [role="button"]')]
      .filter(b => visible(b) && GREET_RE.test((b.innerText || '').trim()));
    const inner = hits.filter(b => !hits.some(o => o !== b && b.contains(o)));
    return inner.find(b => b.tagName === 'BUTTON') || inner.find(b => b.closest('button')) || inner[0] || null;
  }
  function realClick(b) {
    const r = b.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    b.dispatchEvent(new PointerEvent('pointerdown', o)); b.dispatchEvent(new MouseEvent('mousedown', o));
    b.dispatchEvent(new PointerEvent('pointerup', o)); b.dispatchEvent(new MouseEvent('mouseup', o));
    b.click();
  }
  function hover(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + Math.min(40, r.height / 2) };
    for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
  }
  function openDialogText() {
    const d = [...document.querySelectorAll('.km-modal, .km-dialog, [role="dialog"], .el-dialog, .km-popover')].find(visible);
    return d ? (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  }
  // After a greeting the platform may pop a "去聊天 / 继续推荐" prompt. Choosing
  // to stay on the list is safe (it sends nothing), so we click it ourselves.
  const STAY_RE = /^(继续推荐|继续浏览|继续看推荐|留在当前页|留在此页|暂不沟通|稍后再聊|我知道了|知道了)$/;
  function clickStay() {
    const b = [...document.querySelectorAll('button, .km-button, a, span, div')]
      .filter(e => visible(e) && e.children.length <= 2 && STAY_RE.test((e.innerText || '').trim()));
    const inner = b.filter(x => !b.some(o => o !== x && x.contains(o)));
    const t = inner.find(e => e.tagName === 'BUTTON') || inner[0];
    if (!t) return '';
    realClick(t);
    return t.innerText.trim();
  }
  async function greet(uid) {
    if (clickStay()) await wait(800);
    const el = document.querySelector(`[data-hra-uid="${CSS.escape(uid)}"]`);
    if (!el) return post('greetResult', { uid, ok: false, msg: '卡片已不在页面上（翻页或刷新了）' });
    const scope = el.closest('.recommend-item') || el;
    let btn = null;
    for (let k = 0; k < 10 && !btn; k++) { hover(scope); hover(el); await wait(200); btn = findGreetBtn(scope); }
    if (!btn) return post('greetResult', { uid, ok: false, msg: '没找到打招呼按钮（悬停后仍未出现）' });
    if (/继续沟通|已沟通/.test(btn.innerText || '')) return post('greetResult', { uid, ok: true, msg: '已沟通过' });
    const desc = `${btn.tagName.toLowerCase()}.${String(btn.className || '').split(/\s+/).slice(0, 2).join('.')}`;
    realClick(btn);
    await wait(1500);
    let stayed = '';
    for (let k = 0; k < 4 && !stayed; k++) { stayed = clickStay(); if (!stayed) await wait(400); }
    if (stayed) { await wait(900); return post('greetResult', { uid, ok: true, msg: `打招呼成功（已自动点「${stayed}」）` }); }
    const dlg = openDialogText();
    if (dlg) return post('greetResult', { uid, ok: false, dialog: true, msg: `点了打招呼，平台弹出窗口：「${dlg}」——请手动处理，已暂停` });
    // verify for up to ~10 s: the platform updates the label slowly, or drops
    // the greeted card from the list, or jumps to chat. Any of these = success.
    let after = '';
    for (let k = 0; k < 20; k++) {
      if (!location.pathname.includes('/app/recommend')) return post('greetResult', { uid, ok: true, msg: '打招呼成功（页面已跳转）' });
      const st = clickStay(); if (st) { await wait(900); return post('greetResult', { uid, ok: true, msg: `打招呼成功（已自动点「${st}」）` }); }
      const cur = document.querySelector(`[data-hra-uid="${CSS.escape(uid)}"]`);
      if (!cur || !document.contains(scope)) return post('greetResult', { uid, ok: true, msg: '打招呼成功（卡片已移出推荐列表）' });
      hover(scope); await wait(500);
      const b2 = findGreetBtn(scope); after = b2 ? b2.innerText.trim() : '';
      if (/继续沟通|已沟通/.test(after)) return post('greetResult', { uid, ok: true, msg: `打招呼成功（按钮变为「${after}」）` });
    }
    post('greetResult', { uid, ok: false, unverified: true, msg: `点了 ${desc}，10 秒内按钮仍是「${after || '未知'}」，未确认成功` });
  }
  // platform risk-control signals → content script stops automation
  function riskSignal() {
    const t = document.body.innerText || '';
    return /操作过于频繁|操作频繁|请完成安全验证|滑动验证|账号存在异常/.test(t.slice(0, 200000));
  }

  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.__hra !== 'iso' || e.source !== window) return;
    if (d.type === 'fill') fill(d.text);
    if (d.type === 'native') clickNative(d.name);
    if (d.type === 'greet') greet(d.uid);
    if (d.type === 'send') sendText(String(d.text || ''), d.reqId);
    if (d.type === 'open') openSession(d.id, d.reqId);
    if (d.type === 'nextUnread') nextUnread(d.reqId, d.skip);
    if (d.type === 'history') collectHistory(d.reqId, d.max);
    if (d.type === 'invite') sendInvite(d.reqId, d);
    if (d.type === 'diagnose') { let r; try { r = diagnose(); } catch (er) { r = { error: String(er && er.message || er) }; } post('diagResult', { reqId: d.reqId, ok: true, data: r }); }
    if (d.type === 'historyStop') collecting = false;
    if (d.type === 'more') {
      // load the next batch of recommend cards (infinite scroll)
      clickStay();
      const els = document.querySelectorAll('.recommend-item__inner');
      els.length && els[els.length - 1].scrollIntoView({ block: 'end' });
      window.scrollBy(0, 2000);
      document.querySelectorAll('*').forEach(e => { if (e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight; });
      const more = [...document.querySelectorAll('button, a, div, span')].find(e => visible(e) && e.children.length <= 1 && /^(加载更多|查看更多|换一批)$/.test((e.innerText || '').trim()));
      more && more.click();
    }
    if (d.type === 'reread') { lastSig = ''; lastChatSig = ''; tick(); }
  });

  let n = 0;
  function tick() {
    try {
      if (location.pathname.includes('/app/recommend')) readRecommend();
      if (location.pathname.includes('/app/im') && !collecting) readChat();
      if (++n % 4 === 0 && riskSignal()) post('risk', {});
    } catch (e) { post('error', { msg: String(e && e.message || e) }); }
  }
  setInterval(tick, 1500);
  tick();
})();
