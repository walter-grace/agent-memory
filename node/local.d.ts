import type { MemoryBackend, MemoryEntry, RootIndex } from "../types.js";

/** Disk-first JSONL memory backend. Zero dependencies. The offline / no-wallet default. */
export class LocalMemory implements MemoryBackend {
  constructor(opts: { file: string });
  append(entries: MemoryEntry[]): Promise<void>;
  raw(): Promise<MemoryEntry[]>;
  getRoot(): Promise<RootIndex | null>;
  setRoot(text: string): Promise<void>;
  sinceRoot(): Promise<MemoryEntry[]>;
  label(): string;
}
