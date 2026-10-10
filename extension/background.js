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

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'api') {
    (async () => {
      const c = await conf();
      if (!c.server || !c.token) return reply({ error: '插件未配置服务器地址或令牌：请在后台“设置”页重新下载插件，或在插件选项里填写。' });
      try {
        const r = await fetch(`${c.server}/api${msg.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-HR-Token': c.token },
          body: JSON.stringify(msg.body || {}),
        });
        const data = await r.json().catch(() => ({}));
        reply(r.ok ? { data } : { error: data.error || `服务器返回 ${r.status}` });
      } catch (e) { reply({ error: '连不上服务器：' + e.message }); }
    })();
    return true; // async reply
  }
  if (msg?.type === 'conf') { conf().then(c => reply({ server: c.server, hasToken: !!c.token })); return true; }
});
