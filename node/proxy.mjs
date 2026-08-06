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
import { OnchainMemory, mintAgent, MEM_ADDR } from "./onchain.mjs";

const UPSTREAM = (process.env.HERO_MEMORY_UPSTREAM || "https://herorunai.com/v1").replace(/\/$/, "");
const PORT = Number(process.env.PORT || 8788);
const BATCH = Math.max(1, Number(process.env.HERO_MEMORY_BATCH || 5));
const AGENT_ID = process.env.HERO_AGENT_ID;
const PK = process.env.AGENT_PRIVATE_KEY;

// ---- one-shot: mint an agent identity, print its id, exit. `npx hero-memory-proxy --mint`. ----
if (process.argv.includes("--mint")) {
  if (!PK) { console.error("Set AGENT_PRIVATE_KEY first (a wallet with a little Robinhood Chain gas)."); process.exit(1); }
  const label = process.argv[process.argv.indexOf("--mint") + 1] && !process.argv[process.argv.indexOf("--mint") + 1].startsWith("-")
    ? process.argv[process.argv.indexOf("--mint") + 1] : "openai-proxy-agent";
  const { agentId, tx } = await mintAgent({ privateKey: PK, label });
  console.log(`Minted agent #${agentId} (label "${label}") on ${MEM_ADDR}\n  tx: ${tx}\n  Now run the proxy with:  HERO_AGENT_ID=${agentId}`);
  process.exit(0);
}

if (!PK) { console.error("hero-memory-proxy: AGENT_PRIVATE_KEY is required. See the header of node/proxy.mjs."); process.exit(1); }

// ---- memory sink: buffer exchanges, checkpoint one batch at a time, serialized so writes can't race
//      each other's nonces. Records only AFTER a successful upstream response, never on an error. ----
const mem = AGENT_ID != null ? new OnchainMemory({ agentId: AGENT_ID, privateKey: PK }) : null;
let buffer = [];              // entries awaiting a checkpoint
let pendingExchanges = 0;     // exchanges counted toward the next batch
let written = 0;              // checkpoints written this session
let chain = Promise.resolve();// append serializer

function record(userText, assistantText, model) {
  if (!mem) return; // no agent id: proxy inference only, store nothing
  const at = new Date().toISOString();
  if (userText) buffer.push({ role: "user", text: userText, at, source: "openai-proxy" });
  if (assistantText) buffer.push({ role: "assistant", text: assistantText, at, model, source: "openai-proxy" });
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
    return json(res, 200, { ok: true, upstream: UPSTREAM, agentId: AGENT_ID ?? null, wallet: mem?.account?.address ?? null, contract: MEM_ADDR, batch: BATCH, buffered: buffer.length, checkpoints_written: written, note: mem ? "recording" : "no HERO_AGENT_ID: proxying inference only, storing nothing" });
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
    if (reqJson) record(lastUser(reqJson.messages), cap.text, reqJson.model);
    return;
  }

  const buf = Buffer.from(await up.arrayBuffer());
  res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json" });
  res.end(buf);
  if (isChat && reqJson) {
    try { record(lastUser(reqJson.messages), JSON.parse(buf.toString()).choices?.[0]?.message?.content || "", reqJson.model); } catch { /* non-json response */ }
  }
});

function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }

// Flush on the way down so a Ctrl-C never drops the batch in flight.
let closing = false;
async function shutdown() { if (closing) return; closing = true; console.log("\n[hero-memory] flushing before exit…"); await flush().catch(() => {}); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, () => {
  console.log(`hero-memory-proxy on http://localhost:${PORT}/v1  ->  ${UPSTREAM}`);
  console.log(mem
    ? `Recording to agent #${AGENT_ID} (wallet ${mem.account.address}), one checkpoint per ${BATCH} exchange(s).`
    : "No HERO_AGENT_ID set: proxying inference only, storing nothing. Run with --mint to create an agent.");
  console.log(`Point your harness at it:  export OPENAI_BASE_URL=http://localhost:${PORT}/v1`);
});
