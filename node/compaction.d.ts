import type { MemoryEntry, CompactionProvider } from "../types.js";

/** The system prompt that governs faithful compaction (preserve, never invent, newest-wins). */
export const COMPACT_SYS: string;

/**
 * Build a fresh ROOT index from the prior ROOT plus the raw memories recorded since it.
 * The LLM call is dependency-injected via `provider`. Returns the new ROOT markdown.
 */
export function compact(
  provider: CompactionProvider,
  args: { priorRoot?: string; entries: MemoryEntry[] }
): Promise<string>;
