// Compile AgentMemory.sol with solc-js → out/AgentMemory.json { abi, bytecode }
import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const source = readFileSync("contracts/AgentMemory.sol", "utf8");
const input = {
  language: "Solidity",
  sources: { "AgentMemory.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) { console.error(errors.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
for (const w of (out.errors || [])) console.log(w.formattedMessage);
const c = out.contracts["AgentMemory.sol"].AgentMemory;
mkdirSync("out", { recursive: true });
writeFileSync("out/AgentMemory.json", JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2));
console.log("compiled: out/AgentMemory.json, bytecode", c.evm.bytecode.object.length / 2, "bytes");
