"use client";
// Vendored from the origin app: only the two symbols the browser SDK needs (RH_RPC_URLS, rpcCall).
// Browser code can only read NEXT_PUBLIC_-prefixed env vars, so an optional Alchemy fallback URL is
// read from NEXT_PUBLIC_ALCHEMY_RH_RPC when present.
//
// NOTE: any NEXT_PUBLIC_ var ships inside the client JS bundle, visible to anyone who opens devtools.
// Restrict the underlying Alchemy key to this site's origin in the Alchemy dashboard so a copied key
// can't be used to burn your request quota elsewhere.
export const RH_RPC_URLS = ["https://rpc.mainnet.chain.robinhood.com", process.env.NEXT_PUBLIC_ALCHEMY_RH_RPC].filter(Boolean);

// Plain JSON-RPC POST, trying each URL in order until one returns a result.
export async function rpcCall(urls, method, params = []) {
  let lastErr;
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if (j.error) { lastErr = new Error(j.error.message || "RPC error"); continue; }
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("All RPC endpoints failed.");
}
