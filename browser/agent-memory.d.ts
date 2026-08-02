import type { MemoryEntry } from "../types.js";

/** Agent Memory contract address on Robinhood Chain. */
export const MEM_ADDR: `0x${string}`;
/** Robinhood Chain id, hex form (4663). */
export const MEM_CHAIN_HEX: string;

/**
 * The browser wallet the SDK signs and transacts through. Supply your own adapter (the herorunai.com
 * app wires this to its wallet-provider). `signMessage` must be deterministic (standard EOA) for
 * encrypted memory to be re-readable across sessions.
 */
export interface BrowserWallet {
  account: `0x${string}`;
  signMessage(message: string): Promise<string>;
  ensureChain(chainHex: string): Promise<void>;
  sendPreparedTx(tx: { to: string; data: string }): Promise<string>;
}

export interface AgentHead {
  hash: `0x${string}`;
  count: number;
  lastBlock: number;
  era: number;
}

export interface RecallResult {
  entries: Array<MemoryEntry & { role: string }>;
  checkpoints: number;
  /** True when the rebuilt keccak chain matched the on-chain head. */
  verified: boolean;
  era: number;
}

export interface AgentInfo {
  id: number;
  label: string;
  owner: `0x${string}`;
}

export function headOf(agentId: number | bigint): Promise<AgentHead>;
export function ownerOf(agentId: number | bigint): Promise<`0x${string}` | null>;
export function labelOf(agentId: number | bigint): Promise<string>;
export function mintAgent(w: BrowserWallet, label: string): Promise<string>;
export function checkpointEntries(
  w: BrowserWallet,
  agentId: number | bigint,
  entries: MemoryEntry[],
  opts?: { isPublic?: boolean }
): Promise<string>;
export function checkpoint(
  w: BrowserWallet,
  agentId: number | bigint,
  note: string,
  opts?: { isPublic?: boolean }
): Promise<string>;
export function recall(
  w: BrowserWallet,
  agentId: number | bigint,
  opts?: { maxCheckpoints?: number }
): Promise<RecallResult>;
export function askModel(args: {
  apiKey: string;
  model?: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
}): Promise<string>;
export function myAgents(w: BrowserWallet): Promise<AgentInfo[]>;
