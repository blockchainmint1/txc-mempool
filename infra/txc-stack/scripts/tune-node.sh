#!/usr/bin/env bash
# Applies the RPC tuning settings to the HOST texitcoind config and restarts it.
#
# texitcoind is NOT a docker service on this box — node-spinner installed it as
# a systemd unit, so `docker compose restart texitcoind` will always say
# "no such service". This script finds the real config file, sets the values we
# need (idempotently), keeps a timestamped backup, and restarts the node.
#
# Usage (as root):  bash /opt/txc-mempool/infra/txc-stack/scripts/tune-node.sh
set -euo pipefail

# Settings that stop "Work queue depth exceeded" under explorer + wallet load.
declare -A WANT=(
  [rpcworkqueue]=256
  [rpcthreads]=32
  [dbcache]=2048
)

find_conf() {
  local c
  for c in \
    /root/.texitcoin/texitcoin.conf \
    /home/*/.texitcoin/texitcoin.conf \
    /var/lib/texitcoin/texitcoin.conf \
    /etc/texitcoin/texitcoin.conf \
    /opt/texitcoin/texitcoin.conf
  do
    [ -f "$c" ] && { echo "$c"; return 0; }
  done
  # Last resort: ask the running process what datadir it uses.
  c=$(pgrep -a texitcoind 2>/dev/null | grep -o -- '-datadir=[^ ]*' | head -1 | cut -d= -f2 || true)
  [ -n "${c:-}" ] && [ -f "$c/texitcoin.conf" ] && { echo "$c/texitcoin.conf"; return 0; }
  return 1
}

CONF=$(find_conf) || {
  echo "!! Could not locate texitcoin.conf. Run:  find / -name texitcoin.conf 2>/dev/null"
  exit 1
}
echo "==> config: $CONF"

cp -a "$CONF" "$CONF.bak.$(date +%Y%m%d-%H%M%S)"

for key in "${!WANT[@]}"; do
  val=${WANT[$key]}
  if grep -qE "^[[:space:]]*${key}[[:space:]]*=" "$CONF"; then
    sed -i -E "s|^[[:space:]]*${key}[[:space:]]*=.*|${key}=${val}|" "$CONF"
    echo "    set ${key}=${val} (replaced)"
  else
    printf '%s=%s\n' "$key" "$val" >> "$CONF"
    echo "    set ${key}=${val} (added)"
  fi
done

echo "==> restarting node"
SVC=""
for s in texitcoind texitcoin; do
  systemctl cat "${s}.service" >/dev/null 2>&1 && SVC="$s" && break
done
if [ -n "$SVC" ]; then
  systemctl restart "$SVC"
  sleep 5
  systemctl --no-pager --lines=5 status "$SVC" || true
else
  echo "!! No texitcoind systemd unit found. Restart the node however node-spinner"
  echo "   started it, then re-run the check below."
fi

echo "==> effective values"
grep -E '^(rpcworkqueue|rpcthreads|dbcache)=' "$CONF"

echo "==> waiting for RPC to answer again"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:15739/" -X POST \
      -d '{"jsonrpc":"1.0","id":1,"method":"getblockcount","params":[]}' 2>/dev/null \
     || curl -s "http://127.0.0.1:15739/" >/dev/null 2>&1; then
    echo "    RPC port is listening"
    break
  fi
  sleep 2
done
echo "==> done"
