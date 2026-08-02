// On-chain backend: encrypted, wallet-owned memory on Robinhood Chain.
// Requires AGENT_PRIVATE_KEY in the environment (a wallet you control, funded with a little RH gas)
// and an agentId you have already minted. Each append is one transaction (~$0.003).
//
//   AGENT_PRIVATE_KEY=0x... node examples/node-onchain.mjs <agentId>
import { OnchainMemory } from "../node/onchain.mjs";
import { compact } from "../node/compaction.mjs";

const agentId = process.argv[2];
if (!agentId) { console.error("usage: AGENT_PRIVATE_KEY=0x... node examples/node-onchain.mjs <agentId>"); process.exit(1); }

// Swap this stub for a real LLM provider (any object exposing chat({model, maxTokens, messages})).
const stubProvider = { chat: async () => ({ content: "## Facts & preferences\n- example ROOT" }) };

const mem = new OnchainMemory({ agentId }); // reads AGENT_PRIVATE_KEY from env
console.log("backend:", mem.label());

// Write an encrypted checkpoint (marker 2, wallet-derived AES-256-GCM).
const tx = await mem.append([{ role: "user", text: "remember: launch is next Tuesday" }]);
console.log("checkpoint tx:", tx);

// Read back: decrypt leaves this wallet owns, then compact into a ROOT.
const leaves = await mem.sinceRoot();
console.log("leaves since ROOT:", leaves.length);
const root = await compact(stubProvider, { priorRoot: (await mem.getRoot())?.text || "", entries: leaves });
await mem.setRoot(root);
console.log("ROOT written.");
