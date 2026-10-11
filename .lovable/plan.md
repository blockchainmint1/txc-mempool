# Plan: Support Omni "send-to-many" (bulk payments) on mempool.texitcoin.org

## Background
Bulk token payments (Omni "send to many", e.g. Thomas's 4,000 TSD payment) are now switched on by the network. Our indexer currently ignores them, so recipients show no balance and the transaction shows as "unknown". The old token explorer and wallets already count them.

## What we'll build

### 1. Indexer: decode send-to-many transactions
- In `infra/txc-stack/indexer/src/omni.ts`, add decoding for the send-to-many payload: sender (first input address, per the already-deployed v4 sender rule), property ID, and the list of (recipient, amount) pairs.
- Credit each recipient, debit the sender for the total, and record one ledger row per recipient so each address's token history shows its own entry.
- Insufficient-balance sends are marked invalid (same as simple sends) — sender keeps the tokens.

### 2. Activation height
- Bulk sends only count from the network's switch-on block onward. Any bulk send before that height stays invalid (tokens never moved). Need the activation block height from HME Core to bake in as a constant.

### 3. Transaction page display
- Show send-to-many transactions as "Token Send to Many" with the full recipient list and amounts, instead of "unknown".

### 4. Rebuild & verify
- Bump scan version to force a full rescan, deploy to the box (copy file + `docker compose up -d --build indexer`), wait for rescan (~1 hour).
- Verify: Thomas's address shows 4,000 TSD; the bulk transaction `ba2c3e9a…` lists all recipients; balances match the old token explorer for sampled addresses.

## Technical notes
- Sender rule: first input address (already live in scan v4).
- Balances stored as BigInt; divisible amounts use 8 decimals.
- Reorg handling: ledger rows are rolled back by height, same as existing sends.

## Open item
- Activation block height for send-to-many (from HME Core). If unknown, we can detect it from the first valid on-chain bulk send, but an explicit height is safer.
