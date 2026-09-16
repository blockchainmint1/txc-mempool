#!/usr/bin/env bash
# TXC mempool canary — runs a series of health tests against this box and the
# public API, prints a PASS/WARN/FAIL table, and (optionally) sends a single
# Telegram summary when something is wrong.
#
# Usage (as root on the box):
#   bash /opt/txc-mempool/infra/txc-stack/scripts/canary.sh            # print report
#   bash /opt/txc-mempool/infra/txc-stack/scripts/canary.sh --alert    # + Telegram on failure
#   bash /opt/txc-mempool/infra/txc-stack/scripts/canary.sh --quiet    # only print problems
#
# Exit code: 0 all pass, 1 warnings only, 2 one or more failures.
# Telegram creds are read from /opt/txc-stack/.env (TELEGRAM_BOT_TOKEN,
# TELEGRAM_CHAT_ID) if present.

set -uo pipefail

# NOTE: the stack .env defines DOMAIN as the *API* host (api.mempool...), so we
# keep our own names here and re-assert them after sourcing .env below.
SITE_DOMAIN_OVERRIDE="${SITE_DOMAIN:-}"
API_DOMAIN_OVERRIDE="${API_DOMAIN:-}"
ELECTRUM_HOST="${ELECTRUM_HOST:-electrum1.texitcoin.org}"
STACK_DIR="${STACK_DIR:-/opt/txc-stack}"
NODE_CONF="${NODE_CONF:-/var/lib/texitcoin/texitcoin.conf}"

ALERT=0; QUIET=0
for a in "$@"; do
  case "$a" in
    --alert) ALERT=1 ;;
    --quiet) QUIET=1 ;;
  esac
done

PASS=0; WARN=0; FAIL=0
PROBLEMS=""

C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_Y=""; C_R=""; C_0=""; }

report() { # status label detail
  local st="$1" label="$2" detail="$3"
  case "$st" in
    PASS) PASS=$((PASS+1)); [ "$QUIET" = 1 ] && return 0
          printf "%s  PASS %s %-34s %s\n" "$C_G" "$C_0" "$label" "$detail" ;;
    WARN) WARN=$((WARN+1)); PROBLEMS="${PROBLEMS}WARN  ${label}: ${detail}"$'\n'
          printf "%s  WARN %s %-34s %s\n" "$C_Y" "$C_0" "$label" "$detail" ;;
    FAIL) FAIL=$((FAIL+1)); PROBLEMS="${PROBLEMS}FAIL  ${label}: ${detail}"$'\n'
          printf "%s  FAIL %s %-34s %s\n" "$C_R" "$C_0" "$label" "$detail" ;;
  esac
}

# ---- helpers ----------------------------------------------------------------

# http_check <label> <url> <max_seconds> [grep_pattern]
http_check() {
  local label="$1" url="$2" max="$3" pat="${4:-}"
  local out code time body
  out=$(curl -sS -m 20 -o /tmp/canary.body -w '%{http_code} %{time_total}' "$url" 2>/dev/null) || {
    report FAIL "$label" "no response"; return; }
  code="${out%% *}"; time="${out##* }"
  # Strip CR/LF and HTML tags so an error page can never scramble the table.
  body=$(head -c 400 /tmp/canary.body | tr -d '\r\n' | sed 's/<[^>]*>/ /g' | tr -s ' ')
  if [ "$code" != "200" ]; then
    report FAIL "$label" "HTTP $code — ${body:0:80}"; return
  fi
  if [ -n "$pat" ] && ! grep -q "$pat" /tmp/canary.body; then
    report FAIL "$label" "unexpected body — ${body:0:80}"; return
  fi
  if awk "BEGIN{exit !($time > $max)}"; then
    report WARN "$label" "slow: ${time}s (limit ${max}s)"; return
  fi
  report PASS "$label" "200 in ${time}s"
}

rpc() { # rpc <method> [params-json]
  local method="$1" params="${2:-[]}"
  curl -s -m 15 --user "${RPC_USER}:${RPC_PASSWORD}" \
    -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"1.0\",\"id\":\"canary\",\"method\":\"${method}\",\"params\":${params}}" \
    "http://127.0.0.1:${RPC_PORT:-15739}/"
}

jnum() { grep -oE "\"$1\" *: *-?[0-9.]+" | grep -oE '\-?[0-9.]+$' | head -1; }

echo "==> TXC canary  $(date -u '+%Y-%m-%d %H:%M:%SZ')  host $(hostname)"
echo

# ---- 0. env ----------------------------------------------------------------
if [ -f "$STACK_DIR/.env" ]; then
  set -a; # shellcheck disable=SC1091
  source "$STACK_DIR/.env"; set +a
fi

# .env's DOMAIN is the API host; the app routes (price, supply, richlist,
# mining, homepage) live on the site host. Keep the two apart.
SITE="${SITE_DOMAIN_OVERRIDE:-mempool.texitcoin.org}"
API="${API_DOMAIN_OVERRIDE:-${DOMAIN:-api.mempool.texitcoin.org}}"

