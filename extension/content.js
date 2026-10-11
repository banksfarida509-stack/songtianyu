// Isolated-world content script: talks to the backend (through background.js),
// draws the AI line under each recommend card and the copilot panel.
(() => {
  if (window.__hraIso) return;
  window.__hraIso = true;
  const VERSION = chrome.runtime.getManifest().version;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = (path, body) => new Promise(res => chrome.runtime.sendMessage({ type: 'api', path, body }, r => res(r || { error: chrome.runtime.lastError?.message || '插件后台无响应' })));
  const toMain = (type, data = {}) => window.postMessage({ __hra: 'iso', type, ...data }, location.origin);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const S = { results: {}, job: '', err: '', risk: false, greeting: false, stop: false, confirmGreet: false, target: 10, done: 0, phase: '', log: [], chat: null, draft: null, candidateId: null, busy: false, collapsed: false, lastSuggestSig: '' };
  const log = m => { S.log.unshift(`${new Date().toTimeString().slice(0, 8)} ${m}`); S.log = S.log.slice(0, 30); draw(); };

  // ---------- panel ----------
  const panel = document.createElement('div');
  panel.id = 'hra-panel';
  document.documentElement.appendChild(panel);
  const isRec = () => location.pathname.includes('/app/recommend');
  const isIm = () => location.pathname.includes('/app/im');

  function rank() {
    return Object.entries(S.results).map(([uid, r]) => ({ uid, ...r })).filter(r => r.verdict === '推荐').sort((a, b) => b.score - a.score);
  }
  function draw() {
    if (!isRec() && !isIm()) { panel.hidden = true; return; }
    panel.hidden = false;
    const head = `<div class="hra-head"><b>AI 招聘副驾</b><span>${isRec() ? '推荐页 · 初筛' : '聊天页 · 约聊'}</span><button class="hra-x" data-a="toggle">${S.collapsed ? '展开' : '收起'}</button></div>`;
    if (S.collapsed) { panel.innerHTML = head; bind(); return; }
    let body = '';
    if (S.err) body += `<div class="hra-err">${esc(S.err)}</div>`;
    if (S.risk) body += `<div class="hra-err">检测到平台风控提示（验证 / 操作频繁），已停止所有自动动作，请人工处理。</div>`;
    if (isRec()) {
      const all = Object.values(S.results);
      const n = v => all.filter(r => r.verdict === v).length;
      const rk = rank();
      body += `<div class="hra-stats"><div><b>${all.length}</b>已初筛</div><div><b>${n('推荐')}</b>推荐</div><div><b>${n('待确认')}</b>待确认</div><div><b>${n('不推荐')}</b>不推荐</div></div>`;
      body += `<div class="hra-sub">推荐顺序（${esc(S.job || '当前岗位')}）</div><div class="hra-rank">${rk.length ? rk.slice(0, 12).map(r => `<div class="hra-ri" data-uid="${esc(r.uid)}"><b>${r.score}</b><span>${esc(r.name || '')}<i>${esc(r.reason || '')}</i></span><em>${r.greeted ? '已打招呼' : ''}</em></div>`).join('') : '<p class="hra-muted">暂无推荐的人。滚动页面加载更多，插件会自动读取。</p>'}</div>`;
      body += S.greeting
        ? `<p class="hra-muted">正在打招呼：已完成 ${S.done} / ${S.target}${S.phase ? ' · ' + esc(S.phase) : ''}</p><button class="hra-btn" data-a="stop">停止打招呼</button>`
        : S.confirmGreet
          ? `<p class="hra-muted">按 AI 推荐顺序打招呼，当前页推荐 ${rk.filter(r => !r.greeted).length} 位未打招呼；不够时自动往下加载更多。每位间隔 15–30 秒，会消耗平台打招呼次数。</p>
             <div class="hra-row"><label class="hra-muted">本次打 <input id="hra-n" type="number" min="1" max="100" value="${S.target || 10}" style="width:56px"> 位</label></div>
             <div class="hra-row"><button class="hra-btn pri" data-a="greet-go">确认开始</button><button class="hra-btn" data-a="greet-cancel">取消</button></div>`
          : `<button class="hra-btn pri" data-a="greet" ${rk.some(r => !r.greeted) && !S.risk ? '' : 'disabled'}>按推荐顺序打招呼</button>`;
    }
    if (isIm()) {
      const c = S.chat;
      if (!c) body += '<p class="hra-muted">打开一个会话，插件会读取最新消息并生成回复建议。</p>';
      else {
        body += `<div class="hra-sub">${esc(c.name)} · ${esc(c.job || '')}</div>`;
        const d = S.draft;
        if (S.busy) body += '<p class="hra-muted">AI 正在生成回复建议…</p>';
        else if (!d) body += `<p class="hra-muted">${c.messages.length && c.messages[c.messages.length - 1].dir === 'in' ? '' : '等候选人回复。'}</p><button class="hra-btn" data-a="suggest">生成回复建议</button>`;
        else {
          const ck = (ok, t) => `<div class="hra-ck ${ok ? 'ok' : 'bad'}">${ok ? '通过' : '命中'} · ${esc(t)}</div>`;
          body += `<div class="hra-muted">意图：${esc(d.intent)}</div><div class="hra-draft ${d.blocked ? 'bad' : ''}">${esc(d.reply)}</div>
            ${ck(!d.checks.guard.length, '我方护栏' + (d.checks.guard.length ? '：' + d.checks.guard.join('、') : ''))}${ck(!d.checks.platform.length, '平台拦截规则' + (d.checks.platform.length ? '：' + d.checks.platform.join('、') : ''))}
            ${d.handoff ? `<div class="hra-err">转人工：${esc(d.handoffWhy || '')}</div>` : ''}
            ${d.action ? `<div class="hra-act">建议在平台点「${esc(d.action)}」${d.slot ? `：${esc(d.slot.date)} ${esc(d.slot.slot)}` : ''}</div>` : ''}
            <div class="hra-row">${d.blocked ? '' : '<button class="hra-btn pri" data-a="fill">填入输入框</button>'}${d.action ? `<button class="hra-btn" data-a="native">点「${esc(d.action)}」</button>` : ''}</div>
            <div class="hra-row"><button class="hra-btn" data-a="applied">我已发送</button><button class="hra-btn" data-a="suggest">重新生成</button></div>
            <p class="hra-muted">发送仍由你在平台点击“发送”完成；点“我已发送”后，约聊结果写入人才池。</p>`;
        }
      }
    }
    body += `<details class="hra-log"><summary>动作日志</summary>${S.log.map(l => `<div>${esc(l)}</div>`).join('') || '<div>无</div>'}</details>`;
    panel.innerHTML = head + `<div class="hra-body">${body}</div>`;
    bind();
  }
  function bind() {
    panel.querySelectorAll('[data-a]').forEach(b => b.onclick = () => act(b.dataset.a));
    const nIn = panel.querySelector('#hra-n');
    if (nIn) nIn.oninput = () => { S.target = parseInt(nIn.value, 10) || S.target; };
    panel.querySelectorAll('.hra-ri').forEach(el => el.onclick = () => {
      const card = document.querySelector(`[data-hra-uid="${CSS.escape(el.dataset.uid)}"]`);
      card && card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  async function act(a) {
    if (a === 'toggle') { S.collapsed = !S.collapsed; return draw(); }
    if (a === 'greet') { S.confirmGreet = true; return draw(); }
    if (a === 'greet-cancel') { S.confirmGreet = false; return draw(); }
    if (a === 'greet-go') {
      const n = parseInt(panel.querySelector('#hra-n')?.value, 10);
      S.target = Math.max(1, Math.min(100, n || 10));
      S.confirmGreet = false; return greetLoop();
    }
    if (a === 'stop') { S.stop = true; return; }
    if (a === 'suggest') return suggest(true);
    if (a === 'fill' && S.draft) { toMain('fill', { text: S.draft.reply }); return; }
    if (a === 'native' && S.draft?.action) { toMain('native', { name: S.draft.action }); return; }
    if (a === 'applied' && S.draft && S.candidateId) {
      const r = await api('/ext/chat/applied', { candidateId: S.candidateId, draft: S.draft });
      log(r.error ? '写入失败：' + r.error : `已写入人才池：${r.data.candidate.attend}`);
      S.draft = null; draw();
    }
  }

  // ---------- recommend: screen + AI reasons + inline lines ----------
  async function onCards(cards, job) {
    S.job = job || S.job;
    const fresh = cards.filter(c => !S.results[c.resumeNumber]);
    if (!fresh.length) return paintLines();
    const r = await api('/ext/screen', { platform: 'zhaopin', job: S.job, cards: fresh });
    if (r.error) { S.err = r.error; return draw(); }
    S.err = '';
    const names = Object.fromEntries(cards.map(c => [c.resumeNumber, c.userName]));
    for (const x of r.data.results) S.results[x.uid] = { ...x, name: names[x.uid] };
    log(`读取 ${fresh.length} 张卡片并初筛`);
    paintLines(); draw();
    const need = r.data.results.filter(x => x.reasonBy !== 'ai').map(x => x.uid);
    if (need.length) {
      const rr = await api('/ext/reasons', { platform: 'zhaopin', uids: need });
      if (rr.data?.reasons) { for (const [k, v] of Object.entries(rr.data.reasons)) if (S.results[k]) { S.results[k].reason = v; S.results[k].reasonBy = 'ai'; } paintLines(); draw(); }
    }
  }
  function paintLines() {
    for (const [uid, r] of Object.entries(S.results)) {
      const el = document.querySelector(`[data-hra-uid="${CSS.escape(uid)}"]`);
      if (!el) continue;
      let line = el.querySelector(':scope > .hra-line');
      if (!line) { line = document.createElement('div'); line.className = 'hra-line'; el.appendChild(line); }
      const cls = r.verdict === '推荐' ? 'ok' : r.verdict === '待确认' ? 'warn' : 'no';
      const html = `<span class="hra-tag ${cls}">AI ${esc(r.verdict)}</span>${r.verdict !== '不推荐' ? `<b>${r.score} 分</b>` : ''}<span class="hra-why">${esc(r.reason)}</span>${r.reasonBy === 'ai' ? '<span class="hra-src">AI</span>' : ''}${r.greeted ? '<span class="hra-tag no">已打招呼</span>' : ''}`;
      if (line.innerHTML !== html) line.innerHTML = html;
      el.classList.toggle('hra-v-ok', cls === 'ok'); el.classList.toggle('hra-v-warn', cls === 'warn'); el.classList.toggle('hra-v-no', cls === 'no');
    }
  }
  // Greets up to S.target recommended candidates; when the loaded list runs
  // out it asks the page to load more (up to 4 tries without new 推荐).
  async function greetLoop() {
    S.greeting = true; S.stop = false; S.done = 0; S.phase = ''; draw();
    const skip = new Set();
    let dry = 0, why = '', fails = 0;
    const onPage = uid => !!document.querySelector(`[data-hra-uid="${CSS.escape(uid)}"]`);
    while (S.done < S.target && !S.stop && !S.risk) {
      const r = rank().find(x => !x.greeted && !skip.has(x.uid) && onPage(x.uid));
      if (!r) {
        if (++dry > 4) { why = '当前岗位已没有更多 AI 推荐的候选人'; break; }
        S.phase = '加载更多候选人…'; draw();
        toMain('more');
        for (let t = 0; t < 6000 && !S.stop; t += 500) await sleep(500);
        continue;
      }
      dry = 0; S.phase = `正在给 ${r.name} 打招呼`; draw();
      document.querySelector(`[data-hra-uid="${CSS.escape(r.uid)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(1200);
      const res = await new Promise(ok => { const h = e => { if (e.data?.__hra === 'main' && e.data.type === 'greetResult' && e.data.data.uid === r.uid) { window.removeEventListener('message', h); ok(e.data.data); } }; window.addEventListener('message', h); toMain('greet', { uid: r.uid }); setTimeout(() => ok({ ok: false, msg: '超时' }), 12000); });
      log(`${r.name}：${res.msg}`);
      if (res.ok) { S.results[r.uid].greeted = true; if (!/已沟通过/.test(res.msg)) { S.done++; fails = 0; } paintLines(); draw(); }
      else skip.add(r.uid);
      if (res.dialog) { S.stop = true; why = '平台弹出窗口，需要人工处理（见上一条日志）'; break; }
      if (res.unverified && ++fails >= 3) { S.stop = true; why = '连续 3 位未确认成功，请看页面是否有提示'; break; }
      if (S.done >= S.target) break;
      // nothing was sent (already contacted / card gone): move on without the pause
      if (/已沟通过/.test(res.msg) || (!res.ok && !res.unverified)) continue;
      const wait = 15000 + Math.random() * 15000;
      S.phase = `等待 ${Math.round(wait / 1000)} 秒后继续`; draw();
      for (let t = 0; t < wait && !S.stop && !S.risk; t += 500) await sleep(500);
    }
    S.greeting = false; S.phase = '';
    log(S.risk ? '因平台风控提示停止' : why ? `停止：${why}（本次成功 ${S.done} 位）` : S.stop ? `已手动停止（本次成功 ${S.done} 位）` : `完成：本次成功打招呼 ${S.done} 位`);
    draw();
  }

  // ---------- chat: suggestion ----------
  async function suggest(force = false) {
    const c = S.chat;
    if (!c) return;
    const last = c.messages[c.messages.length - 1];
    const sig = c.sessionId + ':' + (last ? last.id : '');
    if (!force && (sig === S.lastSuggestSig || !last || last.dir !== 'in')) return draw();
    S.lastSuggestSig = sig; S.busy = true; S.draft = null; draw();
    const r = await api('/ext/chat/suggest', { platform: 'zhaopin', sessionId: c.sessionId, uid: c.uid, name: c.name, job: c.job, messages: c.messages });
    S.busy = false;
    if (r.error) { S.err = r.error; return draw(); }
    S.err = ''; S.draft = r.data.draft; S.candidateId = r.data.candidateId;
    log(`${c.name}：AI 建议（${r.data.draft.intent}）`);
    draw();
  }

  // ---------- messages from MAIN world ----------
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.__hra !== 'main' || e.source !== window) return;
    if (d.type === 'recommend') onCards(d.data.cards, d.data.job);
    if (d.type === 'chat') { const changed = !S.chat || S.chat.sessionId !== d.data.sessionId; S.chat = d.data; if (changed) S.draft = null; suggest(false); }
    if (d.type === 'actionResult') log(d.data.msg);
    if (d.type === 'risk' && !S.risk) { S.risk = true; S.stop = true; log('检测到平台风控提示，已停止'); draw(); }
    if (d.type === 'error') console.debug('[hra]', d.data.msg);
  });

  // keep lines alive when the page re-renders; heartbeat
  setInterval(() => { if (isRec()) paintLines(); }, 2000);
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; S.draft = null; S.chat = null; draw(); toMain('reread'); } }, 1000);
  const ping = () => api('/ext/ping', { page: location.pathname, version: VERSION }).then(r => { S.err = r.error || (S.err.startsWith('连不上') || S.err.startsWith('插件') ? '' : S.err); draw(); });
  ping(); setInterval(ping, 60000);
  draw();
})();
