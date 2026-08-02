// Shared types for agent-memory. Hand-written to match the .mjs runtime exactly (no build step).

/** One memory leaf. `role` is typically "user" | "agent", but any string is allowed. */
export interface MemoryEntry {
  role: string;
  text: string;
  /** Sequence number assigned on read (1-based). Present on entries returned by a backend. */
  seq?: number;
  /** ISO 8601 write time, when the payload envelope carried one. */
  at?: string;
}

/** The latest ROOT compaction index, or null if none has been written yet. */
export interface RootIndex {
  text: string;
  seq: number;
}

/**
 * The interface both Node backends implement (LocalMemory, OnchainMemory), so the harness and
 * compaction never care which store is in use.
 */
export interface MemoryBackend {
  /** Append leaves as one checkpoint (one transaction on the on-chain backend). */
  append(entries: MemoryEntry[]): Promise<unknown>;
  /** All leaf memories, excluding ROOT index entries. */
  raw(): Promise<MemoryEntry[]>;
  /** The latest ROOT index, or null. */
  getRoot(): Promise<RootIndex | null>;
  /** Write a new ROOT index (stored as a marked entry). */
  setRoot(text: string): Promise<unknown>;
  /** Leaves recorded after the latest ROOT. */
  sinceRoot(): Promise<MemoryEntry[]>;
  /** Human-readable backend id, e.g. "local:<file>" or "robinhood-chain:agent#<id>". */
  label(): string;
}

/** A chat provider the compaction pass calls. Bring your own (Hero Run, OpenAI-compatible, etc.). */
export interface CompactionProvider {
  chat(args: {
    model?: string;
    maxTokens?: number;
    messages: Array<{ role: string; content: string }>;
  }): Promise<{ content?: string }>;
}
