// OP_RETURN parser for TEXITcoin / Omni-Layer payloads.
//
// Omni-Layer encodes token operations inside an OP_RETURN output. The first
// four bytes of the payload are the ASCII magic "omni" (0x6f 0x6d 0x6e 0x69).
// What follows is a big-endian binary record: u16 version, u16 type, then
// type-specific fields. We decode the common types documented in the TXC L2
// guide at cryptopop.asia/api + imaginenation.com/api.
//
// Anything else (BIP47 payment codes, plain "TXT" memos, unknown protocols)
// is returned as a generic OP_RETURN payload with raw hex + UTF-8 attempt.

import type { TxVout } from "./esplora";

export type OmniMessage =
  | { kind: "simple-send"; version: number; propertyId: number; amount: bigint }
  | { kind: "send-all"; version: number; ecosystem: number }
  | {
      kind: "create-fixed";
      version: number;
      ecosystem: number;
      propertyType: number;
      previousPropertyId: number;
      category: string;
      subcategory: string;
      name: string;
      url: string;
      data: string;
      amount: bigint;
    }
  | {
      kind: "create-managed";
      version: number;
      ecosystem: number;
      propertyType: number;
      previousPropertyId: number;
      category: string;
      subcategory: string;
      name: string;
      url: string;
      data: string;
    }
  | { kind: "grant"; version: number; propertyId: number; amount: bigint; note?: string }
  | { kind: "revoke"; version: number; propertyId: number; amount: bigint; note?: string }
  | { kind: "close-crowdsale"; version: number; propertyId: number }
  | { kind: "change-issuer"; version: number; propertyId: number }
  | { kind: "unknown-omni"; version: number; type: number; rawHex: string };

export type OpReturnDecoded =
  | { kind: "omni"; message: OmniMessage; rawHex: string }
  | { kind: "text"; text: string; rawHex: string }
  | { kind: "raw"; rawHex: string };

export function isOpReturn(vout: TxVout): boolean {
  return (
    vout.scriptpubkey_type === "op_return" ||
    vout.value === 0 && /^6a/i.test(vout.scriptpubkey || "")
  );
}

/** Extract the payload bytes from an OP_RETURN scriptpubkey (strip 0x6a + push opcode). */
export function extractOpReturnPayload(scriptHex: string): Uint8Array | null {
  if (!scriptHex || !/^6a/i.test(scriptHex)) return null;
  const bytes = hexToBytes(scriptHex);
  if (bytes.length < 2) return null;
  let i = 1; // skip OP_RETURN
  const op = bytes[i++];
  let len = 0;
  if (op <= 0x4b) {
    len = op;
  } else if (op === 0x4c) {
    len = bytes[i++];
  } else if (op === 0x4d) {
    len = bytes[i] | (bytes[i + 1] << 8);
    i += 2;
  } else if (op === 0x4e) {
    len = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    i += 4;
  } else {
    return null;
  }
  return bytes.slice(i, i + len);
}

export function decodeOpReturn(scriptHex: string): OpReturnDecoded {
  const rawHex = scriptHex;
  const payload = extractOpReturnPayload(scriptHex);
  if (!payload) return { kind: "raw", rawHex };

  // Omni magic = "omni"
  if (
    payload.length >= 8 &&
    payload[0] === 0x6f &&
    payload[1] === 0x6d &&
    payload[2] === 0x6e &&
    payload[3] === 0x69
  ) {
    const msg = decodeOmni(payload);
    return { kind: "omni", message: msg, rawHex };
  }

  // Try UTF-8 text (filter to printable)
  const text = tryUtf8(payload);
  if (text) return { kind: "text", text, rawHex };

  return { kind: "raw", rawHex };
}

