// On-chain memory backend: the differentiator. Memories are AES-256-GCM encrypted with a key
// derived from the agent wallet's own signature, gzip'd, and written to the Agent Memory contract on
// Robinhood Chain. On-chain observers see only random bytes; only the wallet that holds
// AGENT_PRIVATE_KEY can decrypt. Raw checkpoints are immutable leaves; the ROOT index from
// compaction is just another (marked) checkpoint. Same interface as LocalMemory.
//
// Requires: AGENT_PRIVATE_KEY (a wallet you control, funded with a little RH gas) and `viem`.
// This mirrors the browser SDK (browser/agent-memory.js), ported to Node. Reads walk the contract's
// checkpoint events; writes are one transaction each (~$0.003).
import { gzipSync, gunzipSync } from "node:zlib";
import { keccak256, toBytes, toHex, encodePacked, encodeFunctionData, createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const MEM_ADDR = process.env.HERO_MEM_ADDR || "0x881a9f7ed58b7655c3c04bb2f9ef2cffd233a5ef";
const RH_RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
// Key-derivation message. v2 is domain-separated and self-warning so a single blind phished signature
// is not silently reusable, and versioned for future rotation. Writers seal with the v2 key; readers
// try v2 then fall back to the v1 message for blobs written before this change. The v2 string is
// byte-identical across every surface (Node, browser SDK, hosted MCP) so the same wallet derives the
// same key everywhere — a portable cross-surface key cannot bind to a web origin, so the warning line
// + version are the mitigation, not origin-binding.
const KEY_MSG = `Hero Run Agent Memory key v2\nOnly sign this on herorunai.com — it derives the private key to your agent memory. Never sign it on any other site.\nContract: ${MEM_ADDR}\nChain: 4663`;
const KEY_MSG_V1 = `Hero Agent Memory encryption key v1\nContract: ${MEM_ADDR}\nChain: 4663`;
const ROOT_MARK = "root::";
const ABI = [
  { name: "checkpoint", type: "function", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [] },
  { name: "mint", type: "function", stateMutability: "nonpayable", inputs: [{ name: "label", type: "string" }], outputs: [] },
];
const rhChain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RH_RPC] } } });

