# Runbook: retire the ElectrumX fleet, serve the wallet from our own stack

Goal: the TXC Wallet app stops depending on `electrum1/2/3.texitcoin.org`
(three m5.large boxes running a drifted ElectrumX fork) and instead talks to the
Electrum shim that runs beside the indexer on `txc_mempool_api`
(`i-09da90d763cd1df7e`, **98.85.45.100**).

Everything below is copy/paste. Anything you must type yourself is written in
`ALL_CAPS` and called out.

---

## Why the wallet broke, and what actually replaces what

The wallet is a BlueWallet fork. `blue_modules/BlueElectrum.ts` talks the
**Electrum protocol** — a raw TLS socket carrying newline-delimited JSON-RPC.
It is not HTTP, so it can't use our REST API and it can't be Cloudflare-proxied.

It needs exactly 12 methods plus JSON-RPC batching. Our indexer already stores
every piece of data those methods return, so `infra/txc-stack/electrum-shim/`
translates the protocol instead of maintaining a second full chain index. No new
sync, no ElectrumX merges, one box instead of three.

Two facts that shape the plan:

1. **`mempool.texitcoin.org` is Cloudflare** (185.158.133.1) — frontend only.
   **`api.mempool.texitcoin.org` is your EC2 box** (98.85.45.100). All Electrum
   work happens on the EC2 box.
2. **Electrum DNS records must be grey-cloud (proxy OFF).** Cloudflare's proxy
   only carries HTTP; raw TLS needs Spectrum, which is enterprise-only.

---

## Step 0 — connect to the box

In your terminal (or EC2 → Instances → `txc_mempool_api` → Connect → Session
Manager). Then become root:

```bash
sudo -i
```

You now have two directories on the box, and they are **not** the same thing:

- `/opt/txc-mempool` — the git clone of the project. Read-only source of truth.
- `/opt/txc-stack` — the **live running stack** (`docker-compose.yml`, `.env`,
  `nginx/`, the indexer database). This is what Docker actually runs.

So the pattern for every update is: `git pull` in the clone, then copy the
changed files across into the live stack.

---

## Step 1 — get the new service into the live stack

Pull the latest code:

```bash
cd /opt/txc-mempool && git pull
```

Copy the Electrum pieces into the live stack:

```bash
cp -r /opt/txc-mempool/infra/txc-stack/electrum-shim /opt/txc-stack/
cp /opt/txc-mempool/infra/txc-stack/nginx/stream-sni.conf.example /opt/txc-stack/nginx/
```

Your live `docker-compose.yml` has hand-edits (cert paths, ports), so do **not**
blindly overwrite it. Back it up, then copy the new one and re-check it:

```bash
cp /opt/txc-stack/docker-compose.yml /opt/txc-stack/docker-compose.yml.bak-$(date +%Y%m%d)
diff /opt/txc-stack/docker-compose.yml /opt/txc-mempool/infra/txc-stack/docker-compose.yml
```

If the diff only shows the new `electrum:` service being added, it is safe:

```bash
cp /opt/txc-mempool/infra/txc-stack/docker-compose.yml /opt/txc-stack/docker-compose.yml
cd /opt/txc-stack && docker compose config >/dev/null && echo "compose OK"
```

If the diff shows your own edits would be lost, paste the diff to me instead and
I'll tell you exactly which lines to add by hand.


---

## Step 2 — build and start the Electrum shim

Back on the box, as root, in `/opt/txc-stack`:

```bash
docker compose up -d --build electrum
```

Watch it come up (Ctrl+C to stop watching — it does not stop the service):

```bash
docker compose logs -f --tail=50 electrum
```

You want to see three lines: `TCP listening on 50001`,
`TLS listening on 50002`, and `scripthash map warm: +NNNN entries`.
The warm-up pass takes a minute or two the first time.

Local smoke test, still on the box:

```bash
printf '{"id":1,"method":"server.version","params":["probe","1.4"]}\n' | timeout 10 docker run --rm -i --network container:txc-electrum busybox nc 127.0.0.1 50001
```

Expected: `{"jsonrpc":"2.0","id":1,"result":["TxcElectrumShim 1.0","1.4.2"]}`

Balance probe against a real address (replace `ADDRESS_HERE`):

```bash
docker compose exec electrum node -e 'const{addressToScripthash}=require("/app/dist/scripthash.js");console.log(addressToScripthash(process.argv[1]))' ADDRESS_HERE
```

---

## Step 3 — open the firewall

AWS console → EC2 → Instances → `txc_mempool_api` → Security tab → click the
security group → **Edit inbound rules** → **Add rule**:

- Type: `Custom TCP`
- Port range: `50002`
- Source: `0.0.0.0/0`
- Description: `electrum TLS`

Save. (Port 50001 stays closed — it is container-internal only.)

---

## Step 4 — DNS

In Cloudflare DNS for `texitcoin.org`, edit these records:

| Name | Type | Content | Proxy |
|---|---|---|---|
| `electrum1` | A | `98.85.45.100` | **DNS only (grey cloud)** |
| `electrum2` | A | `98.85.45.100` | **DNS only (grey cloud)** |
| `electrum3` | A | `98.85.45.100` | **DNS only (grey cloud)** |
| `electrum`  | A | `98.85.45.100` | **DNS only (grey cloud)** |

