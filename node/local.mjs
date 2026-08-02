// Local memory backend: disk-first JSONL, zero dependencies. The Hermes-style default: drop the
// agent on a $5 VPS and it just works, no wallet required. Raw memories are append-only leaves; a
// ROOT index (from compaction) is written as a marked entry. Same interface as the on-chain backend,
// so the harness and compaction don't care which one is in use.
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const ROOT_MARK = "root::";

export class LocalMemory {
  constructor({ file }) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) appendFileSync(file, "");
  }
  _read() {
    try {
      return readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l, i) => { const o = JSON.parse(l); o.seq = i + 1; return o; });
    } catch { return []; }
  }
  async append(entries) {
    for (const e of entries) appendFileSync(this.file, JSON.stringify({ role: e.role, text: e.text, ts: Date.now() }) + "\n");
  }
  async raw() {
    return this._read().filter((e) => !(e.role === "agent" && e.text.startsWith(ROOT_MARK)));
  }
  async getRoot() {
    const roots = this._read().filter((e) => e.role === "agent" && e.text.startsWith(ROOT_MARK));
    const last = roots[roots.length - 1];
    return last ? { text: last.text.slice(ROOT_MARK.length), seq: last.seq } : null;
  }
  async setRoot(text) {
    appendFileSync(this.file, JSON.stringify({ role: "agent", text: ROOT_MARK + text, ts: Date.now() }) + "\n");
  }
  async sinceRoot() {
    const root = await this.getRoot();
    const seq = root?.seq || 0;
    return (await this.raw()).filter((e) => e.seq > seq);
  }
  label() { return `local:${this.file}`; }
}
