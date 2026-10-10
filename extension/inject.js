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
  // whitelist: no avatar, phone, ids beyond resumeNumber
  function pick(c) {
    return {
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
  let lastChatSig = '';
  function readChat() {
    const st = rootVm()?.$store?.state?.im;
    if (!st || !st.activeSessionId) return;
    const sess = st.currentSession || (st.sessions || []).find(s => s.sessionId === st.activeSessionId) || {};
    const tl = (st.timelineMap?.[st.activeSessionId]?.timeline) || [];
    const msgs = tl.filter(m => m.type === 'text' && m.text).slice(-30).map(m => ({ id: m.idServer || m.idClient, dir: m.flow === 'in' ? 'in' : 'out', text: m.text, at: m.time ? new Date(m.time).toISOString() : '' }));
    const sig = st.activeSessionId + ':' + (msgs.length ? msgs[msgs.length - 1].id : '');
    if (sig === lastChatSig) return;
    lastChatSig = sig;
    post('chat', { sessionId: st.activeSessionId, uid: sess.resumeNumber || '', name: sess.name || '', job: sess.jobTitle || '', state: sess.candidateState || '', messages: msgs });
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
  function clickNative(name) {
    const b = [...document.querySelectorAll('button, div, span')].find(e => e.offsetParent && e.children.length <= 2 && (e.innerText || '').trim() === name);
    if (!b) return post('actionResult', { ok: false, msg: `没找到“${name}”按钮` });
    b.click();
    post('actionResult', { ok: true, msg: `已点平台“${name}”，请在弹出的窗口里完成` });
  }
  function greet(uid) {
    const el = document.querySelector(`[data-hra-uid="${CSS.escape(uid)}"]`);
    const btn = el && (el.closest('.recommend-item')?.querySelector('.cv-test-recommend-chat button') || el.querySelector('.cv-test-recommend-chat button'));
    if (!btn) return post('greetResult', { uid, ok: false, msg: '没找到打招呼按钮' });
    if (/继续沟通|已沟通/.test(btn.innerText || '')) return post('greetResult', { uid, ok: true, msg: '已沟通过' });
    btn.click();
    post('greetResult', { uid, ok: true, msg: '已点打招呼' });
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
    if (d.type === 'reread') { lastSig = ''; lastChatSig = ''; tick(); }
  });

  let n = 0;
  function tick() {
    try {
      if (location.pathname.includes('/app/recommend')) readRecommend();
      if (location.pathname.includes('/app/im')) readChat();
      if (++n % 4 === 0 && riskSignal()) post('risk', {});
    } catch (e) { post('error', { msg: String(e && e.message || e) }); }
  }
  setInterval(tick, 1500);
  tick();
})();
