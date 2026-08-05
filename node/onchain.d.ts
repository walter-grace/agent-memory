import type { MemoryBackend, MemoryEntry, RootIndex } from "../types.js";

/**
 * Resolved AgentMemory contract address: HERO_MEM_ADDR env override, else the repo-local
 * out/deployment.json (if present), else a hardcoded fallback.
 */
export const MEM_ADDR: `0x${string}`;

/** Result of a verified read: entries plus proof metadata. See `OnchainMemory.recall`. */
export interface RecallResult {
  entries: MemoryEntry[];
  /** Checkpoints actually walked (may be less than the chain's total count if truncated). */
  checkpoints: number;
  /** True only for a full, from-genesis walk that matched the contract's head hash. */
  verified: boolean;
  /** True when maxCheckpoints cut the walk short of genesis: a partial view, never a tamper signal. */
  truncated: boolean;
  era: number;
}

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
  /**
   * Verified read with proof metadata. Unbounded (walks to genesis) unless `maxCheckpoints` is
   * given, in which case a chain longer than the cap is read as a `truncated: true` partial window
   * rather than throwing or (incorrectly) treating a partial window as tampered.
   */
  recall(opts?: { maxCheckpoints?: number }): Promise<RecallResult>;
  getRoot(): Promise<RootIndex | null>;
  setRoot(text: string): Promise<`0x${string}`>;
  sinceRoot(): Promise<MemoryEntry[]>;
  label(): string;
}

/** Mint a new agent identity NFT. Standalone: no agentId exists yet. */
export function mintAgent(opts?: {
  privateKey?: string;
  label?: string;
}): Promise<{ agentId: number; tx: `0x${string}`; gasUsed: bigint }>;
