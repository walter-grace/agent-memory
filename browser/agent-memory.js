"use client";
// Agent Infinite Memory browser SDK. Same on-chain contract, event protocol, and encryption as
// the Node backends (node/onchain.mjs) and the hosted MCP server, so a memory written by an agent
// through any surface is readable here and vice versa.
//
// PRIVATE BY DEFAULT: each checkpoint is AES-256-GCM sealed with a key derived from the wallet's
// signature over a fixed message (personal_sign then keccak then AES key). ECDSA signatures are
// deterministic (RFC 6979), so the same wallet always derives the same key: no key to store, and
// on-chain observers see only random bytes. Reads walk the checkpoint chain backwards one block at
// a time (no indexer) and verify the keccak hash chain.
import { keccak256, encodePacked, bytesToHex, hexToBytes } from "viem";
import { RH_RPC_URLS, rpcCall } from "./rpc-client";
import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";

export const MEM_ADDR = "0x881a9f7ed58b7655c3c04bb2f9ef2cffd233a5ef";
export const MEM_CHAIN_HEX = "0x1237";
// Key-derivation message. v2 is domain-separated and self-warning so a single blind phished
// signature is not silently reusable, and versioned so it can rotate. Writers seal with the v2 key;
// readers try v2 then fall back to the v1 message for blobs written before this change. The string
// is byte-identical across every surface (browser SDK, Node, hosted MCP) — a portable cross-surface
// key cannot bind to a web origin, so the warning line + version are the mitigation, not origin-binding.
const MEM_KEY_MSG = `Hero Run Agent Memory key v2\nOnly sign this on herorunai.com. It derives the private key to your agent memory. Never sign it on any other site.\nContract: ${MEM_ADDR}\nChain: 4663`;
const MEM_KEY_MSG_V1 = `Hero Agent Memory encryption key v1\nContract: ${MEM_ADDR}\nChain: 4663`;

// ---- 4-byte selectors + minimal encoders (no ABI lib needed for the writes) ----
const SEL = { mint: "0x6a627842" /* mint(string) is different; compute below */ };
// keccak selectors computed once:
//  mint(string)                 -> 0x... ; checkpoint(uint256,bytes) ; headOf(uint256) ; labelOf(uint256) ; ownerOf(uint256)
const S_MINT = keccak256(strToU8("mint(string)")).slice(0, 10);
const S_CHECKPOINT = keccak256(strToU8("checkpoint(uint256,bytes)")).slice(0, 10);
const S_HEADOF = keccak256(strToU8("headOf(uint256)")).slice(0, 10);
const S_LABELOF = keccak256(strToU8("labelOf(uint256)")).slice(0, 10);
const S_OWNEROF = keccak256(strToU8("ownerOf(uint256)")).slice(0, 10);
// Checkpoint(uint256,uint64,uint64,uint64,bytes32,bytes32,bytes) & AgentMinted(uint256,address,string)
const T_CHECKPOINT = keccak256(strToU8("Checkpoint(uint256,uint64,uint64,uint64,bytes32,bytes32,bytes)"));
const T_MINTED = keccak256(strToU8("AgentMinted(uint256,address,string)"));

const pad = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const u = (n) => pad(BigInt(n).toString(16));
const addr32 = (a) => pad(a.toLowerCase());

// encode a dynamic bytes/string arg group given head offset base
function encBytes(bytesHex) {
  const raw = bytesHex.replace(/^0x/, "");
  const len = raw.length / 2;
  const padded = raw + "0".repeat((64 - (raw.length % 64)) % 64);
  return { len, hex: u(len) + padded };
}

// ---- reads via JSON-RPC eth_call / eth_getLogs (RH RPC list with Alchemy fallback) ----
async function ethCall(data) {
  return rpcCall(RH_RPC_URLS, "eth_call", [{ to: MEM_ADDR, data }, "latest"]);
}

export async function headOf(agentId) {
  const res = await ethCall(S_HEADOF + u(agentId));
  const b = res.replace(/^0x/, "");
  return {
    hash: "0x" + b.slice(0, 64),
    count: Number(BigInt("0x" + b.slice(64, 128))),
    lastBlock: Number(BigInt("0x" + b.slice(128, 192))),
    era: Number(BigInt("0x" + b.slice(192, 256))),
  };
}
export async function ownerOf(agentId) {
  try { const r = await ethCall(S_OWNEROF + u(agentId)); return "0x" + r.slice(-40); } catch { return null; }
}
export async function labelOf(agentId) {
  try {
    const r = await ethCall(S_LABELOF + u(agentId)).then((x) => x.replace(/^0x/, ""));
    const len = Number(BigInt("0x" + r.slice(64, 128)));
    return strFromU8(hexToBytes("0x" + r.slice(128, 128 + len * 2)));
  } catch { return ""; }
}

