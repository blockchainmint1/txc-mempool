#!/usr/bin/env bash
# Step 5 Option A: keep electrum*.texitcoin.org:443 working for phones that are
# already installed, without an app release.
#
# What it does, in order:
#   1. backs up /opt/txc-stack/nginx/nginx.conf
#   2. moves the HTTPS vhost from 443 -> 8443 (inside the container only)
#   3. appends a top-level `stream {}` block that listens on 443 and routes by
#      SNI: electrum* -> electrum shim, everything else -> the HTTPS vhost
#   4. validates with `nginx -t` and only then reloads
#
# Run as root on the box:
#   bash /opt/txc-mempool/infra/txc-stack/nginx/apply-sni-443.sh

set -euo pipefail

STACK=/opt/txc-stack
CONF="$STACK/nginx/nginx.conf"
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$CONF" ] || { echo "ERROR: $CONF not found"; exit 1; }

if grep -q 'ssl_preread' "$CONF"; then
  echo "Already applied (found ssl_preread in nginx.conf). Nothing to do."
  exit 0
fi

cp "$CONF" "$CONF.bak-$STAMP"
echo "Backup: $CONF.bak-$STAMP"

# 2) 443 -> 8443 for the TLS-terminating vhost(s)
sed -i -E 's/listen[[:space:]]+443([[:space:]]|;)/listen 8443\1/g; s/listen[[:space:]]+\[::\]:443([[:space:]]|;)/listen [::]:8443\1/g' "$CONF"
echo "Rewrote HTTPS vhost listeners to 8443:"
grep -nE 'listen[[:space:]]+(\[::\]:)?8443' "$CONF" || { echo "ERROR: no 443 listener found to move"; cp "$CONF.bak-$STAMP" "$CONF"; exit 1; }

# 3) append the SNI router at top level
cat >> "$CONF" <<'EOF'

# --- SNI router on 443 (added by apply-sni-443.sh) -------------------------
# electrum*.<domain>:443 is raw Electrum TLS for the wallet app; everything
# else is the normal HTTPS API terminated by the vhost above on 8443.
stream {
    # Docker's embedded DNS. Required so `electrum:50002` is resolved per
    # connection — a static upstream is resolved once at startup and keeps
    # dialling a dead IP (hanging) after the shim container is recreated.
    resolver 127.0.0.11 valid=1s ipv6=off;

    map $ssl_preread_server_name $txc_upstream {
        default        "127.0.0.1:8443";
        "~^electrum"   "electrum:50002";
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
EOF


cd "$STACK"
echo "Validating..."
if docker compose exec -T nginx sh -c "envsubst '\$DOMAIN' < /etc/nginx/nginx.conf > /tmp/nginx.test.conf && nginx -t -c /tmp/nginx.test.conf"; then
  docker compose up -d --force-recreate nginx
  echo "OK: nginx recreated with SNI routing on 443."
else
  echo "FAILED validation — restoring backup, nothing changed."
  cp "$CONF.bak-$STAMP" "$CONF"
  exit 1
fi
