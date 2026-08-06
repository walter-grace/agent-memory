#!/usr/bin/env node
// hero-memory-proxy: an OpenAI-compatible endpoint that mints your agent's progress to the chain.
//
// THE POINT: any harness that speaks the OpenAI protocol (LangChain, CrewAI, AutoGPT, prime-agent,
// Cursor, Claude Code, a bash script with curl) already knows how to talk to `${BASE}/v1`. Point that
// one environment variable at this proxy and, with zero code changes, every exchange the agent has
// becomes a wallet-owned, encrypted, hash-linked checkpoint on Robinhood Chain, readable in the Hero
// Run memory graph and recallable by future runs. The proxy forwards inference upstream unchanged and
// captures the conversation on the side.
//
//   OPENAI_BASE_URL=http://localhost:8788/v1   (or OPENAI_API_BASE, depending on the client)
//
// WHY THIS RUNS LOCALLY, NOT AS A SERVICE WE HOST: writing to the chain needs a signature, and sealing
// the memory needs the wallet key. This process therefore holds AGENT_PRIVATE_KEY and, by necessity,
// sees plaintext before it encrypts. On your own machine that is fine, the key never leaves it. Hosted
// for other people, this process would be exactly the plaintext honeypot the whole design exists to
// avoid. So: run it locally or on infra you control. Do not offer it as a shared service.
//
// Env:
//   AGENT_PRIVATE_KEY   (required) wallet that signs chain writes + derives the encryption key. LOCAL ONLY.
//   HERO_AGENT_ID       (required to checkpoint) the agent NFT id. Run with `--mint` once to create one.
//   HERO_MEMORY_UPSTREAM  upstream OpenAI-compatible base (default https://herorunai.com/v1).
//   HERO_RUN_KEY        fallback inference key, used only when the client sends no Authorization header.
//   PORT                default 8788.
//   HERO_MEMORY_BATCH   exchanges per on-chain checkpoint (default 5). One signature per batch, not per
//                       call, or gas and confirmations would dominate. Flushed on shutdown regardless.
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http as viemHttp, defineChain, formatEther } from "viem";
import { OnchainMemory, mintAgent, MEM_ADDR } from "./onchain.mjs";

const UPSTREAM = (process.env.HERO_MEMORY_UPSTREAM || "https://herorunai.com/v1").replace(/\/$/, "");
const PORT = Number(process.env.PORT || 8788);
const BATCH = Math.max(1, Number(process.env.HERO_MEMORY_BATCH || 5));

// ---- local identity file -------------------------------------------------------------------------
// "Bring a funded wallet" is a wall for anyone who just wants to try this, and the wall has nothing to
// do with the idea. So the proxy manages a wallet for you, on your machine: generated on first run,
// saved 0600 in ~/.hero, never transmitted. That keeps the property that matters (you hold the key
// that decrypts your memory, we cannot) while removing the part nobody enjoys. Env vars always win,
// so CI and existing setups that already export AGENT_PRIVATE_KEY are unaffected.
const HOME_DIR = process.env.HERO_HOME || join(homedir(), ".hero");
const CONF_PATH = join(HOME_DIR, "proxy.json");

