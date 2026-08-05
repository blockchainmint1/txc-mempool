#!/usr/bin/env bash
# Fix: the SNI router on 443 stops reaching the electrum shim after the shim
# container (or the whole instance) restarts.
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
# This script is idempotent and self-healing: it removes EVERY top-level
# `stream { ... }` block (earlier runs of apply-sni-443.sh could append more than
# one, which nginx rejects) and writes exactly one correct block.
#
# Run as root on the box:
#   bash /opt/txc-mempool/infra/txc-stack/nginx/fix-sni-resolver.sh

set -euo pipefail

STACK=/opt/txc-stack
CONF="$STACK/nginx/nginx.conf"
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$CONF" ] || { echo "ERROR: $CONF not found"; exit 1; }

cp "$CONF" "$CONF.bak-$STAMP"
echo "Backup: $CONF.bak-$STAMP"

# The HTTPS vhost must NOT listen on 443 — the stream{} SNI router owns it.
# If both listen on 443, TLS handshakes are answered by whichever listener wins
# the race, so wallet/API connections fail intermittently.
sed -i -E 's/listen[[:space:]]+443([[:space:]]|;)/listen 127.0.0.1:8443\1/g; s/listen[[:space:]]+\[::\]:443([[:space:]]|;)/listen 127.0.0.1:8443\1/g' "$CONF"
sed -i -E '/^stream/,$ s/listen 127\.0\.0\.1:8443;/listen 443;/' "$CONF"
echo "HTTPS vhost listener(s):"; grep -nE 'listen .*8443' "$CONF" || true

python3 - "$CONF" <<'PY'
import re, sys

path = sys.argv[1]
src = open(path).read()

# Strip every top-level `stream { ... }` block by brace matching, plus the
# comment header apply-sni-443.sh writes above it.
removed = 0
while True:
    m = re.search(r'^stream\s*\{', src, re.M)
    if not m:
        break
    i = m.start()
    j = src.index('{', i)
    depth = 0
    end = None
    for k in range(j, len(src)):
        if src[k] == '{':
            depth += 1
        elif src[k] == '}':
            depth -= 1
            if depth == 0:
                end = k + 1
                break
    if end is None:
        raise SystemExit("ERROR: unbalanced braces in stream block — aborting")
    # also eat a preceding run of comment lines
    head = src[:i].rstrip('\n').split('\n')
    while head and head[-1].lstrip().startswith('#'):
        head.pop()
    src = ('\n'.join(head) + '\n' + src[end:].lstrip('\n'))
    removed += 1

print(f"removed {removed} existing stream block(s)")

stream = '''
# --- SNI router on 443 (managed by fix-sni-resolver.sh) --------------------
# electrum*.<domain>:443 is raw Electrum TLS for the wallet app; everything
# else is the normal HTTPS API terminated by the vhost above on 8443.
stream {
    # Docker's embedded DNS. Required: a proxy_pass variable target is resolved
    # per connection, so a recreated electrum container is picked up in ~10s.
    resolver 127.0.0.11 valid=10s ipv6=off;

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
'''

src = src.rstrip('\n') + '\n' + stream
open(path, 'w').write(src)
print("wrote one clean stream block")
PY

echo "=== stream block as written ==="
grep -n -A 22 '^stream {' "$CONF"

cd "$STACK"
echo "=== validating ==="
# Use a disposable container because the live nginx container may currently be
# crash-looping and therefore unavailable to `docker compose exec`.
if docker compose run --rm --no-deps --entrypoint sh nginx -c "envsubst '\$DOMAIN' < /etc/nginx/nginx.conf > /tmp/nginx.test.conf && nginx -t -c /tmp/nginx.test.conf" 2>&1 | tee /tmp/nginx-test.out | grep -q 'test is successful'; then
  docker compose up -d --force-recreate nginx
  echo "OK: nginx recreated. electrum:50002 is now resolved per connection."
else
  echo "--- nginx said ---"
  cat /tmp/nginx-test.out
  BADLINE=$(grep -oE 'nginx.test.conf:[0-9]+' /tmp/nginx-test.out | head -1 | cut -d: -f2 || true)
  if [ -n "${BADLINE:-}" ]; then
    echo "--- offending region (lines $((BADLINE-6))-$((BADLINE+6))) ---"
    sed -n "$((BADLINE-6)),$((BADLINE+6))p" "$CONF" || true
  fi
  echo "FAILED validation — restoring backup, nothing changed."
  cp "$CONF.bak-$STAMP" "$CONF"
  exit 1
fi
