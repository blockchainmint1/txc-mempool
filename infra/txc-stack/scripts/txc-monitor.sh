#!/usr/bin/env bash
# TXC monitor — watches the local texitcoind RPC and the public API, and sends a
# Telegram alert ONLY when a problem is real and sustained.
#
# Why this rewrite: the old probe fired an alert on a single failed RPC call.
# texitcoind answers "Work queue depth exceeded" (HTTP 500, plain text) for a
# second or two whenever a burst of clients hits it at once, and it also stops
# answering briefly while it connects a new block. Both are normal and
# self-healing — but a one-shot probe reads them as "node down", which is why
# ALERT/RECOVERED pairs arrived a minute apart all night.
#
# Rules now:
#   * a probe must fail STRIKES times in a row, PROBE_GAP seconds apart
#   * transient RPC pushback (work queue / warming up / loading index) is
#     treated as degraded, not down, and only alerts if it persists
#   * alerts are deduplicated: one message per state change, plus a reminder
#     every REMIND_MIN minutes while still broken
#
# Install (as root):
#   ( crontab -l 2>/dev/null; echo "*/2 * * * * bash /opt/txc-mempool/infra/txc-stack/scripts/txc-monitor.sh >> /var/log/txc-monitor.log 2>&1" ) | crontab -

set -uo pipefail

STACK_DIR="${STACK_DIR:-/opt/txc-stack}"
NODE_CONF="${NODE_CONF:-/var/lib/texitcoin/texitcoin.conf}"
DOMAIN="${DOMAIN:-mempool.texitcoin.org}"
RPC_PORT="${RPC_PORT:-15739}"

STRIKES="${STRIKES:-4}"          # consecutive failures required
PROBE_GAP="${PROBE_GAP:-12}"     # seconds between probes
RPC_TIMEOUT="${RPC_TIMEOUT:-25}" # per-probe timeout (was far too short before)
REMIND_MIN="${REMIND_MIN:-60}"   # re-nag interval while still down

STATE_DIR="/var/lib/txc-monitor"
STATE_FILE="$STATE_DIR/state"
mkdir -p "$STATE_DIR"

if [ -f "$STACK_DIR/.env" ]; then
  set -a; # shellcheck disable=SC1091
  source "$STACK_DIR/.env"; set +a
fi

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

tg() { # tg <text>  (TELEGRAM_CHAT_ID may be comma-separated for multiple chats)
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || return 0
  local chat
  for chat in ${TELEGRAM_CHAT_ID//,/ }; do
    [ -n "$chat" ] || continue
    curl -s -m 15 -o /dev/null \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${chat}" \
      --data-urlencode "text=$1"
  done
}

rpc_raw() { # rpc_raw <method>
  curl -s -m "$RPC_TIMEOUT" --user "${RPC_USER:-}:${RPC_PASSWORD:-}" \
    -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"1.0\",\"id\":\"mon\",\"method\":\"$1\",\"params\":[]}" \
    "http://127.0.0.1:${RPC_PORT}/"
}

# Classify one probe: ok | busy | down  (echoes "class<TAB>detail")
probe() {
  local body lower
  body=$(rpc_raw getblockcount)
  lower=$(printf '%s' "$body" | tr '[:upper:]' '[:lower:]')
  if printf '%s' "$body" | grep -q '"result"'; then
    printf 'ok\t%s\n' "$(printf '%s' "$body" | grep -oE '"result" *: *[0-9]+' | grep -oE '[0-9]+')"
  elif printf '%s' "$lower" | grep -qE 'work queue|warming up|loading block index|service unavailable'; then
    printf 'busy\t%s\n' "$(printf '%s' "$body" | head -c 80 | tr -d '\n')"
  elif [ -z "$body" ]; then
    printf 'down\tno response on :%s\n' "$RPC_PORT"
  else
    printf 'down\t%s\n' "$(printf '%s' "$body" | head -c 80 | tr -d '\n')"
  fi
}

# ---- run the strike sequence ------------------------------------------------
bad=0; busy=0; last_detail=""; height=""
for i in $(seq 1 "$STRIKES"); do
  IFS=$'\t' read -r cls detail <<<"$(probe)"
  case "$cls" in
    ok)   height="$detail"; bad=0; busy=0; break ;;
    busy) busy=$((busy+1)); bad=$((bad+1)); last_detail="$detail" ;;
    down) bad=$((bad+1)); last_detail="$detail" ;;
  esac
  [ "$i" -lt "$STRIKES" ] && sleep "$PROBE_GAP"
done

# The public API is what users actually touch; if it still serves, this is at
# most degraded — the retry + last-known-good fallback is doing its job.
api_code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "https://${DOMAIN}/api/blocks/tip/height")

if [ "$bad" -lt "$STRIKES" ]; then
  status="up"
  msg="texitcoind ok at block ${height:-?}"
elif [ "$busy" -ge "$STRIKES" ] && [ "$api_code" = "200" ]; then
  status="degraded"
  msg="texitcoind RPC is saturated (queue pushback) but the public API is still serving. ${last_detail}"
else
  status="down"
  msg="texitcoind RPC not answering on :${RPC_PORT} — public API returned ${api_code}. ${last_detail}"
fi

log "status=$status bad=$bad busy=$busy api=$api_code height=${height:-} ${last_detail}"

# ---- state machine: only notify on change, or on the reminder interval ------
prev_status="up"; prev_at=0
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  read -r prev_status prev_at < "$STATE_FILE" || true
fi
now=$(date +%s)

notify=0
if [ "$status" != "$prev_status" ]; then
  notify=1
elif [ "$status" != "up" ] && [ $(( (now - ${prev_at:-0}) / 60 )) -ge "$REMIND_MIN" ]; then
  notify=1
fi

if [ "$notify" = 1 ]; then
  case "$status" in
    up)       tg "[mempool.TXC] ✅ TXC RECOVERED"$'\n'"$msg"$'\n\n'"$(hostname)" ;;
    degraded) tg "[mempool.TXC] ⚠️ TXC DEGRADED"$'\n'"$msg"$'\n\n'"$(hostname)" ;;
    down)     tg "[mempool.TXC] 🔴 TXC ALERT"$'\n'"$msg"$'\n\n'"$(hostname)" ;;
  esac
  printf '%s %s\n' "$status" "$now" > "$STATE_FILE"
elif [ "$status" = "$prev_status" ] && [ "$status" = "up" ]; then
  printf '%s %s\n' "$status" "${prev_at:-$now}" > "$STATE_FILE"
fi

# ---- self-heal: if truly down, make sure the service is running -------------
if [ "$status" = "down" ]; then
  if ! systemctl is-active --quiet texitcoind; then
    log "texitcoind.service inactive — restarting"
    systemctl restart texitcoind
    tg "[mempool.TXC] 🔧 texitcoind.service was inactive; restarted automatically."$'\n\n'"$(hostname)"
  fi
fi

# ---- one-time nudge if the node tuning was never applied -------------------
for kv in rpcworkqueue=256 rpcthreads=32 dbcache=2048; do
  k="${kv%%=*}"
  have=$(grep -E "^${k}=" "$NODE_CONF" 2>/dev/null | tail -1 | cut -d= -f2)
  [ "$have" = "${kv##*=}" ] || log "NOTE: ${k} is '${have:-unset}', expected ${kv##*=} — run tune-node.sh"
done

exit 0