function readConf() {
  try {
    const c = JSON.parse(readFileSync(CONF_PATH, "utf8"));
    // A key readable by every process on a shared box is not a key. Fix it rather than warn and move on.
    try { if ((statSync(CONF_PATH).mode & 0o077) !== 0) { chmodSync(CONF_PATH, 0o600); console.warn(`[hero-memory] tightened permissions on ${CONF_PATH} to 0600.`); } } catch {}
    return c;
  } catch { return {}; }
}
function writeConf(patch) {
  const next = { ...readConf(), ...patch };
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONF_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { chmodSync(CONF_PATH, 0o600); } catch {}
  return next;
}
const normKey = (k) => {
  const s = String(k || "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error("A private key must be 64 hex characters (with or without the 0x prefix).");
  return "0x" + s.toLowerCase();
};
const argAfter = (flag) => { const i = process.argv.indexOf(flag); const v = process.argv[i + 1]; return v && !v.startsWith("-") ? v : null; };

const rh = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com"] } } });
const gasOf = async (addr) => {
  try { return formatEther(await createPublicClient({ chain: rh, transport: viemHttp() }).getBalance({ address: addr })); } catch { return null; }
};

// ---- resolve the wallet: env first, then the saved file, then generate one ----
let conf = readConf();
let PK, generated = false;
if (process.env.AGENT_PRIVATE_KEY) PK = normKey(process.env.AGENT_PRIVATE_KEY);
else if (conf.privateKey) PK = normKey(conf.privateKey);

// `--import <key>`: adopt a wallet you already control (one you funded, or one your wallet factory
// issued). Stored the same way as a generated one, so every later command just works.
if (process.argv.includes("--import")) {
  const raw = argAfter("--import");
  if (!raw) { console.error("Usage: hero-memory-proxy --import <private-key>"); process.exit(1); }
  let key; try { key = normKey(raw); } catch (e) { console.error(e.message); process.exit(1); }
  const acct = privateKeyToAccount(key);
  // A different wallet owns different agents, so a stale agentId would point at one this key cannot write to.
  const prev = readConf();
  conf = writeConf({ privateKey: key, agentId: prev.privateKey && normKey(prev.privateKey) !== key ? undefined : prev.agentId });
  console.log(`Imported wallet ${acct.address}\n  saved to ${CONF_PATH} (0600)`);
  const bal = await gasOf(acct.address);
  console.log(bal !== null ? `  Robinhood Chain gas: ${bal} ETH` : "  (could not read balance right now)");
  console.log(conf.agentId ? `  agent #${conf.agentId} kept` : "  Next:  hero-memory-proxy --mint \"my-agent\"");
  process.exit(0);
}

if (!PK) {
  // First run with nothing configured: make a wallet rather than failing with a setup instruction.
  PK = generatePrivateKey();
  conf = writeConf({ privateKey: PK });
  generated = true;
}
const ACCOUNT = privateKeyToAccount(PK);
let AGENT_ID = process.env.HERO_AGENT_ID ?? conf.agentId ?? null;

// ---- `--whoami`: what wallet am I, what agent, am I funded ----
if (process.argv.includes("--whoami")) {
  console.log(`wallet:   ${ACCOUNT.address}`);
  console.log(`agent:    ${AGENT_ID != null ? "#" + AGENT_ID : "none yet (run --mint)"}`);
  console.log(`config:   ${CONF_PATH}`);
  console.log(`contract: ${MEM_ADDR}`);
  const bal = await gasOf(ACCOUNT.address);
  console.log(`gas:      ${bal !== null ? bal + " ETH on Robinhood Chain" : "unavailable"}`);
  process.exit(0);
}

if (generated) {
  console.log(`No wallet configured, so one was generated for you:\n  ${ACCOUNT.address}\n  saved to ${CONF_PATH} (0600, never leaves this machine)\n`);
  console.log(`Fund it with a small amount of ETH on Robinhood Chain (chain 4663) for gas, then:\n  hero-memory-proxy --mint "my-agent"\n`);
  console.log(`Already have a wallet? Import it instead:  hero-memory-proxy --import 0x...\n`);
}

// ---- one-shot: mint an agent identity, remember it, exit. ----
if (process.argv.includes("--mint")) {
  const label = argAfter("--mint") || "openai-proxy-agent";
  const bal = await gasOf(ACCOUNT.address);
  if (bal !== null && Number(bal) === 0) {
    console.error(`Wallet ${ACCOUNT.address} has no Robinhood Chain gas, so the mint would fail.\nSend it a small amount of ETH on chain 4663 and try again.`);
    process.exit(1);
  }
  try {
    const { agentId, tx } = await mintAgent({ privateKey: PK, label });
    writeConf({ agentId });
    console.log(`Minted agent #${agentId} (label "${label}") on ${MEM_ADDR}\n  tx: ${tx}\n  saved to ${CONF_PATH}, so just run:  hero-memory-proxy`);
  } catch (e) { console.error(`Mint failed: ${e.shortMessage || e.message}`); process.exit(1); }
  process.exit(0);
}

// ---- memory sink: buffer exchanges, checkpoint one batch at a time, serialized so writes can't race
//      each other's nonces. Records only AFTER a successful upstream response, never on an error. ----
const mem = AGENT_ID != null ? new OnchainMemory({ agentId: AGENT_ID, privateKey: PK }) : null;
let buffer = [];              // entries awaiting a checkpoint
let pendingExchanges = 0;     // exchanges counted toward the next batch
let written = 0;              // checkpoints written this session
let chain = Promise.resolve();// append serializer

// Which harness produced this exchange. Worth recording: once several agents write to one wallet,
// "who wrote this" is the difference between a readable history and an undifferentiated pile. The
// client's own User-Agent is the honest signal (a harness identifies itself there without being asked)
// and HERO_MEMORY_SOURCE overrides it when someone wants a specific label.
const SOURCE_OVERRIDE = (process.env.HERO_MEMORY_SOURCE || "").trim();
function sourceOf(req) {
  if (SOURCE_OVERRIDE) return SOURCE_OVERRIDE.slice(0, 40);
  const ua = String(req?.headers?.["user-agent"] || "").trim();
  if (!ua) return "openai-proxy";
  // Take the leading product token ("prime-agent/0.4.1 node/22" -> "prime-agent"), which is the part
  // that names the tool; the version and platform noise after it helps nobody reading a graph.
  const name = ua.split(/[\s/]/)[0].replace(/[^\w.@-]/g, "");
  return (name || "openai-proxy").slice(0, 40);
}

function record(userText, assistantText, model, req) {
  if (!mem) return; // no agent id: proxy inference only, store nothing
  const at = new Date().toISOString();
  const source = sourceOf(req);
  if (userText) buffer.push({ role: "user", text: userText, at, source });
  if (assistantText) buffer.push({ role: "assistant", text: assistantText, at, model, source });
  pendingExchanges++;
  if (pendingExchanges >= BATCH) flush();
}

function flush() {
  if (!mem || !buffer.length) return chain;
  const batch = buffer; buffer = []; pendingExchanges = 0;
  chain = chain.then(async () => {
    try {
      const tx = await mem.append(batch);
      written++;
      console.log(`[hero-memory] checkpointed ${batch.length} entr${batch.length === 1 ? "y" : "ies"} to agent #${AGENT_ID} (tx ${String(tx).slice(0, 12)}…)`);
    } catch (e) {
      // Do not drop memory on a transient chain/RPC failure: put it back at the front and let the next
      // flush retry. Losing checkpoints silently would be worse than a delayed write.
      buffer = batch.concat(buffer);
      console.error(`[hero-memory] checkpoint failed, will retry: ${e.shortMessage || e.message}`);
    }
  });
  return chain;
}

// ---- helpers ----
const readBody = (req) => new Promise((resolve) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => resolve(Buffer.concat(c))); });
const lastUser = (messages) => { for (let i = (messages || []).length - 1; i >= 0; i--) if (messages[i]?.role === "user") return typeof messages[i].content === "string" ? messages[i].content : JSON.stringify(messages[i].content); return ""; };

