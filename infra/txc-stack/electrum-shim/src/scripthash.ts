// Electrum addresses everything by *scripthash*: sha256(scriptPubKey) with the
// bytes reversed, hex-encoded. Our indexer stores plain addresses, so we keep a
// small reverse map (scripthash -> address) built from the address set and
// refreshed on a timer. Encoding is done here with no external deps so the
// shim image stays tiny.

import { createHash } from "node:crypto";

const TXC_P2PKH_VERSION = 0x42;
const TXC_P2SH_VERSION = 0x32;
const TXC_BECH32_HRP = "txc";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(s: string): Uint8Array | null {
  let num = 0n;
  for (const ch of s) {
    const idx = B58.indexOf(ch);
    if (idx < 0) return null;
    num = num * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function sha256(b: Uint8Array): Buffer {
  return createHash("sha256").update(b).digest();
}

function base58CheckDecode(s: string): { version: number; payload: Uint8Array } | null {
  const raw = base58Decode(s);
  if (!raw || raw.length < 5) return null;
  const body = raw.subarray(0, raw.length - 4);
  const checksum = raw.subarray(raw.length - 4);
  const want = sha256(sha256(body)).subarray(0, 4);
  for (let i = 0; i < 4; i++) if (checksum[i] !== want[i]) return null;
  return { version: body[0], payload: body.subarray(1) };
}

// ---- bech32 / bech32m ----
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function bech32Decode(addr: string): { hrp: string; data: number[] } | null {
  const lower = addr.toLowerCase();
  if (addr !== lower && addr !== addr.toUpperCase()) return null;
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos);
  const data: number[] = [];
  for (const ch of lower.slice(pos + 1)) {
    const idx = BECH32_CHARSET.indexOf(ch);
    if (idx < 0) return null;
    data.push(idx);
  }
  const chk = bech32Polymod([...bech32HrpExpand(hrp), ...data]);
  // 1 = bech32 (witness v0), 0x2bc830a3 = bech32m (witness v1+)
  if (chk !== 1 && chk !== 0x2bc830a3) return null;
  return { hrp, data: data.slice(0, data.length - 6) };
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

/** scriptPubKey bytes for a TXC address, or null when unrecognised. */
export function addressToScript(address: string): Uint8Array | null {
  if (address.toLowerCase().startsWith(TXC_BECH32_HRP + "1")) {
    const dec = bech32Decode(address);
    if (!dec || dec.hrp !== TXC_BECH32_HRP || dec.data.length < 1) return null;
    const version = dec.data[0];
    const program = convertBits(dec.data.slice(1), 5, 8, false);
    if (!program || program.length < 2 || program.length > 40) return null;
    if (version === 0 && program.length !== 20 && program.length !== 32) return null;
    const opVersion = version === 0 ? 0x00 : 0x50 + version;
    return Uint8Array.from([opVersion, program.length, ...program]);
  }

  const dec = base58CheckDecode(address);
  if (!dec || dec.payload.length !== 20) return null;
  if (dec.version === TXC_P2PKH_VERSION) {
    // OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
    return Uint8Array.from([0x76, 0xa9, 0x14, ...dec.payload, 0x88, 0xac]);
  }
  if (dec.version === TXC_P2SH_VERSION) {
    // OP_HASH160 <20> OP_EQUAL
    return Uint8Array.from([0xa9, 0x14, ...dec.payload, 0x87]);
  }
  return null;
}

/** Electrum scripthash for an address: reverse(sha256(script)) as hex. */
export function addressToScripthash(address: string): string | null {
  const script = addressToScript(address);
  if (!script) return null;
  return Buffer.from(sha256(script)).reverse().toString("hex");
}

/** Electrum status hash for a history list (sha256 of "txid:height:" joined). */
export function historyStatus(items: { tx_hash: string; height: number }[]): string | null {
  if (items.length === 0) return null;
  const s = items.map((i) => `${i.tx_hash}:${i.height}:`).join("");
  return sha256(Buffer.from(s, "utf8")).toString("hex");
}
