// pm2 process for the HR backend. Env vars come from /opt/hr-agent/.env.
const fs = require('fs');
const env = {};
try {
  for (const line of fs.readFileSync('/opt/hr-agent/.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
} catch {}
module.exports = {
  apps: [{
    name: 'hr-agent',
    script: 'server/src/server.js',
    cwd: '/opt/hr-agent',
    node_args: '--disable-warning=ExperimentalWarning',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '300M',
    env: { NODE_ENV: 'production', TZ: 'Asia/Shanghai', ...env },
  }],
};
