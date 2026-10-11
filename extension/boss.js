// BOSS直聘 (zhipin.com) page adapter — runs in the page (MAIN world) and speaks the
// same message protocol as inject.js, so content.js works unchanged.
// The page structure has not been verified yet, so everything here is read from the
// DOM with generic rules (message rows, input box, send button, red badges) and a
// diagnostics report helps tune it. It makes no network requests.
(() => {
  if (window.__hraMain) return;
  window.__hraMain = true;
  const post = (type, data) => window.postMessage({ __hra: 'main', type, data }, location.origin);
  const wait = ms => new Promise(r => setTimeout(r, ms));
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
  const cls = e => String((e && e.className && e.className.baseVal !== undefined ? e.className.baseVal : e && e.className) || '');
  const textOf = e => (e && (e.innerText || e.textContent) || '').replace(/\s+\n/g, '\n').trim();
  function realClick(b) {
    const r = b.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    b.dispatchEvent(new PointerEvent('pointerdown', o)); b.dispatchEvent(new MouseEvent('mousedown', o));
    b.dispatchEvent(new PointerEvent('pointerup', o)); b.dispatchEvent(new MouseEvent('mouseup', o));
    b.click();
  }
  const isChat = () => /chat/.test(location.pathname);

  // ---------- conversation on screen ----------
  const ROW_RE = /item-(friend|myself)|message-item|msg-item|chat-message|message-card|im-message|chat-record|bubble/i;
  const OUT_RE = /myself|item-self|\bself\b|right|mine|is-me|send/i;
  const IN_RE = /friend|left|receive|other|is-other|geek/i;
  function messageRows() {
    const rows = [...document.querySelectorAll('div, li')].filter(e => ROW_RE.test(cls(e)) && visible(e));
    return rows.filter(r => !rows.some(o => o !== r && r.contains(o) && ROW_RE.test(cls(o)))); // innermost
  }
  function dirOf(row) {
    for (let e = row, k = 0; e && k < 4; e = e.parentElement, k++) {
      const c = cls(e);
      if (OUT_RE.test(c)) return 'out';
      if (IN_RE.test(c)) return 'in';
    }
    // fall back to the side of the screen the bubble sits on
    const r = row.getBoundingClientRect(), box = (row.closest('[class*="chat"]') || document.body).getBoundingClientRect();
    return r.left + r.width / 2 > box.left + box.width / 2 ? 'out' : 'in';
  }
  function bubbleText(row) {
    const t = row.querySelector('[class*="text"], [class*="content"], p');
    let s = textOf(t || row);
    if (!s) return '';
    if (row.querySelector('[class*="resume"], [class*="card"], [class*="file"]') && /简历|附件/.test(s)) s = `[卡片·附件简历] ${s}`;
    return s.slice(0, 500);
  }
  // current conversation: the highlighted row of the left list, else the chat header
  function currentName() {
    const sel = [...document.querySelectorAll('[class*="selected"], [class*="active"], [class*="current"]')]
      .find(e => visible(e) && e.getBoundingClientRect().left < window.innerWidth * 0.4 && /[一-龥]{2,}/.test(textOf(e)) && e.getBoundingClientRect().height < 140);
    const head = [...document.querySelectorAll('[class*="header"] [class*="name"], [class*="top-info"] [class*="name"], [class*="chat-title"]')].find(visible);
    const word = s => (s.split(/\s+/).find(w => /^[一-龥·]{2,8}$/.test(w)) || '');
    return word(textOf(head || sel || document.createElement('i')));
  }
  function currentJob() {
    const e = [...document.querySelectorAll('[class*="position"], [class*="job-name"], [class*="job"]')].find(x => visible(x) && /教师|老师|教/.test(textOf(x)) && textOf(x).length < 40);
    return e ? textOf(e).replace(/^沟通职位[:：]?/, '').trim() : '';
  }
  let lastSig = '';
  function readChat() {
    if (!isChat()) return;
    const rows = messageRows();
    const name = currentName();
    if (!rows.length || !name) return;
    // no message ids on screen: build one from position (from the start, so it stays stable as messages arrive) + text
    const msgs = rows.map(r => ({ dir: dirOf(r), text: bubbleText(r) })).filter(m => m.text)
      .map((m, i) => ({ ...m, id: `${name}#${i}#${m.dir}#${m.text.slice(0, 30)}` })).slice(-30);
    const sig = name + ':' + (msgs.length ? msgs[msgs.length - 1].id : '');
    if (sig === lastSig) return;
    lastSig = sig;
    const first = msgs[0];
    post('chat', { sessionId: `boss:${name}:${currentJob()}`, uid: '', name, job: currentJob(), state: '',
      origin: first ? (first.dir === 'in' ? 'applied' : 'greeted') : 'unknown', profile: null, messages: msgs });
  }

  // ---------- input / send ----------
  function chatInput() {
    const c = [...document.querySelectorAll('textarea, [contenteditable="true"], #boss-chat-editor-input, [class*="editor"] [contenteditable]')]
      .filter(e => visible(e) && e.getBoundingClientRect().top > window.innerHeight * 0.4);
    return c[c.length - 1] || null;
  }
  const inputText = el => el ? (el.tagName === 'TEXTAREA' ? el.value : el.innerText || '').trim() : '';
  function setInput(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const sel = window.getSelection(); const range = document.createRange();
      range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
  }
  function sendBtn() {
    return [...document.querySelectorAll('button, [class*="send"], [class*="btn"]')].find(e => visible(e) && /^发\s*送$/.test(textOf(e))) || null;
  }
  function fill(text) {
    const el = chatInput();
    if (!el) return post('actionResult', { ok: false, msg: '没找到聊天输入框（BOSS 适配中，请把诊断信息发给技术支持）' });
    setInput(el, text);
    post('actionResult', { ok: true, msg: '已填入输入框，请检查后点“发送”' });
  }
  async function sendText(text, reqId) {
    const el = chatInput();
    if (!el) return post('sendResult', { reqId, ok: false, msg: '没找到聊天输入框' });
    if (inputText(el)) return post('sendResult', { reqId, ok: false, msg: '输入框里有你正在写的内容，已跳过' });
    setInput(el, text);
    await wait(500 + Math.random() * 600);
    const b = sendBtn();
    if (b) realClick(b);
    else for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    for (let k = 0; k < 10; k++) { await wait(300); if (!inputText(el)) return post('sendResult', { reqId, ok: true, msg: '已发送' }); }
    post('sendResult', { reqId, ok: false, msg: '点了发送，但输入框没清空，请看一下页面' });
  }
  function clickByText(name) {
    const b = [...document.querySelectorAll('button, span, div, a')].filter(e => visible(e) && e.children.length <= 2 && textOf(e) === name);
    const t = b.find(e => e.tagName === 'BUTTON') || b[0];
    if (!t) return post('actionResult', { ok: false, msg: `没找到“${name}”按钮` });
    realClick(t); post('actionResult', { ok: true, msg: `已点“${name}”，请在弹出的窗口里完成` });
  }

  // ---------- unread conversations (red number badges in the left list) ----------
  function isRedBadge(e) {
    const r = e.getBoundingClientRect();
    if (!r.width || r.width > 40 || r.height > 30 || r.left > window.innerWidth * 0.45) return false;
    for (let el = e, k = 0; el && k < 3; el = el.parentElement, k++) {
      const m = getComputedStyle(el).backgroundColor.match(/\d+/g);
      if (m && +m[0] > 180 && +m[1] < 130 && +m[2] < 130 && (m[3] === undefined || +m[3] > 0)) return true;
    }
    return false;
  }
  function badgeRows() {
    const badges = [...document.querySelectorAll('span, div, i, em, sup, b')]
      .filter(e => e.children.length === 0 && /^\d{1,3}\+?$/.test((e.textContent || '').trim()) && visible(e) && (isRedBadge(e) || /badge|unread|notice|count/i.test(cls(e)) && e.getBoundingClientRect().left < window.innerWidth * 0.45));
    const rows = [];
    for (const b of badges) {
      let row = b;
      for (let k = 0; k < 12 && row && (row.getBoundingClientRect().height < 50 || !/[一-龥]{2,}/.test(textOf(row))); k++) row = row.parentElement;
      if (!row || row.getBoundingClientRect().height > 160) continue;
      const name = textOf(row).split(/\s+/).find(w => /^[一-龥·]{2,8}$/.test(w)) || '';
      if (name && !rows.some(r => r.name === name)) rows.push({ row, name, top: row.getBoundingClientRect().top });
    }
    return rows.sort((a, b) => a.top - b.top);
  }
  const visited = new Map();
  async function nextUnread(reqId, skip) {
    if (inputText(chatInput())) return post('openResult', { reqId, ok: false, msg: '输入框有内容，暂不切换会话' });
    const cur = currentName();
    const rows = badgeRows();
    const row = rows.find(r => r.name !== cur && !(skip || []).includes(`row:${r.name}`) && (!visited.has(r.name) || Date.now() - visited.get(r.name) > 120000));
    if (!row) return post('openResult', { reqId, ok: false, none: true, msg: '没有未读会话', sessions: '-', badges: rows.length });
    visited.set(row.name, Date.now());
    const targets = [row.row, ...[...row.row.querySelectorAll('*')].filter(e => e.children.length === 0 && textOf(e) === row.name)];
    for (const t of targets) {
      realClick(t);
      for (let k = 0; k < 8; k++) { await wait(250); if (currentName() === row.name) return post('openResult', { reqId, ok: true, how: '点未读行', msg: `打开会话：${row.name}` }); }
    }
    post('openResult', { reqId, ok: false, failed: true, id: `row:${row.name}`, msg: `打不开会话「${row.name}」，已跳过` });
  }

  // ---------- diagnostics (structure only: class names, counts, short labels) ----------
  function diagnose() {
    const top = (sel, n = 12) => [...document.querySelectorAll(sel)].filter(visible).slice(0, n).map(e => ({ tag: e.tagName, cls: cls(e).slice(0, 80) }));
    const rows = messageRows();
    const vue = !!(document.querySelector('#app') && (document.querySelector('#app').__vue__ || document.querySelector('#app').__vue_app__));
    return {
      url: location.pathname, title: document.title, frames: [...document.querySelectorAll('iframe')].map(f => (f.getAttribute('src') || '').split('?')[0]).slice(0, 8),
      vue, currentName: currentName(), currentJob: currentJob(),
      messageRows: rows.length, messageSample: rows.slice(-4).map(r => ({ cls: cls(r).slice(0, 80), dir: dirOf(r), text: bubbleText(r).slice(0, 12) })),
      messageLike: top('[class*="message"], [class*="msg"], [class*="item-"], [class*="bubble"]'),
      input: (() => { const e = chatInput(); return e ? { tag: e.tagName, cls: cls(e).slice(0, 80), id: e.id } : null; })(),
      sendBtn: (() => { const e = sendBtn(); return e ? { tag: e.tagName, cls: cls(e).slice(0, 80) } : null; })(),
      badgeRows: badgeRows().map(r => r.name).slice(0, 10),
      listLike: top('[class*="list"] [class*="item"], [class*="geek"], [class*="friend"]', 8),
      buttons: [...document.querySelectorAll('button, [class*="btn"]')].filter(visible).map(textOf).filter(t => t && t.length < 8).slice(0, 30),
    };
  }

  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.__hra !== 'iso' || e.source !== window) return;
    if (d.type === 'fill') fill(d.text);
    if (d.type === 'native') clickByText(d.name);
    if (d.type === 'send') sendText(String(d.text || ''), d.reqId);
    if (d.type === 'nextUnread') nextUnread(d.reqId, d.skip);
    if (d.type === 'diagnose') { let r; try { r = diagnose(); } catch (er) { r = { error: String(er && er.message || er) }; } post('diagResult', { reqId: d.reqId, ok: true, data: r }); }
    if (d.type === 'invite') post('inviteResult', { reqId: d.reqId, ok: false, msg: 'BOSS 直聘的自动发面试邀约还在适配中，请你手动点「约面试」' });
    if (d.type === 'history') post('historyResult', { reqId: d.reqId, ok: false, msg: 'BOSS 直聘的历史采集还在适配中' });
    if (d.type === 'reread') { lastSig = ''; readChat(); }
  });
  setInterval(() => { try { readChat(); } catch (er) { post('error', { msg: String(er && er.message || er) }); } }, 1500);
})();