// ---- wallet-derived encryption key (cached per session) ----
async function importKeyFromSig(sig) {
  return crypto.subtle.importKey("raw", hexToBytes(keccak256(sig)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
let _key = null, _keyAddr = null;          // v2 key (used for all writes)
let _keyV1 = null, _keyV1Addr = null;      // v1 key, derived lazily only when an old blob is met
async function deriveKey(w) {
  if (_key && _keyAddr === w.account) return _key;
  const sig = await w.signMessage(MEM_KEY_MSG); // personal_sign via the connected wallet
  // A2: smart-account / MPC wallets can return a non-deterministic personal_sign, which would derive
  // a different key every session and make the owner see their own memory as "sealed". Detect it once
  // at onboarding by signing twice and comparing; refuse to cache/use a key we cannot reproduce.
  const sig2 = await w.signMessage(MEM_KEY_MSG);
  if (sig !== sig2) throw new Error("This wallet produced non-deterministic signatures, so encrypted memory cannot be re-read across sessions. Use a standard EOA wallet, or write public memories only.");
  _key = await importKeyFromSig(sig);
  _keyAddr = w.account;
  return _key;
}
async function deriveKeyV1(w) {
  if (_keyV1 && _keyV1Addr === w.account) return _keyV1;
  const sig = await w.signMessage(MEM_KEY_MSG_V1);
  _keyV1 = await importKeyFromSig(sig);
  _keyV1Addr = w.account;
  return _keyV1;
}
async function seal(w, gz) {
  const key = await deriveKey(w);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, gz));
  const out = new Uint8Array(13 + ct.length);
  out[0] = 2; out.set(iv, 1); out.set(ct, 13);
  return out;
}
async function open(w, blob) {
  if (blob[0] === 0) return blob.subarray(1); // plaintext
  if (blob[0] === 2) {
    const iv = blob.subarray(1, 13), ct = blob.subarray(13);
    const key = await deriveKey(w);
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
    } catch {
      // Legacy blob sealed with the v1 key message: derive v1 lazily and retry once. Only wallets
      // with pre-v2 blobs pay this second signature, and only when such a blob is encountered.
      const keyV1 = await deriveKeyV1(w);
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, keyV1, ct));
    }
  }
  throw new Error("sealed"); // passphrase-encrypted or unknown marker
}

// ---- writes (through the connected wallet, non-custodial) ----
export async function mintAgent(w, label) {
  await w.ensureChain(MEM_CHAIN_HEX);
  const lb = encBytes(bytesToHex(strToU8(label)));
  const data = S_MINT + u(32) + lb.hex; // one dynamic arg at offset 0x20
  const tx = await w.sendPreparedTx({ to: MEM_ADDR, data });
  return tx;
}

// Low-level: write a checkpoint carrying arbitrary entries [{role,text}]. checkpoint() below is the
// single-note convenience wrapper; the chat demo passes a whole exchange (user + agent turns).
export async function checkpointEntries(w, agentId, entries, { isPublic = false } = {}) {
  await w.ensureChain(MEM_CHAIN_HEX);
  const json = JSON.stringify({ v: 1, at: new Date().toISOString(), entries });
  const gz = gzipSync(strToU8(json), { level: 9 });
  const blob = isPublic ? new Uint8Array([0, ...gz]) : await seal(w, gz);
  // checkpoint(uint256 agentId, bytes data): head = agentId(32) + offset(0x40); tail = bytes
  const eb = encBytes(bytesToHex(blob));
  const data = S_CHECKPOINT + u(agentId) + u(64) + eb.hex;
  return w.sendPreparedTx({ to: MEM_ADDR, data });
}

export async function checkpoint(w, agentId, note, opts = {}) {
  return checkpointEntries(w, agentId, [{ role: "agent", text: String(note) }], opts);
}

