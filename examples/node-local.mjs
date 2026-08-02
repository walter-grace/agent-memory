// Local backend, no wallet: append memories, compact them into a ROOT index, recall.
// The compaction provider is dependency-injected; here it is a trivial stub that returns a fixed
// summary so the example runs with no network and no API key.
import { LocalMemory } from "../node/local.mjs";
import { compact } from "../node/compaction.mjs";

const stubProvider = { chat: async () => ({ content: "## Facts & preferences\n- user prefers dark mode\n## Decisions & state\n- shipping on Friday" }) };

const mem = new LocalMemory({ file: "./.data/example.jsonl" });
await mem.append([
  { role: "user", text: "I prefer light mode" },
  { role: "user", text: "actually, switch me to dark mode" },
  { role: "agent", text: "noted: dark mode" },
]);

const prior = await mem.getRoot();
const leaves = await mem.sinceRoot();
const root = await compact(stubProvider, { priorRoot: prior?.text || "", entries: leaves });
await mem.setRoot(root);

console.log("ROOT index:\n" + (await mem.getRoot()).text);
console.log("\nraw leaves:", (await mem.raw()).length, "| leaves since ROOT:", (await mem.sinceRoot()).length);
