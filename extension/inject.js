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
  // how a degree was studied (统招 / 全日制 / 自考 / 成人 / 函授 …), from whatever field carries it
  function eduMode(e) {
    const out = [];
    for (const [k, v] of Object.entries(e || {})) {
      if (typeof v === 'string' && v.length <= 20 && /统招|全日制|非统招|自考|成人|函授|网络|业余|非全日制|开放|夜大/.test(v)) out.push(v);
      else if (typeof v === 'boolean' && /unif|tongzhao|fulltime|full_time|statutory|recruit/i.test(k)) out.push(v ? '统招' : '非统招');
    }
    return out.join(' ').slice(0, 30);
  }
  // whitelist: no avatar, phone, ids beyond resumeNumber
  function pick(c) {
    return {
      // only a number the platform already shows in full (masked ones are dropped by the server)
      phone: [c.phone, c.mobile, c.mobilePhone, c.telephone].find(v => typeof v === 'string' || typeof v === 'number') || '',
      intentText: texts([c.desiredJobType, c.preferredJobType, c.desiredJobTypeHighlights, c.desiredJobTypeName, c.jobIntention, c.purposeJobType]).join(' ').slice(0, 200),
      resumeNumber: c.resumeNumber, userName: c.userName, gender: c.gender, age: c.age, educationLevel: c.educationLevel,
      workYears: c.workYears, workYearsLabel: c.workYearsLabel, careerStatus: c.careerStatus, desiredSalary: c.desiredSalary,
      cityLabel: c.cityLabel, desiredJobType: typeof c.desiredJobType === 'string' ? c.desiredJobType : '',
      workExperiences: pickArr(c.workExperiences, 6, w => ({ beginDate: w.beginDate, endDate: w.endDate, companyName: w.companyName, jobTitle: w.jobTitle, jobSubTitle: w.jobSubTitle })),
      educationExperiences: pickArr(c.educationExperiences, 4, e => ({ beginDate: e.beginDate, endDate: e.endDate, schoolName: e.schoolName, majorName: e.majorName, educationLevel: e.educationLevel, schoolTag: e.schoolTag, mode: eduMode(e) })),
      skillTags: pickArr(c.skillTags, 12, x => String(x)), certificateNames: pickArr(c.certificateNames, 10, x => String(x)),
      selfEvaluation: typeof c.selfEvaluation === 'string' ? c.selfEvaluation.slice(0, 400) : '',
    };
  }
  // The job the recommend list is showing. Switching the job tabs at the top does not always
  // change the URL, so the tab marked active on the page comes first, then the recommend
  // module's state, then the URL's jobNumber, then a bold job title near the top.
  function currentJob() {
    try {
      const store = rootVm()?.$store;
      const list = store?.state?.jobs?.jobList || [];
      const titleOf = j => (j && (j.jobTitle || j.jobName || j.title)) || '';
      const titles = list.map(titleOf).filter(Boolean);
      const asTitle = t => { t = (t || '').trim(); return titles.find(x => x === t) || titles.find(x => t.length >= 2 && (x.startsWith(t) || t.startsWith(x))) || ''; };
      const near = e => { const r = e.getBoundingClientRect(); return r.top < 260 && r.height < 60; };
      const leaves = [...document.querySelectorAll('div, span, a, li, p')].filter(e => e.children.length === 0 && asTitle(e.textContent) && visible(e) && near(e));
      const active = leaves.find(e => { for (let el = e, k = 0; el && k < 3; el = el.parentElement, k++) if (/active|selected|current|checked/i.test(String(el.className || '')) || el.getAttribute('aria-selected') === 'true') return true; return false; });
      if (active) return asTitle(active.textContent);
      for (const mod of ['recommend', 'recommendTalent', 'talent', 'recommendList']) {
        const s = store?.state?.[mod];
        if (!s || typeof s !== 'object') continue;
        for (const [k, v] of Object.entries(s)) if (/jobNumber|jobId/i.test(k) && v) { const j = list.find(x => x.jobNumber === v || x.jobId === v); if (j) return titleOf(j); }
      }
      const num = new URLSearchParams(location.search).get('jobNumber');
      const j = num && list.find(x => x.jobNumber === num);
      if (j) return titleOf(j);
      const bold = leaves.find(e => +getComputedStyle(e).fontWeight >= 600);
      return bold ? asTitle(bold.textContent) : '';
    } catch { return ''; }
  }
  // a greeting the recruiter clicked by hand on a card (our own clicks are not trusted events)
  document.addEventListener('click', e => {
    if (!e.isTrusted || !location.pathname.includes('/app/recommend')) return;
    const b = e.target.closest && e.target.closest('button, .resume-button, .km-button, [role="button"]');
    if (!b || (b.innerText || '').trim() !== '打招呼') return;
    const scope = b.closest('.recommend-item');
    const el = scope && (scope.querySelector('[data-hra-uid]') || (scope.hasAttribute('data-hra-uid') ? scope : null));
    const uid = el && el.getAttribute('data-hra-uid');
    if (!uid) return;
    setTimeout(() => {
      const now = findGreetBtn(scope);
      if (!now || (now.innerText || '').trim() !== '打招呼' || openDialogText()) post('manualGreet', { uid, job: currentJob() });
    }, 2500);
  }, true);

  // ---------- recommend page ----------
  // “a colleague already talked to this person”: a field on the candidate object whose name
  // says so, or a label on the card such as “同事张三 3天前沟通过”
  const PEER_KEY = /colleague|coworker|teammate|peerHr|otherHr|otherStaff|contactedBy|communicatedBy|chattedBy|^mate(Name|Id|Info)?$/i;
  const PEER_TXT = /同事[^\n]{0,12}?(沟通|联系|聊过|打过招呼|招呼过|约面|邀约)[^\n]{0,6}/;
  function peerOf(c, el) {
    for (const [k, v] of Object.entries(c || {})) {
      if (!PEER_KEY.test(k) || v == null || v === false || v === 0 || v === '') continue;
      if (typeof v === 'string' && /^(0|false|null|undefined)$/i.test(v.trim())) continue;
      if (Array.isArray(v) && !v.length) continue;
      const nm = typeof v === 'string' ? v.trim() : v && typeof v === 'object' ? Object.values(v).find(x => typeof x === 'string' && /[一-龥]/.test(x)) : '';
      return nm && nm.length <= 12 ? `同事${nm}聊过` : '同事聊过';
    }
    const m = cardText(el).match(PEER_TXT);
    return m ? m[0].trim().slice(0, 30) : '';
  }
  // a card's own text, without the AI line we add to it (which may say “同事聊过” itself)
  function cardText(el) {
    if (!el) return '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll('.hra-line').forEach(x => x.remove());
    return copy.textContent || '';
  }
  // graduation year / label: a field whose name says so (智联 userGraduateDescription), else
  // “27届 / 2027年毕业” on the card, else 智联's in-school flag
  // (智联: `graduates` holds “27年应届生”; userGraduateDescription is sometimes the work years, “10年”)
  const GRAD_RE = /(?<!\d)(?:20)?\d{2}\s*(?:届|年毕业|年应届)/;
  function gradOf(c, el) {
    const vals = Object.entries(c || {}).filter(([k, v]) => /grad|graduat|biye/i.test(k) && (typeof v === 'string' || typeof v === 'number')).map(([, v]) => String(v));
    const labelled = vals.find(v => GRAD_RE.test(v));
    if (labelled) return labelled.match(GRAD_RE)[0];
    const dated = vals.find(v => /(?:19|20)\d{2}/.test(v));
    if (dated) return dated.slice(0, 20);
    const m = cardText(el).match(GRAD_RE);
    if (m) return m[0];
    return c && c.isSchoolResume === true ? '在校生' : '';
  }
  let lastSig = '';
  function readRecommend() {
    const els = [...document.querySelectorAll('.recommend-item__inner')];
    const cards = [];
    for (const el of els) {
      const vm = cardVm(el);
      const c = vm && vm.$props.candidate;
      if (!c || !c.resumeNumber) continue;
      el.setAttribute('data-hra-uid', c.resumeNumber);
      cards.push({ ...pick(c), peerChat: peerOf(c, el), gradText: gradOf(c, el) });
    }
    // the job is part of the signature: switching the job tab re-screens the same cards with that role
    const job = currentJob();
    const sig = job + '|' + cards.map(c => c.resumeNumber).join(',');
    if (cards.length && sig !== lastSig) { lastSig = sig; post('recommend', { cards, job }); }
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
  // Mobile numbers the platform shows for this conversation: phone-named fields on the
  // session, and phone-named fields / “手机 …” texts inside the candidate's own cards
  // (exchange-phone card). Other long numbers (account ids) are ignored.
  const MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
  const PHONE_KEY = /phone|mobile|^tel$|telephone/i;
  function phonesOf(sess, tl) {
    const out = new Set();
    const add = v => { const m = String(v || '').replace(/[\s-]/g, '').match(MOBILE); if (m) out.add(m[0]); };
    const walk = (o, d, keyHint) => {
      if (o == null || d > 4) return;
      if (typeof o === 'string') {
        const s = o.trim();
        if (/^[[{]/.test(s)) { try { return walk(JSON.parse(s), d + 1, keyHint); } catch { /* not JSON */ } }
        if (keyHint || /手机|电话/.test(s)) add(s);
        return;
      }
      if (typeof o === 'number') { if (keyHint) add(o); return; }
      if (typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, d + 1, PHONE_KEY.test(k));
    };
    for (const [k, v] of Object.entries(sess || {})) if (PHONE_KEY.test(k) && (typeof v === 'string' || typeof v === 'number')) add(v);
    for (const m of tl) if (m && m.flow === 'in' && m.type !== 'text') for (const k of ['custom', 'content', 'attach', 'pushPayload']) walk(m[k], 0, false);
    return [...out].slice(0, 3);
  }
  // 智联 keeps the open conversation's resume in im.activeResume (loaded after the messages)
  function activeResumeOf(st, sess) {
    const r = st && st.activeResume;
    if (!r || typeof r !== 'object' || st.activeResumeLoading) return null;
    const uid = sess.resumeNumber || '';
    const found = looksResume(r) ? r : findResume(r, uid);
    if (!found || (uid && found.resumeNumber && found.resumeNumber !== uid)) return null;
    return { ...pick(found), resumeNumber: found.resumeNumber || uid };
  }
  let lastChatSig = '', resumeShapeSent = false;
  const profileCache = new Map(), activeSince = new Map(), postedProfile = new Set();
  // keys and value types of an object, a few levels deep (no values)
  const shapeOf = (o, d = 0) => {
    if (o == null || typeof o !== 'object') return typeof o;
    if (d > 2) return Array.isArray(o) ? 'array' : 'object';
    if (Array.isArray(o)) return o.length ? [shapeOf(o[0], d + 1)] : [];
    return Object.fromEntries(Object.keys(o).slice(0, 80).map(k => [k, shapeOf(o[k], d + 1)]));
  };
  function readChat() {
    const st = rootVm()?.$store?.state?.im;
    if (!st || !st.activeSessionId) return;
    const id = st.activeSessionId;
    if (!activeSince.has(id)) activeSince.set(id, Date.now());
    const sess = st.currentSession || sessionsOf(st).find(s => sessId(s) === id) || {};
    const tl = (st.timelineMap?.[id]?.timeline) || [];
    const msgs = toMsgs(tl, 30);
    const sig = id + ':' + (msgs.length ? msgs[msgs.length - 1].id : '');
    // the resume shows up after the messages: keep looking until found
    if (!profileCache.get(id)) { try { const p = activeResumeOf(st, sess) || resumeFor(sess); if (p) profileCache.set(id, p); } catch { /* try again next time */ } }
    const profile = profileCache.get(id) || null;
    // once per page load: report the field names / types (no values) of the first resume seen
    if (!resumeShapeSent && st.activeResume && typeof st.activeResume === 'object') {
      resumeShapeSent = true;
      post('resumeShape', { shape: shapeOf(st.activeResume), picked: profile ? { edu: profile.educationLevel ? 'yes' : 'no', edus: (profile.educationExperiences || []).map(e => ({ deg: !!e.educationLevel, begin: !!e.beginDate, end: !!e.endDate, mode: !!e.mode })), age: profile.age != null, work: (profile.workExperiences || []).length } : null });
    }
    // posted already, unless the resume has turned up since
    if (sig === lastChatSig && (!profile || postedProfile.has(id))) return;
    // give the resume up to 8 s, so the AI judges 合适 / 不合适 with it
    if (!profile && msgs.length && Date.now() - activeSince.get(id) < 8000) return;
    lastChatSig = sig;
    if (profile) postedProfile.add(id);
    post('chat', { sessionId: st.activeSessionId, uid: sess.resumeNumber || '', name: nameOf(sess), job: sess.jobTitle || '', state: sess.candidateState || '',
      origin: originOf(tl), profile, phones: phonesOf(sess, tl), messages: msgs });
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
  // unread count of a session: a key containing “unread” at the top level or one level down,
  // as a number or a numeric string
  const unreadOf = s => {
    const num = v => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? +v : null);
    for (const [k, v] of Object.entries(s || {})) {
      if (/un_?read/i.test(k) && num(v) != null) return num(v);
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) if (/un_?read/i.test(k2) && num(v2) != null) return num(v2);
    }
    return 0;
  };
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
    markVisited(st, sess);
    if (r.ok) return post('openResult', { reqId, ok: true, how: r.how, msg: `打开会话：${nameOf(sess)}（${r.how}）` });
    post('openResult', { reqId, ok: false, failed: true, id, msg: `打不开会话「${nameOf(sess)}」，已跳过（试过：${r.tried.join('、') || '没找到会话行'}）` });
  }
  // sessions whose row in the left list shows a red number badge (when the unread
  // count is not readable from the store)
  // rows in the left list that show a red number badge (unread), top to bottom
  // a small red element with just a number in it, in the left part of the page
  function isRedBadge(e) {
    if (!/^\d{1,3}\+?$/.test((e.innerText || '').trim())) return false;
    const r = e.getBoundingClientRect();
    if (!r.width || r.width > 40 || r.height > 30 || r.left > window.innerWidth * 0.45) return false;
    for (let el = e, k = 0; el && k < 3; el = el.parentElement, k++) {
      const m = getComputedStyle(el).backgroundColor.match(/\d+/g);
      if (m && +m[0] > 180 && +m[1] < 130 && +m[2] < 130 && (m[3] === undefined || +m[3] > 0)) return true;
    }
    return false;
  }
  function badgeRows() {
    const byClass = [...document.querySelectorAll('[class*="badge"], [class*="unread"], [class*="count"], [class*="num"], [class*="dot"], sup')]
      .filter(e => visible(e) && /^\d{1,3}\+?$/.test((e.innerText || '').trim()) && e.getBoundingClientRect().left < window.innerWidth * 0.45);
    // class names vary: also look for any small red number in the list area
    const byLook = [...document.querySelectorAll('span, div, i, em, sup, b')].filter(e => e.children.length === 0 && /^\d{1,3}\+?$/.test((e.textContent || '').trim()) && visible(e) && isRedBadge(e));
    const badges = [...new Set([...byClass, ...byLook])];
    const rows = [];
    for (const b of badges) {
      let row = b;
      // climb to the list row: the badge sits on the avatar, so go up until the element
      // also holds the name (Chinese text) and is about one entry tall
      for (let k = 0; k < 12 && row && (row.getBoundingClientRect().height < 50 || !/[一-龥]{2,}/.test(row.innerText || '')); k++) row = row.parentElement;
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
  // Sessions we already opened. The platform does not always clear the unread
  // mark, so a visited session is only opened again when something about its
  // last message changes (new message → new time / text / id).
  const visited = new Map();
  const sessLastSig = s => {
    const parts = [];
    for (const [k, v] of Object.entries(s || {})) {
      if (!/last|time|msg|message|update/i.test(k) || /unread/i.test(k)) continue;
      if (typeof v === 'string' || typeof v === 'number') parts.push(`${k}=${v}`);
      else if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) if (typeof v2 === 'string' || typeof v2 === 'number') parts.push(`${k}.${k2}=${String(v2).slice(0, 40)}`);
    }
    return parts.sort().join('|');
  };
  // when a conversation last moved (ms), from whichever time field the session has
  const sessTime = s => {
    for (const k of ['sortTime', 'communicateTime', 'lastActiveTime', 'updateTime', 'time']) {
      const v = s && s[k];
      if (v == null || v === '') continue;
      let n = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v).replace(' ', 'T'));
      if (n && n < 1e12) n *= 1000; // seconds
      if (n) return n;
    }
    return 0;
  };
  const markVisited = (st, s) => { if (s) visited.set(String(sessId(s)), { sig: sessLastSig(s), unread: unreadOf(s), at: Date.now() }); };
  const seenAlready = s => {
    const v = visited.get(String(sessId(s)));
    if (!v) return false;
    if (Date.now() - v.at < 60000) return true;               // just looked at it
    return v.sig === sessLastSig(s) && unreadOf(s) <= v.unread;    // nothing new since then
  };
  // next conversation with unread messages
  function nextUnread(reqId, skip) {
    const st = rootVm()?.$store?.state?.im;
    if (!st) return post('openResult', { reqId, ok: false, msg: '未读到聊天数据（页面还在加载？）' });
    if ((chatInput()?.value || '').trim()) return post('openResult', { reqId, ok: false, msg: '输入框有内容，暂不切换会话' });
    // the conversation open right now counts as visited
    const curS = sessionsOf(st).find(s => isActive(st, s)); if (curS) markVisited(st, curS);
    const usable = s => !isActive(st, s) && !(skip || []).includes(sessId(s)) && !seenAlready(s);
    let cand = sessionsOf(st).filter(s => usable(s) && unreadOf(s) > 0);
    if (!cand.length) cand = badgeSessions(st).filter(usable);
    if (cand.length) return openSession(sessId(cand[0]), reqId);
    // session list not readable: open the first red-badge row that is not the current one
    const cur = nameOf(st.currentSession || {});
    const fresh = r => { const v = visited.get(`row:${r.name}`); return !v || Date.now() - v.at > 180000; };
    const row = badgeRows().find(r => r.name && r.name !== cur && !(skip || []).includes(`row:${r.name}`) && fresh(r));
    if (row) { visited.set(`row:${row.name}`, { at: Date.now() }); return openRow(row, reqId); }
    // no unread left: look once (per page load, and again when something new arrives) at each
    // conversation active in the last 3 days — one that was read but never answered gets a reply
    const recent = sessionsOf(st).filter(s => usable(s) && !visited.has(String(sessId(s))) && Date.now() - sessTime(s) < 3 * 86400e3);
    if (recent.length) {
      const s = recent[0];
      return openSession(sessId(s), reqId).then(() => {}); // openResult carries the message
    }
    post('openResult', { reqId, ok: false, none: true, msg: '没有未读会话', sessions: sessionsOf(st).length,
      badges: badgeRows().filter(r => r.name !== cur).length, unread: sessionsOf(st).filter(s => unreadOf(s) > 0 && !isActive(st, s)).length });
  }

  // ---------- ask for the attachment resume via the platform's own button ----------
  async function askResume(reqId) {
    const st = rootVm()?.$store?.state?.im;
    const tlLen = () => ((st && st.timelineMap?.[st.activeSessionId]?.timeline) || []).length;
    const before = tlLen();
    if (!clickByText('要附件简历') && !clickByText('索要简历') && !clickByText('要简历')) return post('resumeResult', { reqId, ok: false, msg: '没找到「要附件简历」按钮' });
    for (let k = 0; k < 16; k++) {
      await wait(300);
      // a confirmation pop-up: press its confirm button
      const dlg = dialogs().find(d => /简历/.test(d.innerText || ''));
      const ok = dlg && [...dlg.querySelectorAll('button, .km-button')].find(b => visible(b) && /^(确定|确认|发送|立即索要|索要)$/.test((b.innerText || '').trim()));
      if (ok) { realClick(ok); await wait(800); }
      if (tlLen() > before) return post('resumeResult', { reqId, ok: true, msg: '已向对方索要附件简历' });
    }
    post('resumeResult', { reqId, ok: false, msg: '点了「要附件简历」，但没看到发出的请求，请你看一下页面' });
  }

  // ---------- follow-ups: open a given candidate's conversation, read our last message's state ----------
  async function openBy(reqId, { uid, name }) {
    const st = rootVm()?.$store?.state?.im;
    if (!st) return post('openResult', { reqId, ok: false, msg: '未读到聊天数据' });
    if ((chatInput()?.value || '').trim()) return post('openResult', { reqId, ok: false, msg: '输入框有内容，暂不切换会话' });
    const s = sessionsOf(st).find(x => (uid && x.resumeNumber === uid) || (name && nameOf(x) === name));
    if (!s) return post('openResult', { reqId, ok: false, msg: `会话列表里没找到「${name || uid}」（可能在列表较后面）` });
    const r = await activate(st, s);
    markVisited(st, s);
    post('openResult', r.ok ? { reqId, ok: true, msg: `打开会话：${nameOf(s)}` } : { reqId, ok: false, msg: `打不开会话「${nameOf(s)}」` });
  }
  // was our last message read? the message object's read flag, else the 已读 / 未读 label next to it
  function lastOutRead(tl) {
    const m = [...tl].reverse().find(x => x && x.flow === 'out');
    for (const [k, v] of Object.entries(m || {})) {
      if (!/read/i.test(k)) continue;
      if (v === true || v === 1 || v === 'read' || v === '已读') return true;
      if (v === false || v === 0 || v === 'unread' || v === '未读') return false;
    }
    const labels = [...document.querySelectorAll('span, div, i, em, p')]
      .filter(e => e.children.length === 0 && /^(已读|未读|送达)$/.test((e.textContent || '').trim()) && visible(e) && e.getBoundingClientRect().left > window.innerWidth * 0.3);
    if (!labels.length) return null;
    const bottom = labels.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
    return bottom.textContent.trim() === '已读';
  }
  function readState(reqId) {
    const st = rootVm()?.$store?.state?.im;
    const tl = (st && st.timelineMap?.[st.activeSessionId]?.timeline) || [];
    const msgs = toMsgs(tl, 30);
    post('readStateResult', { reqId, name: nameOf(st?.currentSession || {}), lastDir: msgs.length ? msgs[msgs.length - 1].dir : null, read: lastOutRead(tl), messages: msgs });
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
      if (msgs.length) out.push({ sessionId: id, uid: cur.resumeNumber || s.resumeNumber || '', name: nameOf(cur) || nameOf(s), job: cur.jobTitle || s.jobTitle || '', messages: msgs,
        phones: phonesOf(cur, (st.timelineMap?.[st.activeSessionId]?.timeline) || []) });
      post('historyProgress', { reqId, done: i + 1, total: list.length, name: nameOf(s) });
    }
    collecting = false;
    post('historyResult', { reqId, ok: true, sessions: out, skipped });
  }

  // ---------- interview invitation (平台「约面试」) ----------
  const dialogs = () => [...document.querySelectorAll('.km-modal, .km-dialog, [role="dialog"], .el-dialog, .km-drawer, [class*="modal"], [class*="dialog"], [class*="drawer"], [class*="popup"], [class*="layer"]')].filter(visible);
  // the invite form: a visible box that mentions 面试 and holds form fields; the innermost one wins
  const inviteDialog = () => {
    const c = dialogs().filter(d => /面试/.test(d.innerText || '') && d.querySelector('input, textarea, [class*="picker"], [class*="select"]'))
      .map(d => ({ d, a: d.getBoundingClientRect().width * d.getBoundingClientRect().height })).filter(x => x.a > 40000);
    return c.length ? c.sort((x, y) => x.a - y.a)[0].d : null;
  };
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
    if (!d) {
      // record what did show up, for tuning (class names and the first words only)
      const seen = dialogs().map(x => ({ cls: String(x.className).slice(0, 80), text: (x.innerText || '').replace(/\s+/g, ' ').slice(0, 60) })).slice(0, 8);
      return post('inviteResult', { reqId, ok: false, msg: '点了「约面试」，但没认出邀约窗口，请你手动发邀约（插件会记下窗口结构）', shape: { seen } });
    }
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
      // field names / types only (no values) of the open conversation's resume, to map 学历 etc.
      activeResume: shape(st && st.activeResume), activeResumePicked: (() => { const p = st && activeResumeOf(st, sess || {}); return p ? { edu: !!p.educationLevel, edus: (p.educationExperiences || []).map(e => ({ deg: !!e.educationLevel, begin: !!e.beginDate, end: !!e.endDate, mode: !!e.mode })), age: p.age != null, work: (p.workExperiences || []).length } : null; })(),
      imKeys: Object.keys(st || {}).slice(0, 60), sessionsFound: sessionsOf(st).length,
      unreadInStore: sessionsOf(st).filter(s => unreadOf(s) > 0).map(nameOf).slice(0, 10), badgeRows: badgeRows().map(r => r.name).slice(0, 10),
      sessionActions: Object.keys(rootVm()?.$store?._actions || {}).filter(a => /session/i.test(a)).slice(0, 40),
      sessionMutations: Object.keys(rootVm()?.$store?._mutations || {}).filter(a => /session/i.test(a)).slice(0, 40),
      unreadKeys: Object.keys(sessionsOf(st)[0] || {}).filter(k => /unread|read/i.test(k)),
      sessionRow: (() => { const s0 = sessionsOf(st)[0]; const el = s0 && sessionEl(s0); return el ? { tag: el.tagName, cls: String(el.className).slice(0, 80), vm: el.__vue__ ? vmName(el.__vue__) : '', methods: Object.keys(el.__vue__?.$options?.methods || {}).slice(0, 20) } : null; })(),
      quickButtons: [...document.querySelectorAll('button, .km-button')].filter(visible).map(b => (b.innerText || '').trim()).filter(t => t && t.length < 8).slice(0, 30),
      // recommend page: field names of a card's candidate object and the short labels on cards
      // (used to confirm how 智联 marks “a colleague already talked to this person”)
      rec: (() => {
        const els = [...document.querySelectorAll('.recommend-item__inner')].slice(0, 20);
        if (!els.length) return null;
        const c0 = cardVm(els[0])?.$props?.candidate || {};
        const labels = new Set();
        for (const el of els) for (const e of el.querySelectorAll('span, div, i, em, p')) {
          const t = (e.children.length ? '' : (e.textContent || '').trim());
          if (t && t.length <= 16 && /同事|沟通|联系|聊|招呼|查看|看过|浏览/.test(t)) labels.add(t);
        }
        // graduation fields of the first cards (short values only), to check the 毕业年份 rule
        const gradSample = els.slice(0, 8).map(el => { const c = cardVm(el)?.$props?.candidate || {}; return { desc: String(c.userGraduateDescription ?? '').slice(0, 20), school: c.isSchoolResume, graduates: typeof c.graduates === 'object' ? shape(c.graduates) : String(c.graduates ?? '').slice(0, 20), read: gradOf(c, el) }; });
        const jobs = (rootVm()?.$store?.state?.jobs?.jobList || []).map(j => j.jobTitle || j.jobName || j.title).slice(0, 12);
        return { job: currentJob(), jobs, urlJob: new URLSearchParams(location.search).get('jobNumber') ? 'yes' : 'no', gradSample, candKeys: Object.keys(c0).slice(0, 120), peerKeys: Object.fromEntries(Object.entries(c0).filter(([k]) => PEER_KEY.test(k)).map(([k, v]) => [k, typeof v === 'object' ? shape(v) : String(v).slice(0, 20)])),
          labels: [...labels].slice(0, 30), peerFound: els.filter(el => peerOf(cardVm(el)?.$props?.candidate, el)).length, cards: els.length };
      })(),
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
  // visible on screen. offsetParent alone is null for position:fixed elements
  // (dialogs, drawers), so check size and computed style instead.
  const visible = e => {
    if (!e || !e.getClientRects || !e.getClientRects().length) return false;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let el = e, k = 0; el && el.nodeType === 1 && k < 12; el = el.parentElement, k++) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    }
    return true;
  };
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
    if (d.type === 'openBy') openBy(d.reqId, d);
    if (d.type === 'askResume') askResume(d.reqId);
    if (d.type === 'resetVisited') visited.clear();
    if (d.type === 'readState') readState(d.reqId);
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
    // woken by the extension (timers in a background tab run only about once a minute)
    if (d.type === 'tick') tick();
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
