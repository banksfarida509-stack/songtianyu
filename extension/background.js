// Service worker: the only place that talks to the HR backend (keeps the token
// out of the page). Content scripts send {type:'api', path, body}.
importScripts('config.js');

async function conf() {
  const st = await chrome.storage.sync.get(['server', 'token']);
  return {
    server: (st.server || self.HR_CONFIG.server || '').replace(/\/+$/, ''),
    token: st.token || self.HR_CONFIG.token || '',
  };
}

// toolbar icon → settings & knowledge base
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// Version alignment. When the server ships a newer extension, reload the extension
// from disk once (picks up new files when it was loaded from the project folder),
// then refresh the recruiting tabs so the pages run the new scripts. If the version
// is still old afterwards (loaded from a downloaded copy), the panel asks the
// recruiter to download the new package instead.
const RECRUIT_TABS = ['https://rd6.zhaopin.com/*', 'https://www.zhipin.com/*', 'https://zhipin.com/*'];
async function selfUpdate(target) {
  const { reloadFor, reloadAt } = await chrome.storage.local.get(['reloadFor', 'reloadAt']);
  if (reloadFor === target && Date.now() - (reloadAt || 0) < 6 * 3600e3) return false; // tried already for this version
  await chrome.storage.local.set({ reloadFor: target, reloadAt: Date.now(), refreshTabs: true });
  setTimeout(() => chrome.runtime.reload(), 300);
  return true;
}
chrome.runtime.onInstalled.addListener(async () => {
  const { refreshTabs } = await chrome.storage.local.get('refreshTabs');
  if (!refreshTabs) return;
  await chrome.storage.local.set({ refreshTabs: false });
  for (const t of await chrome.tabs.query({ url: RECRUIT_TABS })) chrome.tabs.reload(t.id);
});

// Keep a 消息 page open for each platform in use: auto replies, the unread patrol and
// follow-ups only run on that page. Every minute: (re)open it as a pinned background tab
// if it is missing, stop Chrome from discarding it, and wake its patrol (timers in
// background tabs are throttled to about once a minute).
const IM_URL = { zhaopin: 'https://rd6.zhaopin.com/app/im', boss: 'https://www.zhipin.com/web/chat/index' };
const isImUrl = (p, u) => p === 'zhaopin' ? /^https:\/\/rd6\.zhaopin\.com\/app\/im/.test(u || '')
  : /^https:\/\/(www\.)?zhipin\.com\/web\/chat\//.test(u || '') && !/recommend/.test(u || '');
const SEEN_FOR = 3 * 3600e3; // a platform counts as "in use" when one of its pages pinged within 3 h
async function imTabs(p) {
  return (await chrome.tabs.query({ url: p === 'zhaopin' ? 'https://rd6.zhaopin.com/*' : ['https://www.zhipin.com/*', 'https://zhipin.com/*'] })).filter(t => isImUrl(p, t.url || t.pendingUrl));
}
let opening = false;
async function keepIm(focusPlatform) {
  if (opening) return;
  opening = true;
  try {
    const st = await chrome.storage.local.get(['keepIm', 'seen_zhaopin', 'seen_boss']);
    for (const p of ['zhaopin', 'boss']) {
      const want = p === focusPlatform || (st.keepIm && Date.now() - (st[`seen_${p}`] || 0) < SEEN_FOR);
      if (!want) continue;
      let tabs = await imTabs(p);
      if (!tabs.length) {
        const t = await chrome.tabs.create({ url: IM_URL[p], pinned: true, active: p === focusPlatform });
        tabs = [t];
      } else if (p === focusPlatform) {
        await chrome.tabs.update(tabs[0].id, { active: true });
        await chrome.windows.update(tabs[0].windowId, { focused: true });
      }
      for (const t of tabs) {
        chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
        chrome.tabs.sendMessage(t.id, { type: 'wake' }).catch(() => {});
      }
    }
  } catch (e) { console.warn('[hra] keepIm', e); } finally { opening = false; }
}
// create the alarm only once: re-creating it on every service-worker start would reset its
// timer, and the worker restarts more often than once a minute while pages are pinging
chrome.alarms.get('keepIm').then(a => { if (!a) chrome.alarms.create('keepIm', { periodInMinutes: 1 }); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'keepIm') keepIm(); });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // a recruiting page reports in (from its ping): remember the platform is in use and whether to keep its 消息 page
  if (msg?.type === 'seen') {
    const p = msg.platform === 'boss' ? 'boss' : 'zhaopin';
    chrome.storage.local.set({ [`seen_${p}`]: Date.now(), keepIm: !!msg.keepIm }).then(() => { if (msg.keepIm) keepIm(); });
    return;
  }
  if (msg?.type === 'openIm') { keepIm(msg.platform === 'boss' ? 'boss' : 'zhaopin'); return; }
  if (msg?.type === 'api') {
    (async () => {
      const c = await conf();
      if (!c.server || !c.token) return reply({ error: '插件未配置服务器地址或令牌：请在后台“设置”页重新下载插件，或在插件选项里填写。' });
      try {
        const method = msg.method || 'POST';
        const r = await fetch(`${c.server}/api${msg.path}`, {
          method,
          headers: { 'Content-Type': 'application/json', 'X-HR-Token': c.token },
          body: method === 'GET' ? undefined : JSON.stringify(msg.body || {}),
        });
        const data = await r.json().catch(() => ({}));
        reply(r.ok ? { data } : { error: data.error || `服务器返回 ${r.status}` });
      } catch (e) { reply({ error: '连不上服务器：' + e.message }); }
    })();
    return true; // async reply
  }
  if (msg?.type === 'openOptions') { chrome.runtime.openOptionsPage(); return; }
  if (msg?.type === 'selfUpdate') { selfUpdate(String(msg.target || '')).then(started => reply({ started })); return true; }
  if (msg?.type === 'conf') { conf().then(c => reply({ server: c.server, hasToken: !!c.token })); return true; }
});
