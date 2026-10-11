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
  const isChat = () => /chat/.test(location.pathname) && !/recommend/.test(location.pathname);

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
  // words on the page that are menu / tab labels, never a candidate's name
  const UI_WORDS = new Set(['沟通', '全部', '新招呼', '未读', '已读', '在线', '消息', '职位', '聊天', '牛人', '推荐', '搜索', '互动', '设置', '我的', '工具', '道具',
    '仅沟通', '有交换', '有面试', '收藏', '更多', '筛选', '批量', '标记', '置顶', '不合适', '刚刚', '昨天', '今天', '星期', '附件简历', '在线简历', '沟通职位', '发送', '招聘']);
  const nameIn = s => String(s || '').split(/[\s|·•,，:：()（）]+/).find(w => /^[一-龥]{2,6}$/.test(w) && !UI_WORDS.has(w) && !/老师$|教师$|先生$|女士$/.test(w) || /^[一-龥](先生|女士)$/.test(w)) || '';
  // the name shown in a row. Name and job title sit in separate elements but their text
  // runs together (“付丽莉行政教务老师”), so look at the smallest text elements first.
  function rowName(row) {
    if (!row) return '';
    const byClass = row.querySelector('[class*="name"]:not([class*="job"]):not([class*="position"])');
    if (byClass) { const t = textOf(byClass), n = nameIn(t); if (n && t.startsWith(n)) return n; }
    for (const leaf of row.querySelectorAll('span, div, p, b, em, i, strong')) {
      if (leaf.children.length) continue;
      const t = textOf(leaf), n = nameIn(t);
      if (n && n === t) return n;
    }
    return nameIn(textOf(row));
  }
  // the conversation list on the left: the largest group of same-class siblings that hold a name
  function listRows() {
    const groups = new Map();
    for (const e of document.querySelectorAll('li, div')) {
      const r = e.getBoundingClientRect();
      if (r.left > window.innerWidth * 0.45 || r.height < 40 || r.height > 160 || r.width < 150 || !e.parentElement) continue;
      const key = e.parentElement;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    let best = [];
    for (const kids of groups.values()) {
      const named = kids.filter(k => visible(k) && rowName(k));
      if (named.length >= 2 && named.length > best.length) best = named;
    }
    return best.map(row => ({ row, name: rowName(row), top: row.getBoundingClientRect().top })).filter(x => x.name);
  }
  // current conversation: the chat header's name, else the highlighted row of the left list
  function currentName() {
    const head = [...document.querySelectorAll('[class*="top-info"] [class*="name"], [class*="chat-title"] [class*="name"], [class*="conversation"] [class*="header"] [class*="name"], [class*="base-info"] [class*="name"], [class*="geek-info"] [class*="name"]')]
      .find(e => visible(e) && e.getBoundingClientRect().left > window.innerWidth * 0.3 && nameIn(textOf(e)));
    if (head) return nameIn(textOf(head));
    const sel = listRows().find(x => /selected|active|current|cur\b|checked/i.test(cls(x.row)) || [...x.row.querySelectorAll('*')].some(c => /selected|active|current/i.test(cls(c))));
    return sel ? sel.name : '';
  }
  function currentJob() {
    const e = [...document.querySelectorAll('[class*="position"], [class*="job-name"], [class*="job"]')].find(x => visible(x) && /教师|老师|教/.test(textOf(x)) && textOf(x).length < 40);
    return e ? textOf(e).replace(/^沟通职位[:：]?/, '').trim() : '';
  }
  // a number the page shows for this candidate after exchanging phones (“手机号：13…”), in the conversation area
  function shownPhones() {
    const out = new Set();
    for (const e of document.querySelectorAll('span, div, p, em, b')) {
      if (e.children.length > 3) continue;
      const t = (e.textContent || '').replace(/[\s-]/g, '');
      if (t.length > 60 || !/手机|电话/.test(t)) continue;
      const m = t.match(/(?<!\d)1[3-9]\d{9}(?!\d)/);
      if (m && visible(e) && e.getBoundingClientRect().left > window.innerWidth * 0.3) out.add(m[0]);
    }
    return [...out].slice(0, 2);
  }
  let lastSig = '';
  function readChat() {
    if (!isChat() || collecting) return;
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
      origin: first ? (first.dir === 'in' ? 'applied' : 'greeted') : 'unknown', profile: null, messages: msgs, phones: shownPhones() });
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
  const redBg = el => { const m = getComputedStyle(el).backgroundColor.match(/\d+/g); return !!(m && +m[0] > 180 && +m[1] < 130 && +m[2] < 130 && (m[3] === undefined || +m[3] > 0)); };
  // a list row is unread when it holds a red number badge, a badge-class number, or a small red dot
  function rowUnread(row) {
    for (const e of row.querySelectorAll('*')) {
      if (!visible(e)) continue;
      const t = (e.textContent || '').trim(), r = e.getBoundingClientRect();
      if (e.children.length === 0 && /^\d{1,3}\+?$/.test(t) && r.width <= 40 && (isRedBadge(e) || /badge|unread|notice|count|num/i.test(cls(e)))) return true;
      if (!t && r.width >= 4 && r.width <= 14 && Math.abs(r.width - r.height) <= 2 && redBg(e)) return true;
    }
    return false;
  }
  function badgeRows() {
    const fromList = listRows().filter(x => rowUnread(x.row));
    if (fromList.length) return fromList.sort((a, b) => a.top - b.top);
    const badges = [...document.querySelectorAll('span, div, i, em, sup, b')]
      .filter(e => e.children.length === 0 && /^\d{1,3}\+?$/.test((e.textContent || '').trim()) && visible(e) && (isRedBadge(e) || /badge|unread|notice|count/i.test(cls(e)) && e.getBoundingClientRect().left < window.innerWidth * 0.45));
    const rows = [];
    for (const b of badges) {
      let row = b;
      for (let k = 0; k < 12 && row && (row.getBoundingClientRect().height < 50 || !/[一-龥]{2,}/.test(textOf(row))); k++) row = row.parentElement;
      if (!row || row.getBoundingClientRect().height > 160) continue;
      const name = rowName(row);
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

  // ---------- past conversations (read only: opens each, never types or sends) ----------
  // conversations with unread messages are skipped so they are not marked as read
  let collecting = false;
  function readMessages(name) {
    return messageRows().map(r => ({ dir: dirOf(r), text: bubbleText(r) })).filter(m => m.text)
      .map((m, i) => ({ ...m, id: `${name}#${i}#${m.dir}#${m.text.slice(0, 30)}` })).slice(-200);
  }
  async function collectHistory(reqId, max) {
    if (collecting) return post('historyResult', { reqId, ok: false, msg: '正在采集中' });
    const all = listRows();
    if (!all.length) return post('historyResult', { reqId, ok: false, msg: '没认出左侧的会话列表（请把诊断信息发给技术支持）' });
    collecting = true;
    const list = all.filter(x => !rowUnread(x.row)).slice(0, max || 30);
    const out = []; let skipped = all.length - list.length;
    for (let i = 0; i < list.length && collecting; i++) {
      const { name } = list[i];
      // the row element may have been re-rendered: look it up again by name
      const row = (listRows().find(x => x.name === name) || list[i]).row;
      if (currentName() !== name) {
        realClick(row);
        let ok = false;
        for (let k = 0; k < 14 && !ok; k++) { await wait(300); ok = currentName() === name; }
        if (!ok) { const nm = [...row.querySelectorAll('*')].find(e => e.children.length === 0 && textOf(e) === name); if (nm) { realClick(nm); for (let k = 0; k < 10 && !ok; k++) { await wait(300); ok = currentName() === name; } } }
        if (!ok) { skipped++; continue; }
        await wait(800 + Math.random() * 800); // let the messages render
      }
      const messages = readMessages(name);
      if (messages.length) out.push({ sessionId: `boss:${name}:${currentJob()}`, uid: '', name, job: currentJob(), messages });
      post('historyProgress', { reqId, done: i + 1, total: list.length, name });
    }
    collecting = false;
    post('historyResult', { reqId, ok: true, sessions: out, skipped });
  }

  // ---------- follow-ups ----------
  async function openBy(reqId, { name }) {
    if (inputText(chatInput())) return post('openResult', { reqId, ok: false, msg: '输入框有内容，暂不切换会话' });
    if (currentName() === name) return post('openResult', { reqId, ok: true, msg: `已在会话：${name}` });
    const x = listRows().find(r => r.name === name);
    if (!x) return post('openResult', { reqId, ok: false, msg: `会话列表里没找到「${name}」（可能在列表较后面）` });
    const targets = [x.row, ...[...x.row.querySelectorAll('*')].filter(e => e.children.length === 0 && textOf(e) === name)];
    for (const t of targets) {
      realClick(t);
      for (let k = 0; k < 8; k++) { await wait(250); if (currentName() === name) return post('openResult', { reqId, ok: true, msg: `打开会话：${name}` }); }
    }
    post('openResult', { reqId, ok: false, msg: `打不开会话「${name}」` });
  }
  function readState(reqId) {
    const name = currentName();
    const msgs = name ? readMessages(name).slice(-30) : [];
    const labels = [...document.querySelectorAll('span, div, i, em, p')]
      .filter(e => e.children.length === 0 && /^\[?(已读|未读|送达)\]?$/.test((e.textContent || '').trim()) && visible(e) && e.getBoundingClientRect().left > window.innerWidth * 0.3);
    const bottom = labels.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
    post('readStateResult', { reqId, name, lastDir: msgs.length ? msgs[msgs.length - 1].dir : null, read: bottom ? /已读/.test(bottom.textContent) : null, messages: msgs });
  }

  // ---------- 推荐牛人 (recommend page; usually inside an iframe /web/frame/recommend/) ----------
  const isRecPage = () => /recommend/.test(location.pathname);
  const GREET_TXT = /^(打招呼|立即沟通|继续沟通|已沟通|沟通)$/;
  function greetButtons(root = document) {
    return [...root.querySelectorAll('button, a, span, div')].filter(e => e.children.length <= 2 && GREET_TXT.test(textOf(e)) && visible(e))
      .filter((e, i, all) => !all.some(o => o !== e && e.contains(o))); // innermost
  }
  // the card around a greet button: the ancestor whose siblings are other cards
  function cardOf(btn) {
    for (let e = btn, k = 0; e && e.parentElement && k < 14; e = e.parentElement, k++) {
      const sibs = [...e.parentElement.children].filter(x => x !== e && x.tagName === e.tagName);
      if (sibs.length && sibs.some(x => greetButtons(x).length) && e.getBoundingClientRect().height > 60) return e;
    }
    return null;
  }
  // structured data held by the card's own component, if any (field names vary, so match by shape)
  function vueData(card) {
    for (let el = card, k = 0; el && k < 3; el = el.firstElementChild, k++) {
      const vm = el.__vue__ || (el.__vueParentComponent && el.__vueParentComponent.props && { $props: el.__vueParentComponent.props });
      if (!vm) continue;
      for (const o of [vm.$props, vm.$data]) for (const v of Object.values(o || {})) if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 5) return v;
    }
    return null;
  }
  const strIn = (o, re) => { for (const [k, v] of Object.entries(o || {})) if (re.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v)) return String(v); return ''; };
  const arrIn = (o, itemRe) => { for (const v of Object.values(o || {})) if (Array.isArray(v) && v.length && typeof v[0] === 'object' && Object.keys(v[0]).some(k => itemRe.test(k))) return v; return []; };
  const EDU_RE = /博士|硕士|研究生|本科|大专|专科|中专|中技|高中|初中/;
  function parseCard(card) {
    const d = vueData(card);
    const text = textOf(card);
    const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const out = { userName: '', age: null, educationLevel: '', workYearsLabel: '', careerStatus: '', intentText: '', workExperiences: [], educationExperiences: [] };
    if (d) {
      out.userName = strIn(d, /^(geekName|name|userName|realName)$/i);
      const ageS = strIn(d, /^age(Desc)?$/i); if (ageS) out.age = Number(ageS.match(/\d+/)?.[0]) || null;
      out.educationLevel = strIn(d, /degree(Name)?|edu(cation)?(Level|Name|Desc)?$/i);
      out.workYearsLabel = strIn(d, /work(Year|Years)(Desc)?$|experience(Desc)?$/i);
      out.intentText = [strIn(d, /expect(Position|Job)?(Name)?$|positionName$/i), strIn(d, /expectLocation|city/i)].filter(Boolean).join(' ');
      out.workExperiences = arrIn(d, /company|brand/i).slice(0, 6).map(w => ({ companyName: strIn(w, /company|brand/i), jobTitle: strIn(w, /position|title|job/i), beginDate: strIn(w, /start|begin/i), endDate: strIn(w, /end/i) }));
      out.educationExperiences = arrIn(d, /school/i).slice(0, 4).map(e => ({ schoolName: strIn(e, /school/i), majorName: strIn(e, /major/i), educationLevel: strIn(e, /degree|edu/i), mode: strIn(e, /type|mode|统招|tongzhao/i) }));
    }
    // fill gaps from the card text: “25岁 | 3年 | 本科 | 离职-随时到岗”, “公司 · 职位”, “学校 · 专业 · 学历”
    if (!out.userName) out.userName = nameIn(lines.slice(0, 3).join(' '));
    if (out.age == null) { const m = text.match(/(\d{2})岁/); if (m) out.age = +m[1]; }
    if (!out.educationLevel) out.educationLevel = (text.match(EDU_RE) || [''])[0];
    if (!out.workYearsLabel) out.workYearsLabel = (text.match(/\d{1,2}年以上|\d{1,2}年(?!\d)|应届生?|在校生?/) || [''])[0];
    out.careerStatus = (text.match(/(离职|在职)[^\s|·]{0,8}/) || [''])[0];
    if (!out.intentText) out.intentText = lines.filter(l => /期望|求职|意向/.test(l)).join(' ').slice(0, 120);
    if (!out.workExperiences.length || !out.educationExperiences.length) {
      const fromVueWork = out.workExperiences.length, fromVueEdu = out.educationExperiences.length;
      if (fromVueWork && !fromVueEdu) out.workExperiences = []; // re-read both from text so they stay consistent
      if (fromVueEdu && !fromVueWork) out.educationExperiences = [];
      for (const l of lines) {
        const parts = l.split(/\s*[·•|｜]\s*/).filter(Boolean);
        if (parts.length < 2 || /岁/.test(l)) continue;
        // an education line names a degree (大专 / 本科 …); training schools as employers do not
        const isEdu = EDU_RE.test(l) && /大学|学院|学校|职业|师范|中学|学堂/.test(parts[0]);
        if (isEdu) { if (out.educationExperiences.length < 4) out.educationExperiences.push({ schoolName: parts[0], majorName: parts.find((x, i) => i > 0 && !EDU_RE.test(x) && !/统招|全日制|自考|成人|函授|网络/.test(x)) || '', educationLevel: (l.match(EDU_RE) || [''])[0], mode: (l.match(/非统招|统招|全日制|自考|成人|函授|网络/) || [''])[0] }); }
        else if (out.workExperiences.length < 6 && !/期望|求职|意向/.test(l)) out.workExperiences.push({ companyName: parts[0], jobTitle: parts[1].replace(/\d{4}.*$/, '').trim() });
      }
    }
    if (out.educationExperiences.length && !out.educationExperiences[0].educationLevel) out.educationExperiences[0].educationLevel = out.educationLevel;
    // an id for the candidate: a geek / uid attribute, a link parameter, the component's id field, or a hash of the card
    let uid = '';
    for (const el of [card, ...card.querySelectorAll('[data-geekid], [data-uid], [data-id], [data-lid], [data-securityid], a[href]')]) {
      // skip our own data-hra-* marks (reading them back made a new id every pass)
      for (const a of el.attributes || []) if (!/^data-hra/i.test(a.name) && /geek|uid|lid|security|encrypt/i.test(a.name) && a.value.length > 4) { uid = a.value; break; }
      if (!uid && el.tagName === 'A') { const m = (el.getAttribute('href') || '').match(/(?:geek|uid|id)=([\w-]{6,})/i); if (m) uid = m[1]; }
      if (uid) break;
    }
    if (!uid && d) uid = strIn(d, /^(encryptGeekId|geekId|securityId|uid|encryptUid|expectId|lid)$/i);
    if (!uid) uid = 'h' + [...`${out.userName}|${out.age}|${out.educationLevel}|${out.workExperiences[0]?.companyName || ''}|${out.educationExperiences[0]?.schoolName || ''}`].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36);
    return { resumeNumber: `boss-${String(uid).replace(/^(boss-)+/, '')}`, ...out, fromVue: !!d };
  }
  function currentRecJob() {
    const docs = [document]; try { if (window.top !== window && window.top.document) docs.push(window.top.document); } catch { /* cross-origin */ }
    for (const doc of docs) {
      const e = [...doc.querySelectorAll('[class*="job"] [class*="label"], [class*="job-select"], [class*="jobSelect"], [class*="dropmenu-label"], [class*="job-name"], [class*="position-name"]')]
        .find(x => visible(x) && textOf(x).length >= 2 && textOf(x).length <= 40 && !/推荐|搜索|全部/.test(textOf(x)));
      if (e) return textOf(e).split('\n')[0].trim();
    }
    return '';
  }
  let lastRecSig = '';
  function readRecommend() {
    const cards = [];
    for (const b of greetButtons()) {
      const card = cardOf(b);
      if (!card || card.hasAttribute('data-hra-skip')) continue;
      let c = null;
      try { c = parseCard(card); } catch { continue; }
      if (!c.age && !c.educationLevel && !c.workExperiences.length) continue;
      card.setAttribute('data-hra-uid', c.resumeNumber);
      if (!cards.some(x => x.resumeNumber === c.resumeNumber)) cards.push(c);
    }
    const sig = cards.map(c => c.resumeNumber).join(',');
    if (sig && sig !== lastRecSig) { lastRecSig = sig; post('recommend', { cards, job: currentRecJob() }); }
  }
  async function greetRec(uid) {
    const card = document.querySelector(`[data-hra-uid="${CSS.escape(uid)}"]`);
    if (!card) return post('greetResult', { uid, ok: false, msg: '卡片已不在页面上（翻页或刷新了）' });
    card.scrollIntoView({ block: 'center' }); await wait(500);
    const btn = greetButtons(card)[0];
    if (!btn) return post('greetResult', { uid, ok: false, msg: '没找到打招呼按钮' });
    if (/继续沟通|已沟通/.test(textOf(btn))) return post('greetResult', { uid, ok: true, msg: '已沟通过' });
    realClick(btn);
    for (let k = 0; k < 20; k++) {
      await wait(500);
      const b2 = greetButtons(card)[0];
      if (!document.contains(card) || !b2 || /继续沟通|已沟通/.test(textOf(b2))) return post('greetResult', { uid, ok: true, msg: `打招呼成功${b2 ? `（按钮变为「${textOf(b2)}」）` : ''}` });
      const tip = [...document.querySelectorAll('[class*="toast"], [class*="message"], [class*="tip"], [class*="dialog"], [class*="modal"]')].find(e => visible(e) && /已发送|成功|已向/.test(textOf(e)));
      if (tip) return post('greetResult', { uid, ok: true, msg: '打招呼成功（平台提示已发送）' });
      const dlg = [...document.querySelectorAll('[class*="dialog"], [class*="modal"], [class*="popup"]')].find(e => visible(e) && e.getBoundingClientRect().width > 200 && /招呼|沟通|次数|权益|购买|充值/.test(textOf(e)));
      if (dlg) return post('greetResult', { uid, ok: false, dialog: true, msg: `点了打招呼，平台弹出窗口：「${textOf(dlg).replace(/\s+/g, ' ').slice(0, 60)}」——请手动处理，已暂停` });
    }
    post('greetResult', { uid, ok: false, unverified: true, msg: '点了打招呼，10 秒内没看到变化，未确认成功' });
  }
  function moreRec() {
    const cards = greetButtons().map(cardOf).filter(Boolean);
    if (cards.length) cards[cards.length - 1].scrollIntoView({ block: 'end' });
    window.scrollBy(0, 2000);
    for (const e of document.querySelectorAll('div, ul, section')) if (e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight;
  }
  function diagnoseRec() {
    const btns = greetButtons(), cards = btns.map(cardOf).filter(Boolean);
    const parsed = cards.slice(0, 20).map(c => { try { return parseCard(c); } catch { return null; } }).filter(Boolean);
    const has = f => parsed.filter(f).length;
    const shape = el => el ? { tag: el.tagName, cls: cls(el).slice(0, 60), kids: [...el.children].slice(0, 8).map(k => `${k.tagName}.${cls(k).split(' ')[0]}`) } : null;
    return {
      url: location.pathname, frame: window !== window.top, greetButtons: btns.length, cards: cards.length, job: currentRecJob(),
      cardShape: shape(cards[0]), parentShape: shape(cards[0]?.parentElement),
      parsed: { n: parsed.length, name: has(p => p.userName), age: has(p => p.age), edu: has(p => p.educationLevel), work: has(p => p.workExperiences.length), school: has(p => p.educationExperiences.length), intent: has(p => p.intentText), fromVue: has(p => p.fromVue), uidHashed: has(p => /^boss-h/.test(p.resumeNumber)) },
      vueKeys: (() => { const d = cards[0] && vueData(cards[0]); return d ? Object.keys(d).slice(0, 40) : []; })(),
    };
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
      listRows: listRows().slice(0, 8).map(x => ({ name: x.name, cls: cls(x.row).slice(0, 60), unread: rowUnread(x.row) })),
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
    if (d.type === 'diagnose') { let r; try { r = isRecPage() ? diagnoseRec() : diagnose(); } catch (er) { r = { error: String(er && er.message || er) }; } post('diagResult', { reqId: d.reqId, ok: true, data: r }); }
    if (d.type === 'greet') greetRec(d.uid);
    if (d.type === 'more') moreRec();
    if (d.type === 'resetVisited') visited.clear();
    if (d.type === 'invite') post('inviteResult', { reqId: d.reqId, ok: false, msg: 'BOSS 直聘的自动发面试邀约还在适配中，请你手动点「约面试」' });
    if (d.type === 'history') collectHistory(d.reqId, d.max);
    if (d.type === 'openBy') openBy(d.reqId, d);
    if (d.type === 'readState') readState(d.reqId);
    if (d.type === 'historyStop') collecting = false;
    if (d.type === 'reread') { lastSig = ''; lastRecSig = ''; isRecPage() ? readRecommend() : readChat(); }
  });
  setInterval(() => {
    try { if (isRecPage()) readRecommend(); else readChat(); } catch (er) { post('error', { msg: String(er && er.message || er) }); }
  }, 1500);
})();
