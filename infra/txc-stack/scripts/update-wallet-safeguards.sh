#!/usr/bin/env bash
# Phase 2 only: preserve live Compose, nginx, node, indexer and all data.
set -euo pipefail
SRC=/opt/txc-mempool/infra/txc-stack/electrum-shim
DST=/opt/txc-stack
[ "$(id -u)" = 0 ] || { echo 'Run sudo -i alone first, then run this script.'; exit 1; }
test -f "$DST/.env"
test -f "$DST/docker-compose.yml"
test -f "$SRC/src/protocol.ts"
grep -q 'MAX_BATCH, 200' "$SRC/src/resource-controls.ts" || { echo 'Wallet-compatible limits are missing; update the repository first.'; exit 1; }
backup="$DST/wallet-backup-$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$backup" "$DST/electrum-shim"
cp -a "$DST/electrum-shim" "$backup/"
old_image=$(docker inspect --format '{{.Image}}' txc-electrum)
docker image tag "$old_image" "txc-electrum-backup:$(basename "$backup")"
printf '%s\n' "$old_image" > "$backup/image-id.txt"
cp -a "$SRC/src" "$DST/electrum-shim/"
for file in Dockerfile package.json tsconfig.json; do cp "$SRC/$file" "$DST/electrum-shim/$file"; done
cd "$DST"
docker compose config --quiet
docker compose build electrum
docker compose up -d --no-deps electrum
ready=0
for i in $(seq 1 30); do
  if docker exec txc-electrum node -e '
    const tls=require("node:tls");
    const s=tls.connect({host:"127.0.0.1",port:50002,rejectUnauthorized:false});
    let buf="";
    const timer=setTimeout(()=>{s.destroy();process.exit(1)},4000);
    s.on("secureConnect",()=>s.write(JSON.stringify({id:1,method:"server.version",params:["healthcheck","1.4"]})+"\n"));
    s.on("data",c=>{buf+=c;const nl=buf.indexOf("\n");if(nl<0)return;const r=JSON.parse(buf.slice(0,nl));if(!r.result)process.exit(1);clearTimeout(timer);s.destroy();console.log("Wallet TLS connected:",r.result.join(" / "));});
    s.on("error",()=>process.exit(1));'; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || { echo 'Wallet check failed. Backup and prior image are retained; do not update other services.'; docker logs --tail 30 txc-electrum; exit 1; }
printf '\n=== WALLET-SIZED BATCH ===\n'
docker exec txc-electrum node -e '
  const net=require("node:net");
  const s=net.connect(50001,"127.0.0.1");let buf="";
  const timer=setTimeout(()=>{s.destroy();process.exit(1)},10000);
  s.on("connect",()=>s.write(JSON.stringify(Array.from({length:200},(_,id)=>({id,method:"blockchain.scripthash.get_balance",params:["0".repeat(64)]})))+"\n"));
  s.on("data",c=>{buf+=c;const nl=buf.indexOf("\n");if(nl<0)return;const r=JSON.parse(buf.slice(0,nl));if(!Array.isArray(r)||r.length!==200||r.some(x=>x.error))process.exit(1);clearTimeout(timer);s.destroy();console.log("200-request wallet batch passed (protocol check, not a funded-wallet check)");});
  s.on("error",()=>process.exit(1));'
printf '\n=== HISTORY STILL WORKING ===\n'
curl -fsS --max-time 25 'https://mempool.texitcoin.org/api/address/TmmoqqhcfBZWRG8feCTE2c4N4BsADgwD1m/txs' | python3 -c 'import json,sys; r=json.load(sys.stdin); assert isinstance(r,list) and r; print("History returned",len(r),"transactions")'
printf '\n=== WALLET SERVICE LOGS ===\n'
docker logs --since 3m --tail 20 txc-electrum 2>&1
echo "Wallet backup: $backup"
echo 'Phase 2 installed. Only wallet connections restarted; node, history service, TLS settings and token data were unchanged.'
echo 'Now refresh your real wallet and confirm balance/history. Send a small payment only when convenient.'