function decodeOmni(p: Uint8Array): OmniMessage {
  // [0..3] "omni" magic, then u16 version, u16 type
  const version = (p[4] << 8) | p[5];
  const type = (p[6] << 8) | p[7];
  const body = p.slice(8);
  try {
    switch (type) {
      case 0: {
        // Simple Send: u32 propertyId, u64 amount
        const propertyId = readU32(body, 0);
        const amount = readU64(body, 4);
        return { kind: "simple-send", version, propertyId, amount };
      }
      case 4: {
        // Send All: u8 ecosystem
        const ecosystem = body[0] ?? 1;
        return { kind: "send-all", version, ecosystem };
      }
      case 50: {
        // Create Property Fixed
        const r = readPropertyCreate(body);
        const amount = readU64(body, r.cursor);
        return {
          kind: "create-fixed",
          version,
          ecosystem: r.ecosystem,
          propertyType: r.propertyType,
          previousPropertyId: r.previousPropertyId,
          category: r.category,
          subcategory: r.subcategory,
          name: r.name,
          url: r.url,
          data: r.data,
          amount,
        };
      }
      case 54: {
        // Create Property Managed
        const r = readPropertyCreate(body);
        return {
          kind: "create-managed",
          version,
          ecosystem: r.ecosystem,
          propertyType: r.propertyType,
          previousPropertyId: r.previousPropertyId,
          category: r.category,
          subcategory: r.subcategory,
          name: r.name,
          url: r.url,
          data: r.data,
        };
      }
      case 55: {
        // Grant tokens: u32 propertyId, u64 amount, optional memo
        const propertyId = readU32(body, 0);
        const amount = readU64(body, 4);
        const note = body.length > 12 ? tryUtf8(body.slice(12)) ?? undefined : undefined;
        return { kind: "grant", version, propertyId, amount, note };
      }
      case 56: {
        // Revoke tokens
        const propertyId = readU32(body, 0);
        const amount = readU64(body, 4);
        const note = body.length > 12 ? tryUtf8(body.slice(12)) ?? undefined : undefined;
        return { kind: "revoke", version, propertyId, amount, note };
      }
      case 53: {
        const propertyId = readU32(body, 0);
        return { kind: "close-crowdsale", version, propertyId };
      }
      case 70: {
        const propertyId = readU32(body, 0);
        return { kind: "change-issuer", version, propertyId };
      }
      default:
        return { kind: "unknown-omni", version, type, rawHex: bytesToHex(p) };
    }
  } catch {
    return { kind: "unknown-omni", version, type, rawHex: bytesToHex(p) };
  }
}

function readPropertyCreate(body: Uint8Array) {
  // u8 ecosystem, u16 propertyType, u32 previousPropertyId,
  // cstr category, cstr subcategory, cstr name, cstr url, cstr data
  let i = 0;
  const ecosystem = body[i++];
  const propertyType = (body[i] << 8) | body[i + 1];
  i += 2;
  const previousPropertyId = readU32(body, i);
  i += 4;
  const a = readCStr(body, i); i = a.cursor;
  const b = readCStr(body, i); i = b.cursor;
  const c = readCStr(body, i); i = c.cursor;
  const d = readCStr(body, i); i = d.cursor;
  const e = readCStr(body, i); i = e.cursor;
  return {
    ecosystem,
    propertyType,
    previousPropertyId,
    category: a.str,
    subcategory: b.str,
    name: c.str,
    url: d.str,
    data: e.str,
    cursor: i,
  };
}

function readU32(b: Uint8Array, o: number): number {
  return (b[o] * 2 ** 24) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}
function readU64(b: Uint8Array, o: number): bigint {
  const hi = BigInt(readU32(b, o));
  const lo = BigInt(readU32(b, o + 4));
  return (hi << 32n) | lo;
}
function readCStr(b: Uint8Array, o: number): { str: string; cursor: number } {
  let end = o;
  while (end < b.length && b[end] !== 0) end++;
  const str = new TextDecoder("utf-8", { fatal: false }).decode(b.slice(o, end));
  return { str, cursor: Math.min(end + 1, b.length) };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}
function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function tryUtf8(b: Uint8Array): string | null {
  if (b.length === 0) return null;
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(b);
    // require mostly printable
    const printable = s.replace(/[^\x20-\x7E\s]/g, "");
    if (printable.length >= s.length * 0.85 && s.trim().length > 0) return s;
  } catch {
    /* not utf-8 */
  }
  return null;
}

/** Human label for a decoded Omni message. */
export function omniLabel(m: OmniMessage): string {
  switch (m.kind) {
    case "simple-send": return `Omni Simple Send #${m.propertyId}`;
    case "send-all": return `Omni Send All (eco ${m.ecosystem})`;
    case "create-fixed": return `Omni Issuance — Fixed "${m.name}" #${m.previousPropertyId || "new"}`;
    case "create-managed": return `Omni Issuance — Managed "${m.name}"`;
    case "grant": return `Omni Grant #${m.propertyId}`;
    case "revoke": return `Omni Revoke #${m.propertyId}`;
    case "close-crowdsale": return `Omni Close Crowdsale #${m.propertyId}`;
    case "change-issuer": return `Omni Change Issuer #${m.propertyId}`;
    case "unknown-omni": return `Omni payload (v${m.version} type ${m.type})`;
  }
}
