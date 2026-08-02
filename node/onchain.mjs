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
import { keccak256, toBytes, toHex, encodeFunctionData, createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const MEM_ADDR = process.env.HERO_MEM_ADDR || "0x881a9f7ed58b7655c3c04bb2f9ef2cffd233a5ef";
const RH_RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const KEY_MSG = `Hero Agent Memory encryption key v1\nContract: ${MEM_ADDR}\nChain: 4663`;
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
  }
  async _cryptoKey() {
    if (this._key) return this._key;
    const sig = await this.account.signMessage({ message: KEY_MSG });
    const raw = toBytes(keccak256(toBytes(sig)));
    const { webcrypto } = await import("node:crypto");
    this._key = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    return this._key;
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
    const gz = gzipSync(Buffer.from(JSON.stringify(entries)));
    const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, gz));
    return Buffer.concat([Buffer.from([2]), Buffer.from(iv), Buffer.from(ct)]); // 2 = wallet-derived AES-GCM
  }
  async _open(blob) {
    const { webcrypto } = await import("node:crypto");
    if (blob[0] === 0) return JSON.parse(gunzipSync(Buffer.from(blob.subarray(1))).toString()); // plaintext gzip
    if (blob[0] !== 2) throw new Error("sealed"); // passphrase-encrypted (1) or unknown marker
    const key = await this._cryptoKey();
    const pt = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(1, 13) }, key, blob.subarray(13));
    return JSON.parse(gunzipSync(Buffer.from(pt)).toString());
  }
  async append(entries) {
    const data = toHex(await this._seal(entries));
    const call = encodeFunctionData({ abi: ABI, functionName: "checkpoint", args: [this.agentId, data] });
    return this.wallet.sendTransaction({ to: MEM_ADDR, data: call });
  }
  // Checkpoint(uint256 indexed agentId, uint64 indexed era, uint64 seq, uint64 prevBlock,
  //            bytes32 hash, bytes32 prevHash, bytes data): agentId + era are indexed (topics).
  // The encrypted payload is the trailing `data` bytes param in the event DATA, not the whole DATA.
  // v0.1: write (append/encrypt) is complete and correct; READ decodes the `data` param but does
  // NOT yet verify the prevBlock/hash chain. For tamper-proof reads, port decodeCheckpoint + the
  // backwards hash-chain walk from the browser SDK (browser/agent-memory.js recall()).
  async raw() { return (await this._all()).filter((e) => !(e.role === "agent" && e.text.startsWith(ROOT_MARK))); }
  async _all() {
    const T = keccak256(toBytes("Checkpoint(uint256,uint64,uint64,uint64,bytes32,bytes32,bytes)"));
    const agentTopic = "0x" + this.agentId.toString(16).padStart(64, "0");
    const logs = await this.pub.request({ method: "eth_getLogs", params: [{ address: MEM_ADDR, topics: [T, agentTopic], fromBlock: "0x0", toBlock: "latest" }] }).catch(() => []);
    const out = [];
    let seq = 0;
    for (const l of logs) {
      try {
        // event DATA = seq(32) prevBlock(32) hash(32) prevHash(32) offset(32) len(32) bytes… ; the
        // `data` bytes is the last dynamic param: read its length then that many bytes.
        const hex = (l.data || "0x").slice(2);
        const off = parseInt(hex.slice(4 * 64, 5 * 64), 16) * 2;      // offset to the bytes param
        const len = parseInt(hex.slice(off, off + 64), 16) * 2;        // its byte length
        const blob = Buffer.from(hex.slice(off + 64, off + 64 + len), "hex");
        const entries = await this._open(blob);
        for (const e of entries) out.push({ ...e, seq: ++seq });
      } catch { /* not ours / sealed / decode gap */ }
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
