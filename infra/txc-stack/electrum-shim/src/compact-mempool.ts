export interface CompactTx {
  vin: { txid: string; vout: number }[];
  vout: { n: number; value: number; addresses: string[] }[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Retain only fields used for pending balances and spent-outpoint detection. */
export function compactTx(tx: Record<string, unknown>): CompactTx {
  return {
    vin: (Array.isArray(tx.vin) ? tx.vin : []).flatMap(value => {
      const input = record(value);
      return typeof input.txid === "string" && typeof input.vout === "number"
        ? [{ txid: input.txid, vout: input.vout }] : [];
    }),
    vout: (Array.isArray(tx.vout) ? tx.vout : []).map(value => {
      const output = record(value);
      const spk = record(output.scriptPubKey);
      const amount = Number(output.value ?? 0);
      return {
        n: Number(output.n ?? 0),
        value: Number.isFinite(amount) ? amount : 0,
        addresses: typeof spk.address === "string" ? [spk.address]
          : Array.isArray(spk.addresses) ? spk.addresses.filter((a): a is string => typeof a === "string") : [],
      };
    }),
  };
}