export class OnchainMemory {
  constructor({ agentId, privateKey = process.env.AGENT_PRIVATE_KEY }) {
    if (!privateKey) throw new Error("On-chain memory needs AGENT_PRIVATE_KEY (a wallet with a little RH gas).");
    if (agentId == null) throw new Error("On-chain memory needs an agentId (mint one first).");
    this.agentId = BigInt(agentId);
    this.account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : "0x" + privateKey);
    this.wallet = createWalletClient({ account: this.account, chain: rhChain, transport: http(RH_RPC) });
    this.pub = createPublicClient({ chain: rhChain, transport: http(RH_RPC) });
    this._key = null;
    this._keyV1 = null;
  }
  async _cryptoKey() {
    if (this._key) return this._key;
    const sig = await this.account.signMessage({ message: KEY_MSG });
    const raw = toBytes(keccak256(toBytes(sig)));
    const { webcrypto } = await import("node:crypto");
    this._key = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    return this._key;
  }
  // v1 key, derived lazily only when a pre-v2 blob is encountered on read.
  async _cryptoKeyV1() {
    if (this._keyV1) return this._keyV1;
    const sig = await this.account.signMessage({ message: KEY_MSG_V1 });
    const raw = toBytes(keccak256(toBytes(sig)));
    const { webcrypto } = await import("node:crypto");
    this._keyV1 = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    return this._keyV1;
  }
  // Canonical blob format shared with the web SDK and the hosted MCP server, so memory written on
  // any surface is readable on every other one from the same wallet: byte 0 = marker
  // (0 = plaintext gzip, 1 = passphrase/PBKDF2, 2 = wallet-derived AES-GCM), then IV[12], then
  // ciphertext. We write 2 (wallet-derived); using 1 here would collide with the passphrase marker
  // and make this agent's memory unreadable on the browser SDK and in Claude Code via MCP.
  async _seal(entries) {
    const { webcrypto } = await import("node:crypto");
    const key = await this._cryptoKey();
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    // Canonical payload envelope {v, at, entries}: the shape every surface writes and reads.
    // _open below still accepts legacy bare-array blobs written before the envelope was unified.
    const gz = gzipSync(Buffer.from(JSON.stringify({ v: 1, at: new Date().toISOString(), entries })));
    const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, gz));
    return Buffer.concat([Buffer.from([2]), Buffer.from(iv), Buffer.from(ct)]); // 2 = wallet-derived AES-GCM
  }
  async _open(blob) {
    const { webcrypto } = await import("node:crypto");
    let doc;
    if (blob[0] === 0) doc = JSON.parse(gunzipSync(Buffer.from(blob.subarray(1))).toString()); // plaintext gzip
    else if (blob[0] !== 2) throw new Error("sealed"); // passphrase-encrypted (1) or unknown marker
    else {
      const iv = blob.subarray(1, 13), ct = blob.subarray(13);
      let pt;
      try {
        pt = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, await this._cryptoKey(), ct);
      } catch {
        // Legacy blob sealed with the v1 key message: derive v1 lazily and retry once.
        pt = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv }, await this._cryptoKeyV1(), ct);
      }
      doc = JSON.parse(gunzipSync(Buffer.from(pt)).toString());
    }
    // Envelope-tolerant: {v, at, entries} is canonical, but pre-envelope Node blobs on-chain are
    // bare arrays. Carry `at` onto each entry when the envelope provides it.
    const entries = Array.isArray(doc) ? doc : (doc.entries || []);
    const at = Array.isArray(doc) ? undefined : doc.at;
    return at ? entries.map((e) => ({ at, ...e })) : entries;
  }
  async append(entries) {
    const data = toHex(await this._seal(entries));
    const call = encodeFunctionData({ abi: ABI, functionName: "checkpoint", args: [this.agentId, data] });
    return this.wallet.sendTransaction({ to: MEM_ADDR, data: call });
  }
  // Verified reads: a port of the browser SDK's recall() (browser/agent-memory.js).
  // Checkpoint(uint256 indexed agentId, uint64 indexed era, uint64 seq, uint64 prevBlock,
  //            bytes32 prevHash, bytes32 newHash, bytes data): agentId + era are indexed (topics),
  // so the event DATA words are seq(0) prevBlock(1) prevHash(2) newHash(3) offset(4) len bytes.
  // The walk starts from the contract's head, follows prevBlock backwards one block at a time
  // (on Orbit chains, block numbers in events are ArbSys numbers, which is why headOf/prevBlock
  // are the source of truth, never eth_blockNumber), rebuilds the keccak chain over the raw blob
  // of every checkpoint (sealed or not), and refuses to return entries if any link or the final
  // head mismatches. Decrypt failures on individual blobs are tolerated; tamper is not.
  async raw() { return (await this._all()).filter((e) => !(e.role === "agent" && e.text.startsWith(ROOT_MARK))); }
  async _head() {
    const sel = keccak256(toBytes("headOf(uint256)")).slice(0, 10);
    const res = await this.pub.request({ method: "eth_call", params: [{ to: MEM_ADDR, data: sel + this.agentId.toString(16).padStart(64, "0") }, "latest"] });
    const b = (res || "0x").replace(/^0x/, "").padEnd(256, "0");
    return {
      hash: "0x" + b.slice(0, 64),
      count: Number(BigInt("0x" + (b.slice(64, 128) || "0"))),
      lastBlock: Number(BigInt("0x" + (b.slice(128, 192) || "0"))),
      era: Number(BigInt("0x" + (b.slice(192, 256) || "0"))),
    };
  }
  async _all() {
    const T = keccak256(toBytes("Checkpoint(uint256,uint64,uint64,uint64,bytes32,bytes32,bytes)"));
    const agentTopic = "0x" + this.agentId.toString(16).padStart(64, "0");
    const head = await this._head();
    if (head.count === 0) return [];
    const eraTopic = "0x" + BigInt(head.era).toString(16).padStart(64, "0");
    // Walk backwards from the head block, one block per hop (no indexer needed).
    const raw = [];
    let block = head.lastBlock;
    for (let i = 0; i < head.count && block > 0; i++) {
      const hexBlk = "0x" + block.toString(16);
      let logs = [];
      for (let attempt = 0; attempt < 4 && !logs.length; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 1000 * attempt));
        logs = await this.pub.request({ method: "eth_getLogs", params: [{ address: MEM_ADDR, topics: [T, agentTopic, eraTopic], fromBlock: hexBlk, toBlock: hexBlk }] }).catch(() => []);
      }
      if (!logs.length) throw new Error(`Memory read: missing checkpoint at block ${block} (RPC gap).`);
      logs.sort((a, b) => parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
      raw.unshift(...logs.map((l) => {
        const d = (l.data || "0x").slice(2);
        const off = parseInt(d.slice(4 * 64, 5 * 64), 16) * 2;       // offset to the bytes param
        const len = parseInt(d.slice(off, off + 64), 16) * 2;         // its byte length
        return {
          seqNo: Number(BigInt("0x" + d.slice(0, 64))),
          prevBlock: Number(BigInt("0x" + d.slice(64, 128))),
          newHash: "0x" + d.slice(192, 256),
          data: "0x" + d.slice(off + 64, off + 64 + len),
        };
      }));
      block = raw[0].prevBlock;
    }
    // Rebuild and verify the keccak chain over the raw blobs, then check it against the head.
    let h = "0x" + "0".repeat(64);
    for (const c of raw) {
      if (keccak256(encodePacked(["bytes32", "bytes"], [h, c.data])) !== c.newHash) throw new Error(`Memory read: hash chain mismatch at checkpoint seq ${c.seqNo}.`);
      h = c.newHash;
    }
    if (h !== head.hash) throw new Error("Memory read: chain head mismatch (walk incomplete or contract head moved).");
    // Chain verified: now decrypt what we can. A blob we cannot open (another wallet's) is skipped;
    // it still participated in the hash verification above.
    const out = [];
    let seq = 0;
    for (const c of raw) {
      try {
        const entries = await this._open(Buffer.from(c.data.slice(2), "hex"));
        for (const e of entries) out.push({ ...e, seq: ++seq });
      } catch { /* sealed by another wallet / undecodable payload */ }
    }
    return out;
  }
  async getRoot() {
    const roots = (await this._all()).filter((e) => e.role === "agent" && e.text.startsWith(ROOT_MARK));
    const last = roots[roots.length - 1];
    return last ? { text: last.text.slice(ROOT_MARK.length), seq: last.seq } : null;
  }
  async setRoot(text) { return this.append([{ role: "agent", text: ROOT_MARK + text }]); }
  async sinceRoot() { const r = await this.getRoot(); const seq = r?.seq || 0; return (await this.raw()).filter((e) => e.seq > seq); }
  label() { return `robinhood-chain:agent#${this.agentId}`; }
}
