// TEXITcoin network constants + mempool/Esplora API endpoints.
// The upstream is a mempool.space backend pointed at a TXC full node.
export const TXC_NETWORK = {
  ticker: "TXC",
  name: "TEXITcoin",
  pubKeyHash: 0x42, // T...
  scriptHash: 0x32,
  wif: 0xc2,
  decimals: 8,
  satsPerCoin: 100_000_000,
  blockTimeSec: 180, // 3 min target
  addressPrefix: "T",
} as const;

export const TXC_API_BASE = "https://mempool.texitcoin.org/api";
export const TXC_WS_URL = "wss://mempool.texitcoin.org/api/v1/ws";
export const TXC_EXPLORER_BASE = "https://mempool.texitcoin.org";

// External links — opening a tx/address on the canonical upstream explorer
// is useful when the user wants to deep-link to the source-of-truth UI.
export const upstreamTxUrl = (txid: string) => `${TXC_EXPLORER_BASE}/tx/${txid}`;
export const upstreamAddrUrl = (addr: string) => `${TXC_EXPLORER_BASE}/address/${addr}`;
export const upstreamBlockUrl = (hash: string) => `${TXC_EXPLORER_BASE}/block/${hash}`;
