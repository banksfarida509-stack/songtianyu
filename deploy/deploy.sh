#!/usr/bin/env bash
# Deploy / update AI 招聘副驾 on this server.
#   bash deploy/deploy.sh            (run from the repo checkout)
# - copies the code to /opt/hr-agent (data/ and .env are kept)
# - creates /opt/hr-agent/.env on first run with a random admin password
# - (re)starts the pm2 process "hr-agent" on 127.0.0.1:3100
# - adds the /hr/ location to the existing nginx site if missing
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/hr-agent
NGINX_SITE=/etc/nginx/sites-available/xiyejia

mkdir -p "$APP/data"
for d in server web extension deploy docs; do
  rm -rf "$APP/$d"; cp -a "$SRC/$d" "$APP/$d"
done
cp -a "$SRC/README.md" "$APP/" 2>/dev/null || true

if [[ ! -f "$APP/.env" ]]; then
  PASS=$(openssl rand -base64 12 | tr -dc 'a-zA-Z0-9' | head -c 12)
  cat > "$APP/.env" <<EOF
HR_PORT=3100
HR_BASE=/hr
HR_DB=$APP/data/hr.db
HR_ADMIN_USER=admin
HR_ADMIN_PASS=$PASS
# AI：读取学员系统的租户凭据，经学员系统 AI 网关调用（费用记在租户余额）
HR_LLM_ENV_FILE=/opt/xiyejia-training/.env
# 如改用自有模型 Key，填写下面两项（OpenAI 兼容接口），会优先于网关：
# HR_LLM_DIRECT_URL=https://api.deepseek.com/v1/chat/completions
# HR_LLM_DIRECT_KEY=sk-...
EOF
  chmod 600 "$APP/.env"
  echo "admin password: $PASS" > /root/hr-agent-admin.txt; chmod 600 /root/hr-agent-admin.txt
  echo "==> created $APP/.env (admin password saved to /root/hr-agent-admin.txt)"
fi

cd "$APP"
if pm2 describe hr-agent >/dev/null 2>&1; then
  pm2 restart hr-agent --update-env >/dev/null
else
  pm2 start deploy/ecosystem.config.cjs >/dev/null
fi
pm2 save >/dev/null

if [[ -f "$NGINX_SITE" ]] && ! grep -q 'location ^~ /hr/' "$NGINX_SITE"; then
  cp "$NGINX_SITE" "/root/nginx-xiyejia.conf.bak.$(date +%Y%m%d%H%M%S)"
  python3 - "$NGINX_SITE" "$APP/deploy/nginx-hr.conf" <<'PY'
import sys
site, snip = sys.argv[1], open(sys.argv[2], encoding='utf-8').read()
s = open(site, encoding='utf-8').read()
s = s.replace('    location / {', snip.rstrip() + '\n\n    location / {', 1)
open(site, 'w', encoding='utf-8').write(s)
PY
  nginx -t && systemctl reload nginx
  echo "==> nginx: /hr/ added"
fi

for i in $(seq 1 20); do
  if curl -sf -o /dev/null http://127.0.0.1:3100/hr/api/health; then break; fi; sleep 1
done
curl -s http://127.0.0.1:3100/hr/api/health; echo
curl -s -o /dev/null -w "via nginx: %{http_code}\n" http://127.0.0.1/hr/
