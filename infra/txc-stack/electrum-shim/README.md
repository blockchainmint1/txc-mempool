# TXC Electrum shim

An Electrum-protocol front door for the TXC mempool stack. It exists so the
TXC Wallet mobile app (a BlueWallet fork, hard-wired to the Electrum protocol)
can stop depending on the three ElectrumX boxes and talk to the same node +
indexer that already power mempool.texitcoin.org.

## Why not keep ElectrumX?

ElectrumX needs its own full re-index of the chain in its own database, and the
TXC fork has drifted from upstream — every ElectrumX upgrade is a merge
exercise. Meanwhile our indexer already has the exact data the wallet asks for
(address history, UTXOs, balances, mempool deltas). This service is ~600 lines
that translates Electrum requests into indexer queries and `texitcoind` RPC
calls. Nothing new to sync.

## What it implements (Electrum protocol 1.4)

Everything the wallet's `blue_modules/BlueElectrum.ts` calls, including JSON-RPC
**batch** requests, which the wallet relies on for bulk address scans:

| Method | Backed by |
|---|---|
| `server.version` / `ping` / `features` / `banner` / `peers.subscribe` | static |
| `blockchain.headers.subscribe` (+ push notifications) | RPC `getblockheader` |
| `blockchain.block.header` / `block.headers` | RPC |
| `blockchain.estimatefee`, `blockchain.relayfee` | RPC `estimatesmartfee` / `getmempoolinfo` |
| `mempool.get_fee_histogram` | RPC `getrawmempool true` |
| `blockchain.scripthash.get_balance` | indexer `balances` + mempool deltas |
| `blockchain.scripthash.get_history` | indexer `address_txs` + mempool |
| `blockchain.scripthash.get_mempool` | indexer `mempool_address_txs` |
| `blockchain.scripthash.listunspent` | indexer `outputs` |
| `blockchain.scripthash.subscribe` / `unsubscribe` (+ push) | status hash over history |
| `blockchain.transaction.get` (raw + verbose) | RPC `getrawtransaction` |
| `blockchain.transaction.broadcast` | RPC `sendrawtransaction` |
| `blockchain.transaction.id_from_pos` | RPC `getblock` |

Not implemented: `blockchain.transaction.get_merkle` (SPV proofs). BlueWallet
never calls it; desktop Electrum does, so this shim is a *wallet-app* endpoint,
not a general-purpose ElectrumX replacement for SPV clients.

## Scripthash mapping

Electrum keys everything by `reverse(sha256(scriptPubKey))`. The indexer keys on
addresses, so the shim keeps a side-car SQLite (`scripthash.sqlite`) mapping
scripthash → address, built by encoding every known address (P2PKH `0x42`,
P2SH `0x32`, bech32 `txc1…` v0/v1) and refreshed every 60s. Unknown scripthash =
unused address = empty reply, which is the correct Electrum answer.

## Ports

- `50001` plain TCP (internal / testing only)
- `50002` TLS — this is what the wallet connects to

TLS uses the same Let's Encrypt cert as nginx, mounted read-only. **Electrum is
a raw TLS socket, not HTTP**: DNS for the electrum hostname must point straight
at the EC2 elastic IP with the Cloudflare proxy OFF (grey cloud). Orange-cloud
it and the handshake dies.

## Environment

| Var | Default | Notes |
|---|---|---|
| `RPC_URL` | `http://host.docker.internal:15739` | texitcoind on the host |
| `RPC_USER` / `RPC_PASSWORD` | — | from `.env` |
| `INDEXER_DB_PATH` | `/data/indexer.sqlite` | read-only mount of the indexer DB |
| `MAP_DB_PATH` | `/data/scripthash.sqlite` | writable side-car |
| `TLS_CERT` / `TLS_KEY` | — | Let's Encrypt fullchain / privkey |
| `TIP_POLL_MS` | `5000` | tip + subscription push interval |
| `MAP_REFRESH_MS` | `60000` | scripthash map refresh |
| `RPC_MAX_INFLIGHT` | `8` | process-wide active node calls |
| `RPC_MAX_QUEUE` | `200` | bounded FIFO waiting callers; 2-second wait deadline |
| `MAX_CLIENTS` | `500` | combined TCP/TLS sockets, including TLS handshakes |
| `MAX_BATCH` | `200` | preserves current mobile wallet balance batches; oversized batches return -32600 |
| `CLIENT_REQUESTS_PER_SECOND` | `200` | per-connection token refill; excess returns -32000 |
| `CLIENT_REQUEST_BURST` | `1000` | accommodates combined balance/history/UTXO refresh waves |

Each connection processes at most four requests concurrently across all lines
and batches, with at most 1,000 waiting requests and a 30-second waiting deadline.
Detailed transaction input enrichment also uses four workers. Header batches
return at most 500 headers and advertise `max: 500`. Silent connections close
after ten minutes without incoming data; outgoing notifications do not reset
that deadline. Pending transaction caches retain only input outpoints and
output numbers, values and addresses, never transaction hex.

The Phase 2 compatibility adjustment deliberately differs from the audit's
50-entry batches and 40-request burst: existing mobile wallet helpers send
200 balance or 100 history/UTXO requests at a time. Do not reduce these limits
without verifying deployed wallet behavior. These bounds limit overload but
cannot guarantee every wallet workload fits; monitor rejected requests.

## Phase 2 isolated update

After syncing the repository, run as root:

```bash
bash /opt/txc-mempool/infra/txc-stack/scripts/update-wallet-safeguards.sh
```

This backs up wallet-service source and retains its prior image, copies only
the wallet-service source/configuration, and rebuilds/restarts only `electrum`
with `--no-deps`. Live Compose, nginx, credentials, indexer/node processes,
TLS settings and data remain unchanged. Connected wallets briefly reconnect.
The script checks local TLS, a 200-request batch, and public address history.
The local TLS check deliberately bypasses certificate trust validation; it
does not establish phone trust or public port-443 routing. Confirm balance,
history and a small send in a real wallet after installation.

## Health check

```bash
printf '{"id":1,"method":"server.version","params":["probe","1.4"]}\n' \
  | openssl s_client -quiet -connect electrum.texitcoin.org:50002 2>/dev/null | head -1
```
