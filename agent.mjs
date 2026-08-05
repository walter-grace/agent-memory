// The RH Memory Agent — an agent whose ONLY persistence is Robinhood Chain.
//
//   node agent.mjs mint "walt's agent"          → mint an agent identity NFT
//   node agent.mjs chat <agentId> "message"     → resume memory from chain, think, remember
//   node agent.mjs recall <agentId>             → dump the on-chain memory timeline
//   node agent.mjs compact <agentId>            → distill raw memory into a ROOT summary
//
// No database, no files, no GitHub: kill this process, run it on any machine holding the key,
// and the agent walks its own history back out of the chain and picks up where it left off.
// Inference is a real model (Cerebras); memory writes are real RH mainnet transactions.
//
// Memory logic lives in node/onchain.mjs (OnchainMemory) — the one canonical implementation shared
// with the browser SDK and this CLI. Compaction (node/compaction.mjs) writes a ROOT index as a
// marked checkpoint in the SAME era (see FORMAT.md's "ROOT index convention"); it does not call the
// contract's rebase(), which is reserved for the owner explicitly starting a fresh chain.
import { OnchainMemory, mintAgent, MEM_ADDR } from "./node/onchain.mjs";
import { compact } from "./node/compaction.mjs";
import { privateKey, envVar } from "./lib/env.mjs";

const PK = privateKey();
const CEREBRAS_KEY = envVar("CEREBRAS_API_KEY");

const [, , cmd, a, b] = process.argv;

// Cerebras-backed provider for node/compaction.mjs's compact(): any object exposing
// chat({ model, maxTokens, messages }) -> { content }.
const cerebras = {
  chat: async ({ maxTokens = 600, messages }) => {
    const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${CEREBRAS_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-oss-120b", max_completion_tokens: maxTokens, messages }),
    });
    const data = await res.json();
    if (!data.choices) throw new Error("inference failed: " + JSON.stringify(data).slice(0, 300));
    return { content: data.choices[0].message.content.trim() };
  },
};

if (cmd === "mint") {
  const { agentId, tx, gasUsed } = await mintAgent({ privateKey: PK, label: a || "agent" });
  console.log(`minted agent #${agentId} ("${a}")`);
  console.log(`tx: ${tx} (gas ${gasUsed})`);
  console.log(`explorer: https://robinhoodchain.blockscout.com/tx/${tx}`);
} else if (cmd === "recall") {
  const agentId = Number(a);
  const mem = new OnchainMemory({ agentId, privateKey: PK });
  const t0 = Date.now();
  const info = await mem.recall();
  console.log(`agent #${a} memory: ${info.checkpoints} checkpoints, era ${info.era}, hash chain ${info.verified ? "VERIFIED ✓" : "PARTIAL (truncated)"} (${Date.now() - t0}ms)`);
  for (const e of info.entries) console.log(`  [${e.seq}] ${e.role}: ${e.text}`);
} else if (cmd === "chat") {
  const agentId = Number(a);
  const message = b;
  if (!message) { console.error('usage: node agent.mjs chat <agentId> "message"'); process.exit(1); }
  const mem = new OnchainMemory({ agentId, privateKey: PK });

  // 1. RESUME — the agent's entire past, from the chain alone
  const t0 = Date.now();
  const info = await mem.recall();
  console.log(`[memory] resumed ${info.entries.length} entries from ${info.checkpoints} on-chain checkpoints in ${Date.now() - t0}ms · hash chain ${info.verified ? "verified ✓" : "BROKEN/PARTIAL ✗"}`);
  if (!info.verified) process.exit(1);

  // 2. THINK — real inference with the chain memory as context
  const history = info.entries.map((e) => ({ role: e.role === "agent" ? "assistant" : "user", content: e.text }));
  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${CEREBRAS_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-oss-120b",
      max_completion_tokens: 400,
      messages: [
        { role: "system", content: `You are agent #${agentId}, an AI agent whose entire memory lives as encrypted checkpoints on Robinhood Chain (contract ${MEM_ADDR}). The conversation below was reconstructed from your on-chain memory — treat it as your own past. Be concise.` },
        ...history,
        { role: "user", content: message },
      ],
    }),
  });
  const data = await res.json();
  if (!data.choices) { console.error("inference failed:", JSON.stringify(data).slice(0, 300)); process.exit(1); }
  const answer = data.choices[0].message.content.trim();
  console.log(`\n${answer}\n`);

  // 3. REMEMBER — this exchange becomes a permanent on-chain checkpoint (wallet-derived AES-256-GCM)
  const tx = await mem.append([
    { role: "user", text: message },
    { role: "agent", text: answer },
  ]);
  const rec = await mem.pub.waitForTransactionReceipt({ hash: tx });
  console.log(`[memory] checkpointed on-chain · gas ${rec.gasUsed} · tx ${tx.slice(0, 18)}…`);
} else if (cmd === "compact") {
  const agentId = Number(a);
  const mem = new OnchainMemory({ agentId, privateKey: PK });
  const info = await mem.recall();
  if (!info.verified) { console.error("hash chain broken or truncated — refusing to compact"); process.exit(1); }
  const leaves = await mem.sinceRoot();
  if (!leaves.length) { console.log("[memory] nothing to compact since the last ROOT."); process.exit(0); }
  console.log(`[memory] compacting ${leaves.length} entries recorded since the last ROOT (era ${info.era})…`);
  const priorRoot = (await mem.getRoot())?.text || "";
  const root = await compact(cerebras, { priorRoot, entries: leaves });
  console.log(`\n--- distilled ROOT ---\n${root}\n---\n`);
  const tx = await mem.setRoot(root);
  console.log(`[memory] new ROOT checkpointed on-chain · tx ${tx.slice(0, 18)}…`);
  console.log(`[memory] raw history stays on-chain and walkable; recall() reads it via sinceRoot() next time.`);
} else {
  console.log('usage: node agent.mjs mint "label" | chat <agentId> "msg" | recall <agentId> | compact <agentId>');
}
