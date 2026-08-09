// Deploy HeroMemoryMarket to Robinhood Chain.
//   HERO_AGENT_KEY_FILE=/path/to/0xD02A.key node deploy-market.mjs
// Constructor(hero, mem, feeRecipient). Owner = deployer.
import { readFileSync } from "node:fs";
import { createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const HERO = "0xbA221e393645901C962Ad21E4e7FA097d550B67c"; // $HERO on RH
const MEM = "0xce4dc968827a996f7bd5bbdb0fcb72348b18d0dc";  // AgentMemory
const FEE_RECIPIENT = "0xea02bd71e8f19bfc0d1a0a27a8684e51dc84bed5"; // treasury

const rh = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const key = readFileSync(process.env.HERO_AGENT_KEY_FILE, "utf8").trim();
const account = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);
const wallet = createWalletClient({ account, chain: rh, transport: http(RPC) });
const pub = createPublicClient({ chain: rh, transport: http(RPC) });
const { abi, bytecode } = JSON.parse(readFileSync("out/HeroMemoryMarket.json", "utf8"));

console.log("deployer:", account.address);
console.log("args: hero", HERO, "\n      mem ", MEM, "\n      fee ", FEE_RECIPIENT);
const hash = await wallet.deployContract({ abi, bytecode, args: [HERO, MEM, FEE_RECIPIENT] });
console.log("deploy tx:", hash);
const rec = await pub.waitForTransactionReceipt({ hash });
console.log("status:", rec.status, "contract:", rec.contractAddress);
if (rec.status !== "success") process.exit(1);

// verify read-back
const read = async (fn) => pub.readContract({ address: rec.contractAddress, abi, functionName: fn });
console.log("owner        :", await read("owner"));
console.log("feeRecipient :", await read("feeRecipient"));
console.log("feeBps       :", await read("feeBps"));
console.log("bondBps      :", await read("bondBps"));
console.log("hero         :", await read("hero"));
console.log("mem          :", await read("mem"));
console.log("\nSet NEXT_PUBLIC_MARKET_ADDR=" + rec.contractAddress);
