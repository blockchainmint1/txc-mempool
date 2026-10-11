// Omni-Layer token accounting for TEXITcoin.
//
// Trails the main address indexer: for every block the main indexer has
// ingested, we re-read it from the node, decode "omni" OP_RETURN payloads
// (Class C), work out sender / reference addresses the way Omni Core does,
// validate against balances we've built so far, and record the effects in a
// ledger so we can roll back cleanly on reorgs.
//
// Supported: simple send (0), send-all (4), send-to-many (7), fixed (50),
// crowdsale-create (51, property only), managed (54), grant (55),
// revoke (56), close crowdsale (53), change issuer (70).
// Not supported (recorded as "unsupported", no balance effect): DEx/MetaDEx
// trades, crowdsale purchases, freeze/unfreeze, send-to-owners.

import { db, getTipHeight, getBlockHashAt } from "./db.js";
import { getBlockHash, getBlockVerbose, voutAddress, txcToSats, type RpcTx } from "./rpc.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS omni_properties (
    id          INTEGER PRIMARY KEY,
    ecosystem   INTEGER NOT NULL,
    divisible   INTEGER NOT NULL,
    managed     INTEGER NOT NULL,
    name        TEXT NOT NULL,
    category    TEXT, subcategory TEXT, url TEXT, data TEXT,
    issuer      TEXT NOT NULL,
    create_txid TEXT NOT NULL,
    height      INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS omni_balances (
    address     TEXT NOT NULL,
    property_id INTEGER NOT NULL,
    balance     TEXT NOT NULL,           -- base units as decimal string (bigint)
    PRIMARY KEY (address, property_id)
  );
  CREATE INDEX IF NOT EXISTS idx_omni_bal_prop ON omni_balances(property_id);
  CREATE TABLE IF NOT EXISTS omni_ledger (
    height      INTEGER NOT NULL,
    txid        TEXT NOT NULL,
    address     TEXT NOT NULL,
    property_id INTEGER NOT NULL,
    delta       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_omni_ledger_h ON omni_ledger(height);
  CREATE TABLE IF NOT EXISTS omni_issuer_changes (
    height INTEGER NOT NULL, property_id INTEGER NOT NULL, old_issuer TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS omni_txs (
    txid      TEXT PRIMARY KEY,
    height    INTEGER NOT NULL,
    type      INTEGER NOT NULL,
    sender    TEXT,
    reference TEXT,
    valid     INTEGER NOT NULL,
    reason    TEXT,
    detail    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_omni_txs_h ON omni_txs(height);
  CREATE TABLE IF NOT EXISTS omni_tx_addresses (
    address TEXT NOT NULL, txid TEXT NOT NULL, height INTEGER NOT NULL,
    PRIMARY KEY (address, txid)
  );
`);

const META_KEY = "omni_height";
const START = Number(process.env.OMNI_START_HEIGHT ?? 0);

// Bump whenever the decode/validity rules change in a way that makes existing
// scanned data wrong. On startup, a mismatch wipes all omni tables and the
// scanner rebuilds from START.
const SCAN_VERSION = "5";
{
  const v = db.prepare("SELECT value FROM meta WHERE key = 'omni_version'").get() as { value: string } | undefined;
  if (v?.value !== SCAN_VERSION) {
    for (const t of ["omni_balances", "omni_ledger", "omni_properties", "omni_issuer_changes", "omni_txs", "omni_tx_addresses"]) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
    db.prepare("DELETE FROM meta WHERE key = ?").run(META_KEY);
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('omni_version', ?)").run(SCAN_VERSION);
    console.log(`[omni] scan version ${SCAN_VERSION}: wiped omni tables, rescanning from ${START}`);
  }
}

export function getOmniHeight(): number {
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(META_KEY) as { value: string } | undefined;
  return r ? Number(r.value) : START - 1;
}
const setOmniHeight = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");

// ---------- payload decode ----------
function hexToBytes(h: string): Uint8Array {
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16);
  return o;
}
function opReturnPayload(hex: string): Uint8Array | null {
  if (!/^6a/i.test(hex)) return null;
  const b = hexToBytes(hex);
  let i = 1;
  const op = b[i++];
  let len: number;
  if (op <= 0x4b) len = op;
  else if (op === 0x4c) len = b[i++];
  else if (op === 0x4d) { len = b[i] | (b[i + 1] << 8); i += 2; }
  else return null;
  return b.slice(i, i + len);
}
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number) => b[o] * 2 ** 24 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u64 = (b: Uint8Array, o: number) => (BigInt(u32(b, o)) << 32n) | BigInt(u32(b, o + 4));
function cstr(b: Uint8Array, o: number) {
  let e = o;
  while (e < b.length && b[e] !== 0) e++;
  return { s: new TextDecoder().decode(b.slice(o, e)), c: Math.min(e + 1, b.length) };
}
function readCreate(b: Uint8Array) {
  let i = 0;
  const ecosystem = b[i++];
  const propertyType = u16(b, i); i += 2;
  i += 4; // previous property id
  const cat = cstr(b, i); i = cat.c;
  const sub = cstr(b, i); i = sub.c;
  const name = cstr(b, i); i = name.c;
  const url = cstr(b, i); i = url.c;
  const data = cstr(b, i); i = data.c;
  return { ecosystem, propertyType, category: cat.s, subcategory: sub.s, name: name.s, url: url.s, data: data.s, cursor: i };
}

// ---------- state helpers ----------
const getBal = db.prepare("SELECT balance FROM omni_balances WHERE address = ? AND property_id = ?");
const putBal = db.prepare("INSERT OR REPLACE INTO omni_balances(address, property_id, balance) VALUES (?, ?, ?)");
const delBal = db.prepare("DELETE FROM omni_balances WHERE address = ? AND property_id = ?");
const insLedger = db.prepare("INSERT INTO omni_ledger(height, txid, address, property_id, delta) VALUES (?, ?, ?, ?, ?)");
const getProp = db.prepare("SELECT * FROM omni_properties WHERE id = ?");
const maxPropInEco = db.prepare("SELECT MAX(id) AS m FROM omni_properties WHERE ecosystem = ?");
const insProp = db.prepare(`INSERT OR REPLACE INTO omni_properties
  (id, ecosystem, divisible, managed, name, category, subcategory, url, data, issuer, create_txid, height)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
const insTx = db.prepare(`INSERT OR REPLACE INTO omni_txs(txid, height, type, sender, reference, valid, reason, detail)
  VALUES (?,?,?,?,?,?,?,?)`);
const insTxAddr = db.prepare("INSERT OR IGNORE INTO omni_tx_addresses(address, txid, height) VALUES (?,?,?)");
const getPrevOut = db.prepare("SELECT address, value FROM outputs WHERE txid = ? AND vout = ?");
const balancesOfInEco = db.prepare(
  "SELECT b.property_id, b.balance FROM omni_balances b JOIN omni_properties p ON p.id = b.property_id WHERE b.address = ? AND p.ecosystem = ?",
);

function balance(addr: string, pid: number): bigint {
  const r = getBal.get(addr, pid) as { balance: string } | undefined;
  return r ? BigInt(r.balance) : 0n;
}
function credit(height: number, txid: string, addr: string, pid: number, delta: bigint) {
  if (delta === 0n) return;
  const nb = balance(addr, pid) + delta;
  if (nb === 0n) delBal.run(addr, pid); else putBal.run(addr, pid, nb.toString());
  insLedger.run(height, txid, addr, pid, delta.toString());
}
function nextPropertyId(eco: number): number {
  const m = (maxPropInEco.get(eco) as { m: number | null }).m;
  const base = eco === 2 ? 2147483651 : 3;
  return m == null ? base : Math.max(base, m + 1);
}

// ---------- per-tx processing ----------
type Result = { type: number; valid: boolean; reason?: string; detail?: unknown; touched: string[] };

function processTx(tx: RpcTx, height: number): void {
  let payload: Uint8Array | null = null;
  for (const v of tx.vout) {
    const p = opReturnPayload(v.scriptPubKey.hex || "");
    if (p && p.length >= 8 && p[0] === 0x6f && p[1] === 0x6d && p[2] === 0x6e && p[3] === 0x69) { payload = p; break; }
  }
  if (!payload) return;

  // Sender = address of the FIRST input (Omni Core / tokens.texitcoin.org rule).
  // The old "largest contributing input" rule misattributed sends whenever a
  // wallet topped up fees from a bigger UTXO at another address.
  let sender: string | null = null;
  const vi0 = tx.vin[0];
  if (vi0?.txid && vi0.vout !== undefined) {
    const prev = getPrevOut.get(vi0.txid, vi0.vout) as { address: string | null; value: number } | undefined;
    sender = prev?.address ?? null;
  }

  // Reference = last addressed output not paying the sender; else last addressed output.
  // Omni Core only treats legacy outputs (P2PKH / P2SH) as reference candidates —
  // segwit (txc1…) outputs are ignored. Counting them misdirected e.g. self-sends
  // that carried a small txc1 dust output.
  const addressed = tx.vout
    .filter((v) => v.scriptPubKey.type === "pubkeyhash" || v.scriptPubKey.type === "scripthash")
    .map((v) => ({ n: v.n, addr: voutAddress(v), sats: txcToSats(v.value) }))
    .filter((x) => x.addr);
  const nonSender = addressed.filter((x) => x.addr !== sender);
  const reference = (nonSender.at(-1) ?? addressed.at(-1))?.addr ?? null;

  const type = u16(payload, 6);
  const body = payload.slice(8);
  let r: Result;
  try {
    r = sender ? apply(type, body, sender, reference, tx, height) : { type, valid: false, reason: "no sender", touched: [] };
  } catch (e) {
    r = { type, valid: false, reason: `decode error: ${(e as Error).message}`, touched: [] };
  }
  insTx.run(tx.txid, height, type, sender, reference, r.valid ? 1 : 0, r.reason ?? null, r.detail ? JSON.stringify(r.detail, (_k, v) => typeof v === "bigint" ? v.toString() : v) : null);
  for (const a of new Set([sender, reference, ...r.touched].filter(Boolean) as string[])) insTxAddr.run(a, tx.txid, height);
}

function apply(type: number, b: Uint8Array, sender: string, reference: string | null, tx: RpcTx, height: number): Result {
  const txid = tx.txid;
  switch (type) {
    case 0: { // simple send
      const pid = u32(b, 0); const amt = u64(b, 4);
      if (!getProp.get(pid)) return { type, valid: false, reason: "unknown property", touched: [] };
      if (!reference) return { type, valid: false, reason: "no reference", touched: [] };
      if (amt <= 0n || balance(sender, pid) < amt) return { type, valid: false, reason: "insufficient balance", detail: { property_id: pid, amount: amt }, touched: [reference] };
      credit(height, txid, sender, pid, -amt); credit(height, txid, reference, pid, amt);
      return { type, valid: true, detail: { property_id: pid, amount: amt, to: reference }, touched: [reference] };
    }
    case 4: { // send all (ecosystem)
      const eco = b[0] ?? 1;
      if (!reference) return { type, valid: false, reason: "no reference", touched: [] };
      const rows = balancesOfInEco.all(sender, eco) as Array<{ property_id: number; balance: string }>;
      if (!rows.length) return { type, valid: false, reason: "nothing to send", touched: [] };
      for (const row of rows) { const a = BigInt(row.balance); credit(height, txid, sender, row.property_id, -a); credit(height, txid, reference, row.property_id, a); }
      return { type, valid: true, detail: { ecosystem: eco, to: reference }, touched: [reference] };
    }
    case 7: { // send to many: u32 pid, u8 count, [u8 vout, u64 amount]*
      const pid = u32(b, 0); const count = b[4];
      const outs: Array<{ to: string; amount: bigint }> = [];
      let total = 0n;
      for (let i = 0; i < count; i++) {
        const o = 5 + i * 9;
        const n = b[o]; const amt = u64(b, o + 1);
        const v = tx.vout.find((x) => x.n === n);
        const to = v ? voutAddress(v) : null;
        if (!to) return { type, valid: false, reason: `output ${n} has no address`, touched: [] };
        outs.push({ to, amount: amt }); total += amt;
      }
      const touched = outs.map((o) => o.to);
      if (!getProp.get(pid)) return { type, valid: false, reason: "unknown property", touched };
      if (total <= 0n || balance(sender, pid) < total) return { type, valid: false, reason: "insufficient balance", detail: { property_id: pid, outputs: outs }, touched };
      credit(height, txid, sender, pid, -total);
      for (const o of outs) credit(height, txid, o.to, pid, o.amount);
      return { type, valid: true, detail: { property_id: pid, outputs: outs }, touched };
    }
    case 50: case 51: case 54: { // create fixed / crowdsale / managed
      const c = readCreate(b);
      // Omni Core validity rules: ecosystem must be 1 (main) or 2 (test),
      // property type must be 1 (indivisible) or 2 (divisible), and the name
      // must be non-empty. This chain allows duplicate names (e.g. two
      // CryptoPOP, two phxPOP), so no duplicate-name check here.
      // Invalid creations consume NO property id.
      if (c.ecosystem !== 1 && c.ecosystem !== 2)
        return { type, valid: false, reason: "invalid ecosystem", touched: [] };
      if (c.propertyType !== 1 && c.propertyType !== 2)
        return { type, valid: false, reason: "invalid property type", touched: [] };
      if (!c.name)
        return { type, valid: false, reason: "empty name", touched: [] };
      const eco = c.ecosystem;
      const pid = nextPropertyId(eco);
      insProp.run(pid, eco, c.propertyType === 2 ? 1 : 0, type === 54 ? 1 : 0, c.name, c.category, c.subcategory, c.url, c.data, sender, txid, height);
      if (type === 50) credit(height, txid, sender, pid, u64(b, c.cursor));
      return { type, valid: true, detail: { property_id: pid, name: c.name, crowdsale: type === 51 }, touched: [] };
    }
    case 55: case 56: { // grant / revoke
      const pid = u32(b, 0); const amt = u64(b, 4);
      const p = getProp.get(pid) as { issuer: string; managed: number } | undefined;
      if (!p || !p.managed) return { type, valid: false, reason: "not a managed property", touched: [] };
      if (type === 55) {
        if (p.issuer !== sender) return { type, valid: false, reason: "sender is not issuer", touched: [] };
        const to = reference ?? sender;
        credit(height, txid, to, pid, amt);
        return { type, valid: true, detail: { property_id: pid, amount: amt, to }, touched: [to] };
      }
      if (balance(sender, pid) < amt) return { type, valid: false, reason: "insufficient balance", touched: [] };
      credit(height, txid, sender, pid, -amt);
      return { type, valid: true, detail: { property_id: pid, amount: amt }, touched: [] };
    }
    case 70: { // change issuer
      const pid = u32(b, 0);
      const p = getProp.get(pid) as { issuer: string } | undefined;
      if (!p || p.issuer !== sender || !reference) return { type, valid: false, reason: "not issuer", touched: [] };
      db.prepare("INSERT INTO omni_issuer_changes(height, property_id, old_issuer) VALUES (?,?,?)").run(height, pid, p.issuer);
      db.prepare("UPDATE omni_properties SET issuer = ? WHERE id = ?").run(reference, pid);
      return { type, valid: true, detail: { property_id: pid, new_issuer: reference }, touched: [reference] };
    }
    case 53:
      return { type, valid: true, touched: [] };
    default:
      return { type, valid: false, reason: "unsupported type", touched: [] };
  }
}

// ---------- block loop ----------
const ingestOmniBlock = db.transaction((txs: RpcTx[], height: number) => {
  for (const tx of txs) processTx(tx, height);
  setOmniHeight.run(META_KEY, String(height));
});

export const rollbackOmni = db.transaction((height: number) => {
  if (getOmniHeight() < height) return;
  const rows = db.prepare("SELECT address, property_id, delta FROM omni_ledger WHERE height >= ?").all(height) as Array<{ address: string; property_id: number; delta: string }>;
  for (const r of rows) {
    const nb = balance(r.address, r.property_id) - BigInt(r.delta);
    if (nb === 0n) delBal.run(r.address, r.property_id); else putBal.run(r.address, r.property_id, nb.toString());
  }
  const ic = db.prepare("SELECT property_id, old_issuer FROM omni_issuer_changes WHERE height >= ? ORDER BY rowid DESC").all(height) as Array<{ property_id: number; old_issuer: string }>;
  for (const c of ic) db.prepare("UPDATE omni_properties SET issuer = ? WHERE id = ?").run(c.old_issuer, c.property_id);
  for (const t of ["omni_ledger", "omni_issuer_changes", "omni_txs", "omni_tx_addresses", "omni_properties"]) {
    db.prepare(`DELETE FROM ${t} WHERE height >= ?`).run(height);
  }
  setOmniHeight.run(META_KEY, String(height - 1));
});

async function omniSyncOnce(): Promise<void> {
  const target = getTipHeight();
  let h = getOmniHeight() + 1;
  while (h <= target) {
    // Use the hash the main indexer stored so we stay on the same chain.
    const hash = getBlockHashAt(h) ?? (await getBlockHash(h));
    const block = await getBlockVerbose(hash);
    ingestOmniBlock(block.tx, h);
    if (h % 1000 === 0) console.log(`[omni] scanned ${h} / ${target}`);
    h++;
  }
}

export function runOmniLoop(): void {
  (async () => {
    for (;;) {
      try { await omniSyncOnce(); } catch (e) { console.error("[omni] sync error:", (e as Error).message); }
      await new Promise((r) => setTimeout(r, 5_000));
    }
  })();
}

// ---------- read helpers for HTTP ----------
type PropRow = { id: number; ecosystem: number; divisible: number; managed: number; name: string; category: string; subcategory: string; url: string; data: string; issuer: string; create_txid: string; height: number };
export function fmtAmount(raw: string, divisible: boolean): string {
  if (!divisible) return raw;
  const neg = raw.startsWith("-"); const s = (neg ? raw.slice(1) : raw).padStart(9, "0");
  const out = `${s.slice(0, -8)}.${s.slice(-8)}`.replace(/\.?0+$/, "");
  return (neg ? "-" : "") + out;
}
export function addressTokens(addr: string) {
  const rows = db.prepare(`SELECT b.property_id, b.balance, p.name, p.divisible, p.ecosystem
    FROM omni_balances b LEFT JOIN omni_properties p ON p.id = b.property_id
    WHERE b.address = ? ORDER BY b.property_id`).all(addr) as Array<{ property_id: number; balance: string; name: string | null; divisible: number | null; ecosystem: number | null }>;
  return rows.map((r) => ({
    property_id: r.property_id,
    name: r.name ?? `Property #${r.property_id}`,
    divisible: !!r.divisible,
    ecosystem: r.ecosystem,
    balance_raw: r.balance,
    balance: fmtAmount(r.balance, !!r.divisible),
  }));
}
export function addressOmniTxs(addr: string, limit = 50) {
  return (db.prepare(`SELECT t.* FROM omni_tx_addresses a JOIN omni_txs t ON t.txid = a.txid
    WHERE a.address = ? ORDER BY a.height DESC LIMIT ?`).all(addr, limit) as Array<{ detail: string | null }>)
    .map((t) => ({ ...t, detail: t.detail ? JSON.parse(t.detail) : null }));
}
export function listProperties() {
  return (db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM omni_balances b WHERE b.property_id = p.id) AS holders
    FROM omni_properties p ORDER BY p.id`).all() as Array<PropRow & { holders: number }>)
    .map((p) => ({ ...p, divisible: !!p.divisible, managed: !!p.managed }));
}
export function propertyHolders(pid: number, limit = 100) {
  const p = getProp.get(pid) as PropRow | undefined;
  if (!p) return null;
  const rows = db.prepare("SELECT address, balance FROM omni_balances WHERE property_id = ?").all(pid) as Array<{ address: string; balance: string }>;
  rows.sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : BigInt(b.balance) < BigInt(a.balance) ? -1 : 0));
  return {
    property: { ...p, divisible: !!p.divisible, managed: !!p.managed },
    holders: rows.length,
    top: rows.slice(0, limit).map((r) => ({ address: r.address, balance_raw: r.balance, balance: fmtAmount(r.balance, !!p.divisible) })),
  };
}
export function omniStatus() {
  return { omni_height: getOmniHeight(), indexed_tip: getTipHeight(), synced: getOmniHeight() >= getTipHeight() };
}