# ---- 1. host resources -----------------------------------------------------
echo "-- host --"
disk_pct=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
disk_free=$(df -Ph / | awk 'NR==2{print $4}')
if   [ "${disk_pct:-0}" -ge 92 ]; then report FAIL "disk /" "${disk_pct}% used, ${disk_free} free"
elif [ "${disk_pct:-0}" -ge 82 ]; then report WARN "disk /" "${disk_pct}% used, ${disk_free} free"
else report PASS "disk /" "${disk_pct}% used, ${disk_free} free"; fi

mem_pct=$(free | awk '/^Mem:/{printf "%d", ($2-$7)/$2*100}')
if   [ "${mem_pct:-0}" -ge 95 ]; then report FAIL "memory" "${mem_pct}% used"
elif [ "${mem_pct:-0}" -ge 88 ]; then report WARN "memory" "${mem_pct}% used"
else report PASS "memory" "${mem_pct}% used"; fi

cores=$(nproc)
load1=$(awk '{print $1}' /proc/loadavg)
if awk "BEGIN{exit !($load1 > $cores * 2)}"; then report WARN "load average" "${load1} on ${cores} cores"
else report PASS "load average" "${load1} on ${cores} cores"; fi

# ---- 2. texitcoind (host systemd service) ----------------------------------
echo
echo "-- texitcoin node --"
if systemctl is-active --quiet texitcoind; then
  since=$(systemctl show -p ActiveEnterTimestamp --value texitcoind)
  report PASS "texitcoind.service" "active since ${since:-unknown}"
else
  report FAIL "texitcoind.service" "NOT running — systemctl restart texitcoind"
fi

for k in rpcworkqueue rpcthreads dbcache; do
  v=$(grep -E "^${k}=" "$NODE_CONF" 2>/dev/null | tail -1 | cut -d= -f2)
  [ -n "$v" ] && report PASS "conf ${k}" "$v" || report WARN "conf ${k}" "not set in $NODE_CONF"
done

chain=$(rpc getblockchaininfo)
if [ -z "$chain" ] || ! echo "$chain" | grep -q '"blocks"'; then
  report FAIL "node RPC" "no usable answer from 127.0.0.1:${RPC_PORT:-15739}"
  node_height=""
else
  node_height=$(echo "$chain" | jnum blocks)
  prog=$(echo "$chain" | jnum verificationprogress)
  if awk "BEGIN{exit !(${prog:-0} < 0.9999)}"; then
    report WARN "node sync" "height ${node_height}, progress ${prog}"
  else
    report PASS "node sync" "height ${node_height}, fully synced"
  fi
  peers=$(rpc getconnectioncount | jnum result)
  if [ "${peers:-0}" -lt 1 ]; then report FAIL "node peers" "0 connections"
  elif [ "${peers:-0}" -lt 3 ]; then report WARN "node peers" "only ${peers}"
  else report PASS "node peers" "${peers} connections"; fi
fi

# RPC work queue pressure: 12 concurrent calls should all succeed.
qfail=0
for _ in $(seq 1 12); do
  ( rpc getblockcount | grep -q '"result"' || echo x >> /tmp/canary.qfail ) &
done
wait
[ -f /tmp/canary.qfail ] && { qfail=$(wc -l < /tmp/canary.qfail); rm -f /tmp/canary.qfail; }
if   [ "$qfail" -ge 4 ]; then report FAIL "RPC under load (12x)" "${qfail}/12 rejected"
elif [ "$qfail" -gt 0 ]; then report WARN "RPC under load (12x)" "${qfail}/12 rejected"
else report PASS "RPC under load (12x)" "all 12 answered"; fi

# ---- 3. containers ---------------------------------------------------------
echo
echo "-- containers --"
if command -v docker >/dev/null 2>&1; then
  for c in txc-mempool-db txc-mempool-api txc-indexer txc-electrum txc-nginx txc-certbot; do
    st=$(docker inspect -f '{{.State.Status}}{{if .State.Health}} ({{.State.Health.Status}}){{end}}' "$c" 2>/dev/null)
    if [ -z "$st" ]; then report FAIL "container $c" "missing"
    elif [[ "$st" == running* && "$st" != *"unhealthy"* ]]; then
      restarts=$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null)
      if [ "${restarts:-0}" -ge 5 ]; then report WARN "container $c" "$st, ${restarts} restarts"
      else report PASS "container $c" "$st"; fi
    else report FAIL "container $c" "$st"; fi
  done
else
  report WARN "containers" "docker not available"
fi

# ---- 4. indexer ------------------------------------------------------------
echo
echo "-- address indexer --"
idx=$(curl -s -m 15 "https://${API}/api/address/_status")
if echo "$idx" | grep -q 'indexed_tip'; then
  idx_tip=$(echo "$idx" | jnum indexed_tip)
  if [ -n "$node_height" ] && [ -n "$idx_tip" ]; then
    lag=$(( node_height - idx_tip ))
    if   [ "$lag" -gt 20 ]; then report FAIL "indexer lag" "${lag} blocks behind (tip ${idx_tip})"
    elif [ "$lag" -gt 5 ]; then report WARN "indexer lag" "${lag} blocks behind (tip ${idx_tip})"
    else report PASS "indexer lag" "${lag} blocks behind (tip ${idx_tip})"; fi
  else
    report PASS "indexer status" "tip ${idx_tip}"
  fi
