// Service worker：唯一和后台服务器通信的地方（令牌不进页面）。content.js 发 {type:'api', path, body}。
// v1.0 去掉了：自动打开并固定消息页、每 30 秒唤醒页面巡检、自动更新后刷新招聘页面。
importScripts('config.js');

async function conf() {
  const st = await chrome.storage.sync.get(['server', 'token']);
  return {
    server: (st.server || self.HR_CONFIG.server || '').replace(/\/+$/, ''),
    token: st.token || self.HR_CONFIG.token || '',
  };
}

// 工具栏图标 → 打开侧边栏（BOSS直聘的结论和建议显示在侧边栏；侧边栏右上角「设置」进设置与知识库）
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
// Chrome 不允许插件自己弹出侧边栏：快捷键 Alt+J 打开（按键算作用户操作）
chrome.commands?.onCommand.addListener((cmd, tab) => {
  if (cmd === 'open-panel' && tab) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});
// BOSS 页面读到了内容：图标亮「AI」角标，提示点图标打开侧边栏（只改插件自己的图标，不碰页面）
const badged = new Set();
function badge(tabId) {
  if (badged.has(tabId)) return;
  badged.add(tabId);
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#0E8A5F' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: 'AI' }).catch(() => {});
}
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading') badged.delete(tabId); });
chrome.tabs.onRemoved.addListener(tabId => badged.delete(tabId));

// 旧版留下的定时器（keepIm）在升级后清掉
chrome.runtime.onInstalled.addListener(() => { chrome.alarms?.clearAll?.(); });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'boss' && sender.tab) { badge(sender.tab.id); return; }
  if (msg?.type === 'api') {
    (async () => {
      const c = await conf();
      if (!c.server || !c.token) return reply({ error: '插件未配置服务器地址或令牌：请在插件选项里填写。' });
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
    return true; // 异步回复
  }
  if (msg?.type === 'openOptions') { chrome.runtime.openOptionsPage(); return; }
  if (msg?.type === 'conf') { conf().then(c => reply({ server: c.server, hasToken: !!c.token })); return true; }
});
