#!/usr/bin/env bash
# Fix: the SNI router on 443 stops reaching the electrum shim after the shim
# container restarts.
#
# Why: nginx resolves `upstream electrum_backend { server electrum:50002; }`
# ONCE at startup. When the electrum container is recreated it gets a new Docker
# IP, and nginx keeps dialling the dead address — TCP connections hang instead of
# failing, so the wallet spins forever (e.g. never reaches the confirm screen).
#
# Fix: drop the static upstreams and proxy_pass a variable, with Docker's
# embedded DNS as the stream-level resolver. Variable targets are resolved per
# connection, so a restarted container is picked up within `valid=10s`.
#
# Run as root on the box:
#   bash /opt/txc-mempool/infra/txc-stack/nginx/fix-sni-resolver.sh

set -euo pipefail

STACK=/opt/txc-stack
CONF="$STACK/nginx/nginx.conf"
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$CONF" ] || { echo "ERROR: $CONF not found"; exit 1; }
grep -q 'ssl_preread' "$CONF" || { echo "ERROR: no stream/ssl_preread block found — run apply-sni-443.sh first"; exit 1; }

cp "$CONF" "$CONF.bak-$STAMP"
echo "Backup: $CONF.bak-$STAMP"

python3 - "$CONF" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path).read()
i = src.rindex('stream {')
new_stream = '''stream {
    # Docker's embedded DNS. Required: proxy_pass with a variable is resolved
    # per connection, so a recreated electrum container is picked up in ~10s.
    resolver 127.0.0.11 valid=10s ipv6=off;

    map $ssl_preread_server_name $txc_upstream {
        ~^electrum   electrum:50002;
        default      127.0.0.1:8443;
    }

    server {
        listen 443;
        listen [::]:443;
        ssl_preread on;
        proxy_pass $txc_upstream;
        proxy_timeout 10m;
        proxy_connect_timeout 5s;
    }
}
'''
open(path, 'w').write(src[:i] + new_stream)
print("stream {} block rewritten with per-connection DNS resolution")
PY

cd "$STACK"
echo "Validating..."
if docker compose exec -T nginx sh -c "envsubst '\$DOMAIN' < /etc/nginx/nginx.conf > /tmp/nginx.test.conf && nginx -t -c /tmp/nginx.test.conf"; then
  docker compose up -d --force-recreate nginx
  echo "OK: nginx recreated. electrum:50002 is now resolved per connection."
else
  echo "FAILED validation — restoring backup, nothing changed."
  cp "$CONF.bak-$STAMP" "$CONF"
  exit 1
fi