else
  report FAIL "indexer status" "${idx:0:80}"
fi

# ---- 5. public API surface --------------------------------------------------
echo
echo "-- public API (https://${SITE}) --"
http_check "tip height"          "https://${SITE}/api/blocks/tip/height"        1.5 '^[0-9]'
http_check "tip hash"            "https://${SITE}/api/blocks/tip/hash"          1.5 '^[0-9a-f]\{64\}'
http_check "blocks listing"      "https://${SITE}/api/v1/blocks"                2.5 'height'
http_check "mempool summary"     "https://${SITE}/api/v1/mempool"               2.0 'count'
http_check "fees recommended"    "https://${SITE}/api/v1/fees/recommended"      2.0 'fastestFee'
http_check "difficulty adjust"   "https://${SITE}/api/v1/difficulty-adjustment" 2.0 'progressPercent'
http_check "network hashrate"    "https://${SITE}/api/v1/mining/hashrate"       6.0 'currentHashrate'
http_check "pool ranking 1w"     "https://${SITE}/api/v1/mining/pools/1w"       6.0 'pools'
http_check "richlist"            "https://${SITE}/api/v1/richlist"              2.0 'entries'
http_check "supply"              "https://${SITE}/api/v1/supply"                2.5 'circulating'
http_check "price"               "https://${SITE}/api/v1/price"                 2.5 'usd'
http_check "legacy /v1/default"  "https://${SITE}/v1/default"                   2.5 'price'
http_check "raw backend"         "https://${API}/api/blocks/tip/height"    1.5 '^[0-9]'
http_check "homepage"            "https://${SITE}/"                             4.0 '<html'

# CORS must be present exactly once (duplicate headers break browsers).
acao=$(curl -sSI -m 15 "https://${SITE}/api/blocks/tip/height" | grep -ci '^access-control-allow-origin')
if   [ "${acao:-0}" -eq 1 ]; then report PASS "CORS header" "present once"
elif [ "${acao:-0}" -eq 0 ]; then report FAIL "CORS header" "missing"
else report FAIL "CORS header" "duplicated (${acao}x)"; fi

# API height must track the node.
api_h=$(curl -s -m 15 "https://${SITE}/api/blocks/tip/height" | tr -dc '0-9')
if [ -n "$api_h" ] && [ -n "$node_height" ]; then
  d=$(( node_height - api_h )); [ "$d" -lt 0 ] && d=$(( -d ))
  if [ "$d" -gt 3 ]; then report FAIL "API vs node height" "API ${api_h}, node ${node_height}"
  else report PASS "API vs node height" "API ${api_h}, node ${node_height}"; fi
fi

# ---- 6. electrum (wallet app) ----------------------------------------------
echo
echo "-- electrum (wallet) --"
for target in "127.0.0.1:50002" "${ELECTRUM_HOST}:443"; do
  host="${target%%:*}"; port="${target##*:}"
  ver=$(printf '{"id":1,"method":"server.version","params":["canary","1.4"]}\n' \
        | timeout 12 openssl s_client -quiet -verify_quiet -servername "$ELECTRUM_HOST" \
          -connect "$host:$port" 2>/dev/null | head -1)
  if echo "$ver" | grep -q '"result"'; then report PASS "electrum ${target}" "server.version ok"
  else report FAIL "electrum ${target}" "no Electrum reply"; fi
done

# ---- 7. TLS certificate expiry ---------------------------------------------
echo
echo "-- certificates --"
for h in "$SITE" "$API" "$ELECTRUM_HOST"; do
  end=$(echo | timeout 12 openssl s_client -servername "$h" -connect "$h:443" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -z "$end" ]; then report FAIL "cert $h" "could not read certificate"; continue; fi
  days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
  if   [ "$days" -lt 7 ];  then report FAIL "cert $h" "expires in ${days}d"
  elif [ "$days" -lt 21 ]; then report WARN "cert $h" "expires in ${days}d"
  else report PASS "cert $h" "valid ${days}d"; fi
done

# ---- summary ---------------------------------------------------------------
echo
echo "==> ${PASS} pass, ${WARN} warn, ${FAIL} fail"

if [ "$ALERT" = 1 ] && [ -n "$PROBLEMS" ] && [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  msg="TXC canary on $(hostname): ${FAIL} fail, ${WARN} warn"$'\n\n'"${PROBLEMS}"
  for chat in ${TELEGRAM_CHAT_ID//,/ }; do
    [ -n "$chat" ] || continue
    curl -s -m 15 -o /dev/null \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${chat}" \
      --data-urlencode "text=${msg}"
  done
  echo "==> Telegram alert sent"
fi

if [ "$FAIL" -gt 0 ]; then exit 2; fi
if [ "$WARN" -gt 0 ]; then exit 1; fi
exit 0
