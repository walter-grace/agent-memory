// Security regression tests for the wallet-owned agent-memory system. Node-only, no network.
// Run: node test/security.mjs   (needs viem + fflate installed — `npm install`)
//
// Covers three verified-triage fixes:
//   A1 — v2 domain-separated key message + backward-compatible v1 read fallback
//   A2 — browser deriveKey rejects non-deterministic (smart-account/MPC) signers
//   A3 — >maxCheckpoints walks are reported as "partial", never as tamper
import { keccak256, encodePacked, toBytes, bytesToHex, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gzipSync as gzNode } from "node:zlib";
import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";
import { webcrypto } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OnchainMemory } from "../node/onchain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DESKTOP = resolve(ROOT, "..");

const MEM_ADDR = "0x881a9f7ed58b7655c3c04bb2f9ef2cffd233a5ef";
const V2 = `Hero Run Agent Memory key v2\nOnly sign this on herorunai.com — it derives the private key to your agent memory. Never sign it on any other site.\nContract: ${MEM_ADDR}\nChain: 4663`;
const V1 = `Hero Agent Memory encryption key v1\nContract: ${MEM_ADDR}\nChain: 4663`;
const TEST_PK = "0x" + "11".repeat(32);

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  PASS  ${name}`); };
const bad = (name, e) => { fail++; console.log(`  FAIL  ${name}\n        ${e?.message || e}`); };
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };

// ---------------------------------------------------------------------------
// A1 — round-trip on the Node reader (shares byte-identical derivation with the browser SDK)
// ---------------------------------------------------------------------------
console.log("A1 — v2 write/read round-trip + v1 fallback");

await t("v2 seal → v2 open decodes", async () => {
  const mem = new OnchainMemory({ agentId: 1, privateKey: TEST_PK });
  const blob = await mem._seal([{ role: "agent", text: "hello v2" }]);
  assert(blob[0] === 2, "marker should be 2");
  const entries = await mem._open(blob);
  assert(entries.length === 1 && entries[0].text === "hello v2", "v2 round-trip lost the entry");
});

await t("v1-key-sealed blob → open() falls back to v1 and decodes", async () => {
  // Craft a blob sealed with the LEGACY v1 key, exactly the way pre-v2 Node did.
  const account = privateKeyToAccount(TEST_PK);
  const sigV1 = await account.signMessage({ message: V1 });
  const keyV1 = await webcrypto.subtle.importKey("raw", toBytes(keccak256(toBytes(sigV1))), "AES-GCM", false, ["encrypt", "decrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const gz = gzNode(Buffer.from(JSON.stringify({ v: 1, at: new Date().toISOString(), entries: [{ role: "agent", text: "legacy v1 memory" }] })));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, keyV1, gz));
  const blob = Buffer.concat([Buffer.from([2]), Buffer.from(iv), Buffer.from(ct)]);

  const mem = new OnchainMemory({ agentId: 1, privateKey: TEST_PK }); // reader tries v2 first, then v1
  const entries = await mem._open(blob);
  assert(entries.length === 1 && entries[0].text === "legacy v1 memory", "v1 fallback did not decode the legacy blob");
});

await t("garbage marker-2 blob → throws cleanly (no crash)", async () => {
  const mem = new OnchainMemory({ agentId: 1, privateKey: TEST_PK });
  const blob = Buffer.concat([Buffer.from([2]), Buffer.from(webcrypto.getRandomValues(new Uint8Array(40)))]);
  let threw = false;
  try { await mem._open(blob); } catch { threw = true; }
  assert(threw, "a garbage marker-2 blob should throw, not resolve");
});

// ---------------------------------------------------------------------------
// A1 interop — the v2 message is byte-identical across every surface
// ---------------------------------------------------------------------------
console.log("A1 — cross-surface interop (v2 message byte-identical)");

await t("v2 key message identical in all 5 surfaces", async () => {
  const files = [
    resolve(ROOT, "browser/agent-memory.js"),
    resolve(ROOT, "node/onchain.mjs"),
    resolve(DESKTOP, "hero-agent/src/memory/onchain.mjs"),
    resolve(DESKTOP, "hero-foundry-web/lib/agent-memory.js"),
    resolve(DESKTOP, "hero-foundry-web/public/hero-run-mcp.mjs"),
  ];
  // The literal as it appears in source: the v2 string with the ${MEM_ADDR} placeholder unresolved.
  const literal = "Hero Run Agent Memory key v2\\nOnly sign this on herorunai.com — it derives the private key to your agent memory. Never sign it on any other site.\\nContract: ${MEM_ADDR}\\nChain: 4663";
  for (const f of files) {
    const src = await readFile(f, "utf8");
    assert(src.includes(literal), `v2 literal missing/altered in ${f}`);
    assert(src.includes(MEM_ADDR), `default MEM_ADDR (${MEM_ADDR}) missing in ${f}`);
  }
  // And the resolved runtime strings all equal V2 (same default address everywhere).
  assert(literal.replace("${MEM_ADDR}", MEM_ADDR).replace(/\\n/g, "\n") === V2, "resolved v2 string drifted");
});

// ---------------------------------------------------------------------------
// A3 — >maxCheckpoints reads are "partial", never tamper
// ---------------------------------------------------------------------------
console.log("A3 — truncated walk is partial, not tamper");

// Build a real 250-checkpoint single-era keccak chain fixture (marker-0 plaintext blobs).
function buildChain(n) {
  const chain = [];
  let prevHash = "0x" + "0".repeat(64);
  for (let i = 0; i < n; i++) {
    const gz = gzipSync(strToU8(JSON.stringify({ v: 1, at: `2026-08-02T00:00:${String(i % 60).padStart(2, "0")}Z`, entries: [{ role: "agent", text: `note ${i}` }] })), { level: 9 });
    const blob = new Uint8Array(1 + gz.length); blob[0] = 0; blob.set(gz, 1);
    const dataHex = bytesToHex(blob);
    const newHash = keccak256(encodePacked(["bytes32", "bytes"], [prevHash, dataHex]));
    chain.push({ seq: i, prevHash, newHash, data: dataHex });
    prevHash = newHash;
  }
  return { chain, headHash: prevHash };
}

// Mirror of the shipped recall() verify+decode block (browser/agent-memory.js, hero-run-mcp.mjs).
function recallEquivalent(chain, headHash, count, maxCheckpoints) {
  const truncated = count > maxCheckpoints;
  const raw = chain.slice(Math.max(0, chain.length - maxCheckpoints)); // most-recent window
  let h = truncated ? raw[0].prevHash : "0x" + "0".repeat(64);
  for (const c of raw) {
    if (keccak256(encodePacked(["bytes32", "bytes"], [h, c.data])) !== c.newHash) throw new Error(`Hash chain mismatch at seq ${c.seq}.`);
    h = c.newHash;
  }
  const entries = [];
  for (const c of raw) {
    const blob = hexToBytes(c.data);
    const doc = JSON.parse(strFromU8(gunzipSync(blob.subarray(1)))); // marker 0 → gunzip
    for (const e of (doc.entries || [])) entries.push({ ...e, seq: c.seq });
  }
  const out = { entries, checkpoints: raw.length, verified: truncated ? false : h === headHash, era: 0 };
  if (truncated) out.reason = `partial (last ${raw.length} of ${count})`;
  return out;
}

await t("250 checkpoints, cap 200 → returns entries, no throw, verified:false + partial", async () => {
  const { chain, headHash } = buildChain(250);
  const r = recallEquivalent(chain, headHash, 250, 200);
  assert(r.checkpoints === 200, `expected 200 walked, got ${r.checkpoints}`);
  assert(r.entries.length === 200, `expected 200 entries, got ${r.entries.length}`);
  assert(r.verified === false, "truncated walk must report verified:false");
  assert(r.reason === "partial (last 200 of 250)", `reason should say partial, got ${r.reason}`);
  assert(r.entries[r.entries.length - 1].text === "note 249", "window should end at the most recent note");
});

await t("old from-zero seed WOULD have false-alarmed on the same healthy chain", async () => {
  // Proves the bug was real: seeding h=0 over a truncated window mismatches the first link.
  const { chain } = buildChain(250);
  const raw = chain.slice(50);
  const h0 = "0x" + "0".repeat(64);
  const firstLinkOK = keccak256(encodePacked(["bytes32", "bytes"], [h0, raw[0].data])) === raw[0].newHash;
  assert(!firstLinkOK, "expected the from-zero seed to mismatch (that was the false tamper alarm)");
});

await t("full walk (150 ≤ cap 200) still verifies against head", async () => {
  const { chain, headHash } = buildChain(150);
  const r = recallEquivalent(chain, headHash, 150, 200);
  assert(r.checkpoints === 150 && r.entries.length === 150, "full walk lost entries");
  assert(r.verified === true, "full walk within cap must verify true");
  assert(!r.reason, "full walk should carry no partial reason");
});

await t("genuine tamper inside the window still throws", async () => {
  const { chain, headHash } = buildChain(250);
  chain[100].data = bytesToHex(new Uint8Array([0, 1, 2, 3])); // corrupt one blob, leave its newHash
  let threw = false;
  try { recallEquivalent(chain, headHash, 250, 200); } catch { threw = true; }
  assert(threw, "a real per-link mismatch must still throw");
});

// ---------------------------------------------------------------------------
// A2 — browser deriveKey rejects non-deterministic signers (import the real SDK)
// ---------------------------------------------------------------------------
console.log("A2 — browser deriveKey detects non-deterministic signers");

// The browser SDK uses an extensionless relative import ("./rpc-client") for bundlers; rewrite it to
// an explicit .js so raw Node can import the real module, then exercise it through checkpointEntries
// (the exported write path that runs seal() → deriveKey()).
const SDK_SRC = resolve(ROOT, "browser/agent-memory.js");
const TMP = resolve(ROOT, "browser/.security-test-sdk.mjs");
await t("A2 non-deterministic signer throws; deterministic signer caches", async () => {
  const src = (await readFile(SDK_SRC, "utf8")).replace(/from ["']\.\/rpc-client["']/g, 'from "./rpc-client.js"');
  await writeFile(TMP, src);
  try {
    const sdk = await import(TMP + `?t=${Date.now()}`);

    // Non-deterministic wallet: a fresh signature every personal_sign.
    let n = 0;
    const flaky = {
      account: "0xflaky000000000000000000000000000000000001",
      ensureChain: async () => {},
      signMessage: async () => "0x" + String(n++).padStart(2, "0").repeat(65),
      sendPreparedTx: async () => "0xdeadbeef",
    };
    let msg = "";
    try { await sdk.checkpointEntries(flaky, 1, [{ role: "agent", text: "x" }]); }
    catch (e) { msg = e.message; }
    assert(/non-deterministic/i.test(msg), `expected a non-deterministic error, got: ${msg || "(no throw)"}`);

    // Deterministic wallet: same signature every time. Distinct account so the module cache is clean.
    let signs = 0, sent = 0;
    const steady = {
      account: "0xsteady00000000000000000000000000000000002",
      ensureChain: async () => {},
      signMessage: async () => { signs++; return "0x" + "ab".repeat(65); },
      sendPreparedTx: async () => { sent++; return "0xfeedface"; },
    };
    const tx1 = await sdk.checkpointEntries(steady, 1, [{ role: "agent", text: "a" }]);
    assert(tx1 === "0xfeedface", "deterministic write should return the tx hash");
    assert(signs === 2, `first derivation should double-sign (A2 check); got ${signs} signs`);
    const tx2 = await sdk.checkpointEntries(steady, 1, [{ role: "agent", text: "b" }]);
    assert(tx2 === "0xfeedface", "second write should also succeed");
    assert(signs === 2, `cached key must not re-sign; got ${signs} total signs`);
    assert(sent === 2, "both writes should reach sendPreparedTx");
  } finally {
    await unlink(TMP).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
