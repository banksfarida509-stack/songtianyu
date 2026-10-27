// BOSS直聘 (zhipin.com) 只读读取器 —— 运行在插件自己的隔离环境（ISOLATED world），页面脚本看不到它。
// 只读页面上已经显示出来的文字：
//   - 不改 BOSS 自己元素的属性、样式；结论在每张卡片末尾单独一行（封闭 shadow DOM，和智联位置一致，可在侧边栏关掉），
//     回复建议只在 Chrome 侧边栏 sidepanel.html
//   - 不点击、不输入、不滚动、不打开会话
//   - 不发任何网络请求（不调用 BOSS 接口）；读到的内容交给插件后台，由后台连我们自己的服务器初筛
// 页面结构没有在真实 BOSS 页面上验证过，规则是通用写法；侧边栏「复制诊断信息」用于适配。
(() => {
  if (window.__hraBossReader) return;
  window.__hraBossReader = true;
  const send = (kind, data) => { try { chrome.runtime.sendMessage({ type: 'boss', kind, data, frame: window !== window.top, path: location.pathname }); } catch { /* extension reloaded */ } };
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
  const hash = s => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36);
  const isRecPage = () => /recommend|search/.test(location.pathname);
  const isChat = () => /chat/.test(location.pathname) && !isRecPage();

  // ---------- 名字 ----------
  const UI_WORDS = new Set(['沟通', '全部', '新招呼', '未读', '已读', '在线', '消息', '职位', '聊天', '牛人', '推荐', '搜索', '互动', '设置', '我的', '工具', '道具',
    '仅沟通', '有交换', '有面试', '收藏', '更多', '筛选', '批量', '标记', '置顶', '不合适', '刚刚', '昨天', '今天', '星期', '附件简历', '在线简历', '沟通职位', '发送', '招聘',
    '打招呼', '立即沟通', '继续沟通', '工作经历', '教育经历', '项目经验', '个人优势', '期望职位', '求职意向', '活跃', '刚刚活跃', '本月活跃', '今日活跃']);
  const nameIn = s => String(s || '').split(/[\s|·•,，:：()（）]+/).find(w => /^[一-龥]{2,6}$/.test(w) && !UI_WORDS.has(w) && !/老师$|教师$|先生$|女士$|活跃$|经历$/.test(w) || /^[一-龥](先生|女士)$/.test(w)) || '';
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

  // ---------- 简历文字 → 后台初筛用的字段 ----------
  const EDU_RE = /博士|硕士|研究生|本科|大专|专科|中专|中技|高中|初中/;
  function parseText(text, idHint) {
    const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const out = { userName: '', age: null, educationLevel: '', workYearsLabel: '', careerStatus: '', intentText: '', workExperiences: [], educationExperiences: [] };
    out.userName = nameIn(lines.slice(0, 4).join(' '));
    const age = text.match(/(\d{2})岁/); if (age) out.age = +age[1];
    out.educationLevel = (text.match(EDU_RE) || [''])[0];
    out.workYearsLabel = (text.match(/\d{1,2}年以上|\d{1,2}年(?!\d)|应届生?|在校生?/) || [''])[0];
    out.careerStatus = (text.match(/(离职|在职)[^\s|·]{0,8}/) || [''])[0];
    out.intentText = lines.filter(l => /期望|求职|意向/.test(l)).join(' ').slice(0, 120);
    for (const l of lines) {
      const parts = l.split(/\s*[·•|｜]\s*/).filter(Boolean);
      if (parts.length < 2 || /岁/.test(l)) continue;
      const isEdu = EDU_RE.test(l) && /大学|学院|学校|职业|师范|中学|学堂/.test(parts[0]);
      if (isEdu) { if (out.educationExperiences.length < 4) out.educationExperiences.push({ schoolName: parts[0], majorName: parts.find((x, i) => i > 0 && !EDU_RE.test(x) && !/统招|全日制|自考|成人|函授|网络/.test(x)) || '', educationLevel: (l.match(EDU_RE) || [''])[0], schoolTag: (l.match(/985|211|双一流/g) || []).join(' '), mode: (l.match(/非统招|统招|全日制|自考|成人|函授|网络/) || [''])[0] }); }
      else if (out.workExperiences.length < 6 && !/期望|求职|意向/.test(l)) out.workExperiences.push({ companyName: parts[0], jobTitle: parts[1].replace(/\d{4}.*$/, '').trim() });
    }
    if (out.educationExperiences.length && !out.educationExperiences[0].educationLevel) out.educationExperiences[0].educationLevel = out.educationLevel;
    const peer = text.match(/同事[^\n]{0,12}?(沟通|联系|聊过|打过招呼|招呼过|约面|邀约)[^\n]{0,6}/);
    const gradText = (text.match(/(?<!\d)(?:20)?\d{2}\s*(?:届|年毕业|年应届)/) || [''])[0];
    const uid = idHint || 'h' + hash(`${out.userName}|${out.age}|${out.educationLevel}|${out.workExperiences[0]?.companyName || ''}|${out.educationExperiences[0]?.schoolName || ''}`);
    return { resumeNumber: `boss-${String(uid).replace(/^(boss-)+/, '')}`, ...out, gradText, peerChat: peer ? peer[0].trim().slice(0, 30) : '' };
  }
  // 卡片自己带的候选人 id（只读属性 / 链接参数）
  function idOf(card) {
    for (const el of [card, ...card.querySelectorAll('[data-geekid], [data-uid], [data-id], [data-lid], [data-securityid], [data-expect], a[href]')]) {
      for (const a of el.attributes || []) if (/geek|uid|lid|security|encrypt|expect/i.test(a.name) && a.value.length > 4) return a.value;
      if (el.tagName === 'A') { const m = (el.getAttribute('href') || '').match(/(?:geek|uid|id)=([\w-]{6,})/i); if (m) return m[1]; }
    }
    return '';
  }

  // ---------- 推荐牛人 / 搜索列表：卡片 ----------
  const GREET_TXT = /^(打招呼|立即沟通|继续沟通|已沟通|沟通)$/;
  function greetButtons(root = document) {
    return [...root.querySelectorAll('button, a, span, div')].filter(e => e.children.length <= 2 && GREET_TXT.test(textOf(e)) && visible(e))
      .filter((e, i, all) => !all.some(o => o !== e && e.contains(o)));
  }
  function cardOf(btn) {
    for (let e = btn, k = 0; e && e.parentElement && k < 14; e = e.parentElement, k++) {
      const sibs = [...e.parentElement.children].filter(x => x !== e && x.tagName === e.tagName);
      if (sibs.length && sibs.some(x => greetButtons(x).length) && e.getBoundingClientRect().height > 60) return e;
    }
    return null;
  }
  // ---------- 打开的简历详情（弹窗 / 侧滑 / 新页面） ----------
  function resumeBox() {
    const all = [...document.querySelectorAll('div, section, article')].filter(e => {
      const t = e.innerText || '';
      if (!/工作经历|工作经验/.test(t) || !/教育经历/.test(t)) return false;
      const r = e.getBoundingClientRect();
      return r.width > 300 && r.height > 300 && visible(e);
    });
    // 最里层那个同时包含「工作经历」和「教育经历」的容器
    return all.find(e => !all.some(o => o !== e && e.contains(o))) || null;
  }
  function readResume() {
    const box = resumeBox();
    if (!box) return null;
    const text = textOf(box);
    const c = parseText(text, idOf(box));
    if (!c.age && !c.educationLevel && !c.workExperiences.length) return null;
    return c;
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

  // ---------- 聊天页：当前会话 ----------
  const ROW_RE = /item-(friend|myself)|message-item|msg-item|chat-message|message-card|im-message|chat-record|bubble/i;
  const OUT_RE = /myself|item-self|\bself\b|right|mine|is-me|send/i;
  const IN_RE = /friend|left|receive|other|is-other|geek/i;
  function messageRows() {
    const rows = [...document.querySelectorAll('div, li')].filter(e => ROW_RE.test(cls(e)) && visible(e));
    return rows.filter(r => !rows.some(o => o !== r && r.contains(o) && ROW_RE.test(cls(o))));
  }
  function dirOf(row) {
    for (let e = row, k = 0; e && k < 4; e = e.parentElement, k++) {
      const c = cls(e);
      if (OUT_RE.test(c)) return 'out';
      if (IN_RE.test(c)) return 'in';
    }
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
  function listRows() {
    const groups = new Map();
    for (const e of document.querySelectorAll('li, div')) {
      const r = e.getBoundingClientRect();
      if (r.left > window.innerWidth * 0.45 || r.height < 40 || r.height > 160 || r.width < 150 || !e.parentElement) continue;
      if (!groups.has(e.parentElement)) groups.set(e.parentElement, []);
      groups.get(e.parentElement).push(e);
    }
    let best = [];
    for (const kids of groups.values()) {
      const named = kids.filter(k => visible(k) && rowName(k));
      if (named.length >= 2 && named.length > best.length) best = named;
    }
    return best.map(row => ({ row, name: rowName(row) })).filter(x => x.name);
  }
  function currentName() {
    const head = [...document.querySelectorAll('[class*="top-info"] [class*="name"], [class*="chat-title"] [class*="name"], [class*="conversation"] [class*="header"] [class*="name"], [class*="base-info"] [class*="name"], [class*="geek-info"] [class*="name"]')]
      .find(e => visible(e) && e.getBoundingClientRect().left > window.innerWidth * 0.3 && nameIn(textOf(e)));
    if (head) return nameIn(textOf(head));
    const sel = listRows().find(x => /selected|active|current|cur\b|checked/i.test(cls(x.row)) || [...x.row.querySelectorAll('*')].some(c => /selected|active|current/i.test(cls(c))));
    return sel ? sel.name : '';
  }
  function currentJob() {
    const e = [...document.querySelectorAll('[class*="position"], [class*="job-name"], [class*="job"]')].find(x => visible(x) && textOf(x).length < 40 && /师|员|顾问|主管|经理|专员|助理/.test(textOf(x)));
    return e ? textOf(e).replace(/^沟通职位[:：]?/, '').trim() : '';
  }
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
  function readChat() {
    const rows = messageRows(), name = currentName();
    if (!rows.length || !name) return null;
    const job = currentJob();
    const msgs = rows.map(r => ({ dir: dirOf(r), text: bubbleText(r) })).filter(m => m.text)
      .map((m, i) => ({ ...m, id: `${name}#${i}#${m.dir}#${m.text.slice(0, 30)}` })).slice(-30);
    const first = msgs[0];
    const resume = readResume();
    return { sessionId: `boss:${name}:${job}`, uid: '', name, job, state: '', origin: first ? (first.dir === 'in' ? 'applied' : 'greeted') : 'unknown',
      profile: resume ? { ...resume, userName: resume.userName || name } : null, messages: msgs, phones: shownPhones() };
  }

  // ---------- 诊断（只有结构：类名、数量、短标签） ----------
  function diagnose() {
    const top = (sel, n = 12) => [...document.querySelectorAll(sel)].filter(visible).slice(0, n).map(e => ({ tag: e.tagName, cls: cls(e).slice(0, 80) }));
    const btns = greetButtons(), cards = btns.map(cardOf).filter(Boolean);
    const parsed = cards.slice(0, 20).map(c => { try { return parseText(textOf(c), idOf(c)); } catch { return null; } }).filter(Boolean);
    const has = f => parsed.filter(f).length;
    const shape = el => el ? { tag: el.tagName, cls: cls(el).slice(0, 60), kids: [...el.children].slice(0, 8).map(k => `${k.tagName}.${cls(k).split(' ')[0]}`) } : null;
    const rb = resumeBox(), rows = messageRows();
    return {
      url: location.pathname, frame: window !== window.top, title: document.title,
      frames: [...document.querySelectorAll('iframe')].map(f => (f.getAttribute('src') || '').split('?')[0]).slice(0, 8),
      rec: { greetButtons: btns.length, cards: cards.length, job: currentRecJob(), cardShape: shape(cards[0]), parentShape: shape(cards[0]?.parentElement),
        parsed: { n: parsed.length, name: has(p => p.userName), age: has(p => p.age), edu: has(p => p.educationLevel), work: has(p => p.workExperiences.length), school: has(p => p.educationExperiences.length), idHashed: has(p => /^boss-h/.test(p.resumeNumber)) } },
      resume: rb ? { shape: shape(rb), parsed: (() => { const r = readResume(); return r ? { name: !!r.userName, age: r.age, edu: r.educationLevel, work: r.workExperiences.length, school: r.educationExperiences.length } : null; })() } : null,
      chat: { currentName: currentName(), currentJob: currentJob(), messageRows: rows.length, messageSample: rows.slice(-4).map(r => ({ cls: cls(r).slice(0, 80), dir: dirOf(r), text: bubbleText(r).slice(0, 12) })),
        messageLike: top('[class*="message"], [class*="msg"], [class*="item-"], [class*="bubble"]'), listRows: listRows().slice(0, 8).map(x => ({ name: x.name, cls: cls(x.row).slice(0, 60) })) },
      buttons: [...document.querySelectorAll('button, [class*="btn"]')].filter(visible).map(textOf).filter(t => t && t.length < 8).slice(0, 30),
    };
  }

  // ---------- 初筛：读到的卡片 / 简历交给后台（经插件后台转发，不是 BOSS 接口） ----------
  const api = (path, body) => new Promise(res => { try { chrome.runtime.sendMessage({ type: 'api', path, body }, r => res(r || { error: chrome.runtime.lastError?.message || '插件后台无响应' })); } catch { res({ error: '插件已重新加载，请刷新页面' }); } });
  const roleKey = job => `roleSel_boss_${job || ''}`;
  const results = {};           // uid → { verdict, score, reason, reasonBy, name }
  let screenJob = null, pending = new Set();
  async function screen(cards, job) {
    if (job !== screenJob) { screenJob = job; for (const k in results) delete results[k]; }
    const fresh = cards.filter(c => !results[c.resumeNumber] && !pending.has(c.resumeNumber));
    if (!fresh.length) return;
    fresh.forEach(c => pending.add(c.resumeNumber));
    let role; try { role = (await chrome.storage.local.get(roleKey(job)))[roleKey(job)] || undefined; } catch { role = undefined; }
    const r = await api('/ext/screen', { platform: 'boss', job, role, cards: fresh });
    fresh.forEach(c => pending.delete(c.resumeNumber));
    if (r.error) return send('screenError', { msg: r.error });
    const names = Object.fromEntries(fresh.map(c => [c.resumeNumber, c.userName]));
    for (const x of r.data.results) results[x.uid] = { ...x, name: names[x.uid] };
    send('screened', { job, results: r.data.results.map(x => results[x.uid]), role: r.data.role, roles: r.data.roles });
    paint();
    const need = r.data.results.filter(x => x.reasonBy !== 'ai').map(x => x.uid);
    if (!need.length) return;
    const rr = await api('/ext/reasons', { platform: 'boss', uids: need });
    for (const [k, v] of Object.entries(rr.data?.reasons || {})) if (results[k]) Object.assign(results[k], { reason: v, reasonBy: 'ai' });
    for (const [k, v] of Object.entries(rr.data?.verdicts || {})) if (results[k]) Object.assign(results[k], { verdict: v.verdict, score: v.score, reason: v.reason, reasonBy: 'ai' });
    send('screened', { job, results: need.map(k => results[k]).filter(Boolean) });
    paint();
  }

  // ---------- 网页上的结论标签 ----------
  // 和智联一样：每张卡片（和打开的简历）最下面单独一行结论，不盖住页面上的任何内容。
  // 这一行是插在卡片末尾的一个无类名 div，内容在封闭 shadow DOM 里（页面脚本读不到文字，样式互不影响），
  // 不接收鼠标（点它等于点卡片）。不改 BOSS 自己元素的属性和样式。侧边栏里可以关掉（关掉即全部移除）。
  let marksOn = true, onScreen = [];   // onScreen: [{ el, uid }]
  const lines = new Map();             // 卡片元素 → { host, box, html }
  try { chrome.storage.local.get('bossMarks').then(v => { marksOn = v.bossMarks !== false; paint(); }); } catch { /* default on */ }
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.bossMarks) { marksOn = ch.bossMarks.newValue !== false; paint(); } });
  const CSS = `
    :host{all:initial;display:block;box-sizing:border-box;width:100%;pointer-events:none}
    .l{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px;padding:8px 0 2px;border-top:1px dashed #E1E5EC;
       font:13.5px/1.5 "PingFang SC","Microsoft YaHei",sans-serif;color:#41464F}
    .t{padding:2px 12px;line-height:24px;border-radius:6px;font-size:16px;font-weight:700;letter-spacing:.5px;color:#fff;white-space:nowrap}
    .ok{background:#0E8A5F} .warn{background:#E08A00} .no{background:#8A9099}
    .s{font:700 24px/28px "DIN Alternate","Bahnschrift",sans-serif;color:#D0161F;white-space:nowrap} .s small{font-size:13px;font-weight:600;margin-left:2px}
    .w{font-size:12.5px;min-width:0;flex:1}
    .src{font-size:10.5px;background:#FFF6DA;color:#9A6A00;border-radius:4px;padding:0 5px}
    [data-v]::before{content:attr(data-v)}`;
  // 文字都用 CSS 生成内容显示：卡片的 innerText 里不会多出结论文字，不影响下一轮读卡片/算 id
  const HOST_CSS = 'display:block;width:100%;flex:0 0 100%;order:999;grid-column:1/-1;box-sizing:border-box;pointer-events:none;margin:0;padding:0;border:0;float:none;position:static';
  const vcls = v => v === '推荐' ? 'ok' : v === '待确认' ? 'warn' : 'no';
  const escH = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function lineFor(el) {
    let L = lines.get(el);
    if (!L) {
      const host = document.createElement('div');
      host.style.cssText = HOST_CSS;
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>${CSS}</style><div class="l"></div>`;
      L = { host, box: root.lastElementChild, html: '' };
      lines.set(el, L);
    }
    // 页面重新渲染时可能把它挤掉或在后面加了东西 → 放回最后
    if (el.lastElementChild !== L.host) el.appendChild(L.host);
    return L;
  }
  let raf = 0;
  function paint() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const items = marksOn ? onScreen.filter(x => results[x.uid]?.verdict && x.el.isConnected) : [];
      const keep = new Set(items.map(x => x.el));
      for (const [el, L] of lines) if (!keep.has(el)) { L.host.remove(); lines.delete(el); }
      for (const { el, uid } of items) {
        const x = results[uid], L = lineFor(el);
        const html = `<span class="t ${vcls(x.verdict)}" data-v="AI ${escH(x.verdict)}"></span>${x.verdict !== '不推荐' && x.score != null ? `<span class="s" data-v="${escH(x.score)}"><small data-v="分"></small></span>` : ''}<span class="w" data-v="${escH(x.reason || '')}"></span>${x.reasonBy === 'ai' ? '<span class="src" data-v="AI"></span>' : ''}`;
        if (L.html !== html) { L.box.innerHTML = html; L.html = html; }
      }
    });
  }

  // ---------- 定时读取：只在标签页可见时；内容没变就不重复上报 ----------
  let lastRec = '', lastResume = '', lastChat = '';
  function tick(force) {
    if (document.hidden) return;
    if (force) { lastRec = lastResume = lastChat = ''; screenJob = null; for (const k in results) delete results[k]; }
    try {
      const seen = [];
      if (isRecPage()) {
        const job = currentRecJob(), cards = [];
        for (const b of greetButtons()) {
          const card = cardOf(b);
          if (!card) continue;
          let c; try { c = parseText(textOf(card), idOf(card)); } catch { continue; }
          if (!c.age && !c.educationLevel && !c.workExperiences.length) continue;
          seen.push({ el: card, uid: c.resumeNumber });
          if (!cards.some(x => x.resumeNumber === c.resumeNumber)) cards.push(c);
        }
        const sig = job + '|' + cards.map(c => c.resumeNumber).join(',');
        if (cards.length && sig !== lastRec) { lastRec = sig; send('recommend', { cards, job }); screen(cards, job); }
      }
      if (!isChat()) {
        const box = resumeBox(), r = box && readResume();
        if (r) seen.push({ el: box, uid: r.resumeNumber });
        const sig = r ? r.resumeNumber : '';
        if (sig !== lastResume) { lastResume = sig; send('resume', { card: r, job: currentRecJob() }); if (r) screen([r], screenJob ?? currentRecJob()); }
      } else {
        const c = readChat();
        const sig = c ? `${c.sessionId}:${c.messages.length ? c.messages[c.messages.length - 1].id : ''}:${c.profile ? 1 : 0}` : '';
        if (c && sig !== lastChat) { lastChat = sig; send('chat', c); }
      }
      onScreen = seen;
      paint();
    } catch (e) { console.debug('[hra]', e && e.message); }
  }
  // 侧边栏发来的请求：重新读取 / 诊断 / 要一份当前结果（都只读）
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'bossReread') { tick(true); return; }
    if (msg?.type === 'bossSync') { lastResume = lastChat = ''; const all = Object.values(results).filter(x => x.verdict); if (all.length) send('screened', { job: screenJob || '', results: all }); return; }
    if (msg?.type === 'bossDiagnose') { let r; try { r = diagnose(); } catch (e) { r = { error: String(e && e.message || e) }; } send('diag', r); }
  });
  setInterval(() => tick(false), 2000);
  tick(false);
})();
