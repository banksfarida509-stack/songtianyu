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

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
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