// ---- recall: walk backwards, verify hash chain, decrypt what we can ----
export async function recall(w, agentId, { maxCheckpoints = 200 } = {}) {
  const head = await headOf(agentId);
  if (head.count === 0) return { entries: [], checkpoints: 0, verified: true, era: head.era };
  // When count exceeds the cap we deliberately walk only the most recent maxCheckpoints. That window
  // does not begin at genesis, so it cannot be verified against head from a zero seed — this is a
  // partial (not tampered) view.
  const truncated = head.count > maxCheckpoints;
  const eraTopic = "0x" + u(head.era);
  const agentTopic = "0x" + u(agentId);
  const raw = [];
  let block = head.lastBlock;
  for (let i = 0; i < Math.min(head.count, maxCheckpoints) && block > 0; i++) {
    const hexBlk = "0x" + block.toString(16);
    let logs = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        logs = await rpcCall(RH_RPC_URLS, "eth_getLogs", [{ address: MEM_ADDR, topics: [T_CHECKPOINT, agentTopic, eraTopic], fromBlock: hexBlk, toBlock: hexBlk }]);
      } catch { logs = []; }
      if (logs.length) break;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    if (!logs.length) throw new Error(`Missing checkpoint at RH block ${block} — RPC gap.`);
    logs.sort((a, b) => parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
    raw.unshift(...logs.map(decodeCheckpoint));
    block = raw[0].prevBlock;
  }
  // verify keccak chain over the walked window. For a full walk we seed from zero and later compare
  // the running hash to the contract head. For a truncated walk we seed with the earliest walked
  // checkpoint's on-chain prevHash so the per-link keccak check still validates the window's internal
  // integrity, but we do NOT compare to head from zero (that would falsely read as tamper).
  let h = truncated ? raw[0].prevHash : "0x" + "0".repeat(64);
  for (const c of raw) {
    if (keccak256(encodePacked(["bytes32", "bytes"], [h, c.data])) !== c.newHash) throw new Error(`Hash chain mismatch at seq ${c.seq}.`);
    h = c.newHash;
  }
  const entries = [];
  for (const c of raw) {
    const blob = hexToBytes(c.data);
    try {
      const gz = await open(w, blob);
      const doc = JSON.parse(strFromU8(gunzipSync(gz)));
      // Envelope-tolerant: {v, at, entries} is canonical; pre-envelope Node blobs sealed a bare
      // entries array. Both decrypt fine; accept both shapes.
      const list = Array.isArray(doc) ? doc : (doc.entries || []);
      for (const e of list) entries.push({ ...e, seq: c.seq, at: Array.isArray(doc) ? undefined : doc.at });
    } catch { entries.push({ role: "sealed", text: `[sealed memory · seq ${c.seq} · ${blob.length}B — only the owner wallet can read this]`, seq: c.seq }); }
  }
  // A truncated walk is a partial view, never a tamper signal: verified:false with a reason, no throw.
  const out = { entries, checkpoints: raw.length, verified: truncated ? false : h === head.hash, era: head.era };
  if (truncated) out.reason = `partial (last ${raw.length} of ${head.count})`;
  return out;
}

// decode a non-indexed Checkpoint log: data = seq(32)+prevBlock(32)+prevHash(32)+newHash(32)+offset(32)+len(32)+bytes
function decodeCheckpoint(log) {
  const d = log.data.replace(/^0x/, "");
  const seq = Number(BigInt("0x" + d.slice(0, 64)));
  const prevBlock = Number(BigInt("0x" + d.slice(64, 128)));
  const prevHash = "0x" + d.slice(128, 192);
  const newHash = "0x" + d.slice(192, 256);
  const len = Number(BigInt("0x" + d.slice(320, 384)));
  const data = "0x" + d.slice(384, 384 + len * 2);
  return { seq, prevBlock, prevHash, newHash, data };
}

// Run a text model through a gateway with a prepaid API key (no per-message wallet popups: chat
// needs to be fluid; the memory WRITE is what's wallet-signed on-chain). Returns the model's reply.
// `messages` is [{role,content}] with the agent's recalled memory already folded in.
export async function askModel({ apiKey, model = "auto", messages, maxTokens = 500 }) {
  const input = messages.map((m) => `${m.role === "assistant" ? "Agent" : m.role === "system" ? "System" : "User"}: ${m.content}`).join("\n\n") + "\n\nAgent:";
  const r = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ model, input, kind: "text", maxTokens }),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || "run failed");
  return { text: (d.text || "").trim(), model: d.autoModel || d.model, hero: d.charged };
}

export async function myAgents(w) {
  const ownerTopic = "0x" + addr32(w.account);
  const logs = await rpcCall(RH_RPC_URLS, "eth_getLogs", [{ address: MEM_ADDR, topics: [T_MINTED, null, ownerTopic], fromBlock: "0x0", toBlock: "latest" }]);
  const seen = new Map();
  for (const l of logs) {
    const id = Number(BigInt(l.topics[1]));
    // AgentMinted data = label (dynamic string): offset(32)+len(32)+bytes
    const dd = l.data.replace(/^0x/, "");
    const len = Number(BigInt("0x" + dd.slice(64, 128)));
    const label = strFromU8(hexToBytes("0x" + dd.slice(128, 128 + len * 2)));
    seen.set(id, label);
  }
  const out = [];
  for (const [id, label] of seen) {
    const head = await headOf(id).catch(() => ({ count: 0, era: 0 }));
    out.push({ id, label, count: head.count, era: head.era });
  }
  return out.sort((a, b) => a.id - b.id);
}
