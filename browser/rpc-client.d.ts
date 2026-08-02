/** Robinhood Chain JSON-RPC endpoints, primary first. */
export const RH_RPC_URLS: string[];

/** Minimal JSON-RPC caller with failover across `urls`. Returns the `result` field. */
export function rpcCall(urls: string[], method: string, params?: unknown[]): Promise<any>;
