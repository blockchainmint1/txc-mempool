#!/usr/bin/env bash
# Narrow deployment: only indexer code/Compose and the monitor; no node restart.
set -euo pipefail
SRC=/opt/txc-mempool
DST=/opt/txc-stack
[ "$(id -u)" = 0 ] || { echo 'Run sudo -i alone first, then run this script.'; exit 1; }
test -f "$DST/.env"
test -f "$DST/docker-compose.yml"
grep -q 'class WorkGate' "$SRC/infra/txc-stack/indexer/src/resource-controls.ts" || { echo 'Latest safeguards are missing; update the repository first.'; exit 1; }
backup="$DST/config-backup-$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
cp "$DST/docker-compose.yml" "$backup/"
mkdir -p "$DST/indexer/src" "$DST/scripts"
cp "$SRC/infra/txc-stack/indexer/src/"*.ts "$DST/indexer/src/"
for file in Dockerfile package.json tsconfig.json; do cp "$SRC/infra/txc-stack/indexer/$file" "$DST/indexer/$file"; done
# Preserve live Compose settings; change only the indexer's environment.
python3 - "$DST/docker-compose.yml" <<'PY'
import re,sys
p=sys.argv[1]
s=open(p).read()
match=re.search(r'(?ms)^  indexer:\n.*?(?=^  [a-zA-Z][\w-]*:|\Z)',s)
if not match: raise SystemExit('Cannot find indexer service; no Compose changes applied.')
chunk=match.group()
if '    environment:\n' not in chunk: raise SystemExit('Cannot find indexer environment; no Compose changes applied.')
for key,value in [('NODE_OPTIONS','--max-old-space-size=4096'),('RPC_TIMEOUT_MS','10000')]:
    pattern=r'(?m)^      '+key+r':.*$'
    line='      '+key+': "'+value+'"'
    if re.search(pattern,chunk): chunk=re.sub(pattern,line,chunk)
    else: chunk=chunk.replace('    environment:\n','    environment:\n'+line+'\n',1)
open(p,'w').write(s[:match.start()]+chunk+s[match.end():])
PY
cp "$SRC/infra/txc-stack/scripts/txc-monitor.sh" "$DST/scripts/txc-monitor.sh"
cd "$DST"
docker compose config --quiet
docker compose build indexer
docker compose up -d --no-deps indexer
echo 'Waiting for the history service...'
ready=0
for i in $(seq 1 30); do
  if docker exec txc-indexer curl -fsS --max-time 2 http://127.0.0.1:3001/health; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || { echo 'History service not ready; inspect logs below.'; docker logs --tail 30 txc-indexer; exit 1; }
printf '\n=== WALLET HISTORY ===\n'
curl -fsS --max-time 25 'https://mempool.texitcoin.org/api/address/TmmoqqhcfBZWRG8feCTE2c4N4BsADgwD1m/txs' | python3 -c 'import json,sys; rows=json.load(sys.stdin); assert isinstance(rows,list) and rows; print("Wallet history returned",len(rows),"transactions")'
printf '\n=== MONITOR ===\n'
cron=$(crontab -l 2>/dev/null || true)
if ! printf '%s\n' "$cron" | grep -Eq '^[^#].*txc-monitor\.sh'; then
  { printf '%s\n' "$cron"; echo '*/2 * * * * bash /opt/txc-stack/scripts/txc-monitor.sh >> /var/log/txc-monitor.log 2>&1'; } | crontab -
fi
bash "$DST/scripts/txc-monitor.sh"
printf '\n=== RECENT HISTORY SERVICE LOGS ===\n'
docker logs --since 3m --tail 25 txc-indexer 2>&1
echo "Config backup: $backup"
echo 'Update installed. Node and token scan data were not reset.'