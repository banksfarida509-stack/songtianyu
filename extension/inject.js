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
      if (location.pathname.includes('/app/im')) readChat();
      if (++n % 4 === 0 && riskSignal()) post('risk', {});
    } catch (e) { post('error', { msg: String(e && e.message || e) }); }
  }
  setInterval(tick, 1500);
  tick();
})();
