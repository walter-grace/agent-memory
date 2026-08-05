// AgentMemory v2 migration — ONE reviewed command. Deploys the hardened AgentMemory (rebase is now
// owner-only + MAX_CHECKPOINT_BYTES gate) to Robinhood Chain, then rewrites every hardcoded reference
// to the old contract address across the SDK, the web app, the MCP server, and the docs so they all
// point at v2 together.
//
// Run:  PRIVATE_KEY=0x...  node migrate-agentmemory-v2.mjs        (or set it in agent-memory/.env)
//
// IMPORTANT, read before running:
//  - This deploys a FRESH contract at a NEW address. Agents/memory on the old contract
//    (0x881a9f7e...) are NOT carried over; they stay readable on the old address forever, but the
//    app/MCP/docs will point at v2 from now on. This is a clean pre-launch reset, no real user data.
//  - The contract address is part of the wallet-signature message that derives each agent's
//    encryption key, so v2 memory uses a fresh, domain-separated key. Old v1 encrypted memory is not
//    portable to v2 (by design, and it is the domain-separation the audit recommended).
//  - After it runs: redeploy the web app (so the new MCP server file + docs + lib ship), and tell
//    users to re-download hero-run-mcp.mjs. Existing downloads keep the old address until refreshed.
import { createWalletClient, createPublicClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { privateKey } from "./lib/env.mjs";

const OLD = "0x881a9f7ed58b7655c3c04bb2f9ef2cffd233a5ef";
const RH_RPC = "https://rpc.mainnet.chain.robinhood.com";
const chain = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RH_RPC] } } };

// Files that hardcode the address (out/deployment.json is rewritten by the deploy step below).
const REFS = [
  "/Users/bigneek/Desktop/agent-memory/README.md",
  "/Users/bigneek/Desktop/hero-foundry-web/lib/agent-memory.js",
  "/Users/bigneek/Desktop/hero-foundry-web/public/hero-run-mcp.mjs",
  "/Users/bigneek/Desktop/hero-foundry-web/app/docs.txt/route.js",
  "/Users/bigneek/Desktop/hero-foundry-web/public/llms.txt",
];

const account = privateKeyToAccount(privateKey());
const pub = createPublicClient({ chain, transport: http(RH_RPC, { retryCount: 8, retryDelay: 2000 }) });
const wc = createWalletClient({ account, chain, transport: http(RH_RPC, { retryCount: 8, retryDelay: 2000 }) });

const { abi, bytecode } = JSON.parse(readFileSync("out/AgentMemory.json", "utf8"));
console.log("deployer:", account.address, "bal:", formatEther(await pub.getBalance({ address: account.address })), "ETH");
console.log("deploying AgentMemory v2 (rebase owner-only + size gate)…");
const dh = await wc.deployContract({ abi, bytecode: typeof bytecode === "string" ? bytecode : bytecode.object });
const rec = await pub.waitForTransactionReceipt({ hash: dh });
const NEW = rec.contractAddress;
console.log("✓ AgentMemory v2:", NEW);

// SDK deployment record (node/onchain.mjs resolves MEM_ADDR from this file; redteam.mjs reads it too).
writeFileSync("out/deployment.json", JSON.stringify({ address: NEW, chainId: 4663, deployTx: dh, deployer: account.address, at: new Date().toISOString() }, null, 2) + "\n");
console.log("✓ wrote out/deployment.json");

// Patch every hardcoded reference from OLD -> NEW (case-insensitive; the checksummed NEW is compared
// via toLowerCase() at every call site, so it is safe everywhere).
const re = new RegExp(OLD, "gi");
for (const f of REFS) {
  try {
    const before = readFileSync(f, "utf8");
    const count = (before.match(re) || []).length;
    if (!count) { console.log(`  (no refs) ${f}`); continue; }
    writeFileSync(f, before.replace(re, NEW));
    console.log(`  ✓ patched ${count} ref(s) in ${f}`);
  } catch (e) { console.log(`  ! could not patch ${f}: ${e.message}`); }
}

console.log("\n=== NEXT ===");
console.log("1) Redeploy the web app so the new MCP server, docs, and lib ship:");
console.log("   cd ~/Desktop/hero-foundry-web && npx vercel --prod --yes");
console.log("2) Announce the new MCP server (users re-run: curl -o hero-run-mcp.mjs https://herorunai.com/hero-run-mcp.mjs).");
console.log("3) Old contract " + OLD + " stays readable; v2 is now canonical.");
