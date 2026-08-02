import type { MemoryBackend, MemoryEntry, RootIndex } from "../types.js";

/**
 * Robinhood Chain memory backend. Each checkpoint is AES-256-GCM sealed with a key derived from the
 * wallet's signature, gzip'd, and written on-chain. Reads walk the checkpoint chain backwards and
 * verify the keccak hash chain. Requires `viem` and an EOA private key (deterministic signing).
 */
export class OnchainMemory implements MemoryBackend {
  constructor(opts: { agentId: number | bigint; privateKey?: string });
  readonly agentId: bigint;
  append(entries: MemoryEntry[]): Promise<`0x${string}`>;
  raw(): Promise<MemoryEntry[]>;
  getRoot(): Promise<RootIndex | null>;
  setRoot(text: string): Promise<`0x${string}`>;
  sinceRoot(): Promise<MemoryEntry[]>;
  label(): string;
}
