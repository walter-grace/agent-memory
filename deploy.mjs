// Deploy AgentMemory to Robinhood Chain mainnet (4663). The deployer key comes from PRIVATE_KEY in
// the environment or a repo-local .env (see .env.example) — read at runtime, never logged.
import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { privateKey } from "./lib/env.mjs";

const RH_RPC = "https://rpc.mainnet.chain.robinhood.com";
const chain = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RH_RPC] } } };

const account = privateKeyToAccount(privateKey());

const { abi, bytecode } = JSON.parse(readFileSync("out/AgentMemory.json", "utf8"));
const pub = createPublicClient({ chain, transport: http(RH_RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RH_RPC) });

const hash = await wallet.deployContract({ abi, bytecode });
console.log("deploy tx:", hash);
const rec = await pub.waitForTransactionReceipt({ hash });
console.log("status:", rec.status, "| address:", rec.contractAddress, "| gasUsed:", rec.gasUsed.toString());
const bal = await pub.getBalance({ address: account.address });
console.log("deployer balance after:", formatEther(bal), "ETH");
writeFileSync("out/deployment.json", JSON.stringify({ address: rec.contractAddress, chainId: 4663, deployTx: hash, deployer: account.address, at: new Date().toISOString() }, null, 2));
