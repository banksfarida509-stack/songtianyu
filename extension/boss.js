// BOSS直聘 (zhipin.com) page adapter — runs in the page (MAIN world) and speaks the
// same message protocol as inject.js, so content.js works unchanged.
// The page structure has not been verified yet, so everything here is read from the
// DOM with generic rules (message rows, input box, send button, red badges) and a
// diagnostics report helps tune it.
// Read only: it makes no network requests (no BOSS interfaces), never types into the
// page and never clicks anything. Sending, greeting, opening conversations, scrolling,
// asking for resumes and collecting history were removed.
(() => {
  if (window.__hraMain) return;
  window.__hraMain = true;
  const post = (type, data) => window.postMessage({ __hra: 'main', type, data }, location.origin);
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
      origin: first ? (first.dir === 'in' ? 'applied' : 'greeted') : 'unknown', profile: null, messages: msgs, phones: shownPhones() });
  }

  // ---------- input / send (located for diagnostics only; never written to or clicked) ----------
  function chatInput() {
    const c = [...document.querySelectorAll('textarea, [contenteditable="true"], #boss-chat-editor-input, [class*="editor"] [contenteditable]')]
      .filter(e => visible(e) && e.getBoundingClientRect().top > window.innerHeight * 0.4);
    return c[c.length - 1] || null;
  }
  function sendBtn() {
    return [...document.querySelectorAll('button, [class*="send"], [class*="btn"]')].find(e => visible(e) && /^发\s*送$/.test(textOf(e))) || null;
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
    // the card's own text, without the AI line we add (its reason text would read as an experience line)
    const ownLine = card.querySelector(':scope > .hra-line');
    const text = (ownLine ? textOf(card).replace(textOf(ownLine), '') : textOf(card)).replace(/同事聊过 · 最后打|AI (推荐|待确认|不推荐)/g, '');
    const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const out = { userName: '', age: null, educationLevel: '', workYearsLabel: '', careerStatus: '', intentText: '', workExperiences: [], educationExperiences: [] };
    if (d) {
      out.userName = strIn(d, /^(geekName|name|userName|realName)$/i);
      const ageS = strIn(d, /^age(Desc)?$/i); if (ageS) out.age = Number(ageS.match(/\d+/)?.[0]) || null;
      out.educationLevel = strIn(d, /degree(Name)?|edu(cation)?(Level|Name|Desc)?$/i);
      out.workYearsLabel = strIn(d, /work(Year|Years)(Desc)?$|experience(Desc)?$/i);
      out.intentText = [strIn(d, /expect(Position|Job)?(Name)?$|positionName$/i), strIn(d, /expectLocation|city/i)].filter(Boolean).join(' ');
      out.workExperiences = arrIn(d, /company|brand/i).slice(0, 6).map(w => ({ companyName: strIn(w, /company|brand/i), jobTitle: strIn(w, /position|title|job/i), beginDate: strIn(w, /start|begin/i), endDate: strIn(w, /end/i) }));
      out.educationExperiences = arrIn(d, /school/i).slice(0, 4).map(e => ({ schoolName: strIn(e, /school/i), majorName: strIn(e, /major/i), educationLevel: strIn(e, /degree|edu/i), mode: strIn(e, /type|mode|统招|tongzhao/i), beginDate: strIn(e, /start|begin/i), endDate: strIn(e, /end/i) }));
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
    // a colleague already talked to this person: the card data names them (mateName), or the card says so
    const peerTxt = text.match(/同事[^\n]{0,12}?(沟通|联系|聊过|打过招呼|招呼过|约面|邀约)[^\n]{0,6}/);
    const mate = d ? strIn(d, /^mateName$/i) : '';
    const peerChat = mate ? `同事${mate.slice(0, 12)}聊过` : peerTxt ? peerTxt[0].trim().slice(0, 30) : '';
    // graduation label on the card: “27届”, “2027年毕业”, “27年应届生”
    const gradText = (text.match(/(?<!\d)(?:20)?\d{2}\s*(?:届|年毕业|年应届)/) || [''])[0];
    return { resumeNumber: `boss-${String(uid).replace(/^(boss-)+/, '')}`, ...out, gradText, peerChat, fromVue: !!d };
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
    // the job is part of the signature: switching jobs re-screens the cards with that role
    const job = currentRecJob();
    const sig = job + '|' + cards.map(c => c.resumeNumber).join(',');
    if (cards.length && sig !== lastRecSig) { lastRecSig = sig; post('recommend', { cards, job }); }
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
      peer: { found: has(p => p.peerChat), sample: parsed.map(p => p.peerChat).filter(Boolean).slice(0, 5) },
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

  // read only: re-read the page or report its structure; every other request is refused
  const ALLOWED = new Set(['diagnose', 'reread']);
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.__hra !== 'iso' || e.source !== window) return;
    if (!ALLOWED.has(d.type)) return post('actionResult', { ok: false, msg: `不执行「${d.type}」：插件只做筛选和回复建议，平台上的操作请你自己完成` });
    if (d.type === 'diagnose') { let r; try { r = isRecPage() ? diagnoseRec() : diagnose(); } catch (er) { r = { error: String(er && er.message || er) }; } post('diagResult', { reqId: d.reqId, ok: true, data: r }); }
    if (d.type === 'reread') { lastSig = ''; lastRecSig = ''; isRecPage() ? readRecommend() : readChat(); }
  });
  setInterval(() => {
    try { if (isRecPage()) readRecommend(); else readChat(); } catch (er) { post('error', { msg: String(er && er.message || er) }); }
  }, 1500);
})();