Grey cloud is not optional. Orange cloud breaks the TLS handshake.

Then issue a cert that covers those names (still on the box, as root):

```bash
cd /opt/txc-stack
docker compose run --rm --entrypoint "" -p 80:80 certbot \
  certbot certonly --standalone -d electrum.texitcoin.org \
  -d electrum1.texitcoin.org -d electrum2.texitcoin.org -d electrum3.texitcoin.org \
  --email admin@texitcoin.org --agree-tos --no-eff-email
```

That temporarily needs port 80, so stop nginx first and start it after:

```bash
docker compose stop nginx
# ...run the certbot command above...
docker compose start nginx
```

Point the shim at the new cert. Edit `/opt/txc-stack/docker-compose.yml`:

```bash
nano /opt/txc-stack/docker-compose.yml
```

In the `electrum:` service change the two TLS lines to:

```yaml
      TLS_CERT: "/etc/letsencrypt/live/electrum.texitcoin.org/fullchain.pem"
      TLS_KEY: "/etc/letsencrypt/live/electrum.texitcoin.org/privkey.pem"
```

Save (Ctrl+O, Enter, Ctrl+X), then:

```bash
docker compose up -d --force-recreate electrum
```

Verify from **your laptop**:

```bash
printf '{"id":1,"method":"server.version","params":["probe","1.4"]}\n' | openssl s_client -quiet -connect electrum1.texitcoin.org:50002 2>/dev/null | head -1
```

---

## Step 5 — decide how phones reach it

**Option A (recommended, no app release): keep port 443.**
Installed apps hardcode port `443`. `nginx/stream-sni.conf.example` shows how to
route 443 by SNI — `electrum*` hostnames pass through to the shim, everything
else goes to the HTTPS API. Existing installs then work with only the DNS change
from step 4.

**Option B: ship an app update** pointing at port 50002 (see step 6). Cleaner,
but every phone that doesn't update stays broken.

Do both if you can: Option A now to un-break the field, Option B for new builds.

---

## Step 6 — the wallet app change

In the wallet repo, `blue_modules/BlueElectrum.ts` around line 89:

```ts
const defaultPeer = { host: 'electrum.texitcoin.org', ssl: '50002' };
const hardcodedPeers = [
  { host: 'electrum.texitcoin.org', ssl: '50002' },
  { host: 'electrum1.texitcoin.org', ssl: '50002' },
];
```

Keep at least two entries — the app rotates through the list on failure, and
both names resolve to the same box today but let you add a second box later
without another app release.

Nothing else in the wallet needs to change. The shim answers the same method set
with the same shapes, batching included.

---

## Step 7 — verify with a real wallet before you delete anything

1. Install/point a test wallet at the new endpoint.
2. Confirm: balance loads, transaction history loads, a receive address shows
   incoming funds, and **a send actually broadcasts**.
3. Watch `docker compose logs -f electrum` while you do it. Any
   `unknown method` line is a gap — send it to me and I'll add the method.

Do not proceed until a send succeeds.

---

## Step 8 — retire the three ElectrumX boxes

Only after step 7 passes, and **image them first**.

```bash
aws ec2 create-image --instance-id i-07b536febd8b8fd84 --name "electrumx-1-final-$(date +%Y%m%d)" --description "final image before retirement" --no-reboot
aws ec2 create-image --instance-id i-025df3921ac7c391c --name "electrumx-2-final-$(date +%Y%m%d)" --description "final image before retirement" --no-reboot
aws ec2 create-image --instance-id i-0dea407c4eb600c0b --name "electrumx-3-final-$(date +%Y%m%d)" --description "final image before retirement" --no-reboot
```

Wait until all three show `available`:

```bash
aws ec2 describe-images --owners self --query "Images[?starts_with(Name,'electrumx-')].[Name,State]" --output table
```

Then stop them (**stop, not terminate**) and leave them stopped for a week as
your rollback:

```bash
aws ec2 stop-instances --instance-ids i-07b536febd8b8fd84 i-025df3921ac7c391c i-0dea407c4eb600c0b
```

Terminate after a clean week:

```bash
aws ec2 terminate-instances --instance-ids i-07b536febd8b8fd84 i-025df3921ac7c391c i-0dea407c4eb600c0b
```

Three stopped m5.large instances cost only their EBS; three terminated ones cost
nothing. The week of patience is worth more than the savings.

---

## Step 9 — monitoring

Add the Electrum endpoint to the existing `/usr/local/bin/txc-monitor.sh`
checks so a dead shim pages the Telegram group:

```bash
cat >> /usr/local/bin/txc-monitor.sh <<'EOF'

# --- electrum shim ---
if ! printf '{"id":1,"method":"server.ping","params":[]}\n' \
     | timeout 8 openssl s_client -quiet -connect electrum.texitcoin.org:50002 2>/dev/null \
     | grep -q '"result"'; then
  fail "electrum endpoint not answering on 50002"
fi
EOF
```

If your monitor script uses a different helper than `fail`, match it — check
with `grep -n 'fail\|notify\|alert' /usr/local/bin/txc-monitor.sh` first.

---

## Rollback

DNS-only: point `electrum1/2/3` back at the old m5.large IPs and start those
instances. That is why step 8 stops rather than terminates.