// Assemble the assistant text out of a streamed SSE body while it passes through to the client.
function makeStreamCapture() {
  let text = "", tail = "";
  return {
    feed(chunk) {
      tail += chunk.toString();
      const lines = tail.split("\n"); tail = lines.pop();
      for (const line of lines) {
        const m = line.match(/^data: (.*)$/);
        if (!m || m[1] === "[DONE]") continue;
        try { text += JSON.parse(m[1]).choices?.[0]?.delta?.content || ""; } catch { /* keepalive or partial */ }
      }
    },
    get text() { return text; },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/health" || url.pathname === "/") {
    return json(res, 200, { ok: true, upstream: UPSTREAM, agentId: AGENT_ID ?? null, wallet: ACCOUNT.address, contract: MEM_ADDR, batch: BATCH, buffered: buffer.length, checkpoints_written: written, note: mem ? "recording" : "no agent yet: proxying inference only, storing nothing" });
  }
  if (!url.pathname.startsWith("/v1/")) return json(res, 404, { error: "not found" });

  const body = await readBody(req);
  // Forward the client's own Authorization (so its key bills it), else fall back to HERO_RUN_KEY.
  const auth = req.headers.authorization || (process.env.HERO_RUN_KEY ? `Bearer ${process.env.HERO_RUN_KEY}` : "");
  const headers = { "content-type": req.headers["content-type"] || "application/json" };
  if (auth) headers.authorization = auth;

  let up;
  try {
    up = await fetch(`${UPSTREAM}${url.pathname.replace(/^\/v1/, "")}${url.search}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
  } catch (e) {
    return json(res, 502, { error: { message: `upstream unreachable: ${e.message}`, type: "upstream_error" } });
  }

  const isChat = url.pathname === "/v1/chat/completions" && req.method === "POST";
  let reqJson = null; try { reqJson = JSON.parse(body.toString()); } catch { /* not json */ }

  // Non-2xx: pass the error through untouched, record nothing.
  if (!up.ok) { res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json" }); return res.end(Buffer.from(await up.arrayBuffer())); }

  if (isChat && up.headers.get("content-type")?.includes("text/event-stream")) {
    // Streamed: tee to the client while assembling the text, record on stream end.
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const cap = makeStreamCapture();
    const reader = up.body.getReader();
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; cap.feed(value); res.write(Buffer.from(value)); }
    } catch { /* client hung up */ }
    res.end();
    if (reqJson) record(lastUser(reqJson.messages), cap.text, reqJson.model, req);
    return;
  }

  const buf = Buffer.from(await up.arrayBuffer());
  res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json" });
  res.end(buf);
  if (isChat && reqJson) {
    try { record(lastUser(reqJson.messages), JSON.parse(buf.toString()).choices?.[0]?.message?.content || "", reqJson.model, req); } catch { /* non-json response */ }
  }
});

function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }

// Flush on the way down so a Ctrl-C never drops the batch in flight.
let closing = false;
async function shutdown() { if (closing) return; closing = true; console.log("\n[hero-memory] flushing before exit…"); await flush().catch(() => {}); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, async () => {
  console.log(`hero-memory-proxy on http://localhost:${PORT}/v1  ->  ${UPSTREAM}`);
  console.log(mem
    ? `Recording to agent #${AGENT_ID} (wallet ${ACCOUNT.address}), one checkpoint per ${BATCH} exchange(s).`
    : `No agent yet (wallet ${ACCOUNT.address}). Proxying inference only, storing nothing. Run:  hero-memory-proxy --mint "my-agent"`);
  console.log(`Point your harness at it:  export OPENAI_BASE_URL=http://localhost:${PORT}/v1`);
  // Checkpoints cost gas. Say so once at startup rather than letting every flush fail later.
  if (mem) {
    const bal = await gasOf(ACCOUNT.address);
    if (bal !== null && Number(bal) === 0) console.warn(`[hero-memory] WARNING: ${ACCOUNT.address} has no Robinhood Chain gas, so checkpoints will fail. Send it a little ETH on chain 4663.`);
  }
});
