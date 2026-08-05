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

## Health check

```bash
printf '{"id":1,"method":"server.version","params":["probe","1.4"]}\n' \
  | openssl s_client -quiet -connect electrum.texitcoin.org:50002 2>/dev/null | head -1
```
