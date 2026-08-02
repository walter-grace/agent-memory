# agent-memory

Wallet-owned, compacting memory for AI agents. Two Node backends behind one interface: a local
JSONL file with zero dependencies, and an encrypted on-chain backend where the agent's own wallet is
the key. A browser SDK reads and writes the same on-chain format. Memory written on one surface is
readable on every other surface that holds the same wallet.

Origin: built for Hero Run agents on Robinhood Chain. The library itself is brand-neutral and
reusable: point it at any wallet and contract that follow the format.

## What is in the box

- `node/local.mjs` LocalMemory: append-only JSONL on disk, zero dependencies. Drop the agent on a
  small VPS and it works, no wallet required.
- `node/onchain.mjs` OnchainMemory: each checkpoint is AES-256-GCM encrypted with a key derived from
  the wallet signature, gzip'd, and written to the memory contract. On-chain observers see only
  random bytes. Only the wallet that holds the private key can decrypt. Needs `viem` and
  `AGENT_PRIVATE_KEY`.
- `node/compaction.mjs` compaction: turns a growing pile of raw leaves into a small ROOT index the
  agent reads each session. Backend-agnostic. The LLM provider is dependency-injected.
- `browser/agent-memory.js` browser SDK: mint an agent, checkpoint, and the full `recall()` that
  walks the checkpoint chain backwards and verifies the keccak hash chain. Uses `viem` and `fflate`.
- `browser/rpc-client.js`: the two RPC helpers the SDK needs (`RH_RPC_URLS`, `rpcCall`).

Both Node backends implement the same interface: `append`, `raw`, `getRoot`, `setRoot`, `sinceRoot`,
`label`. The harness and the compaction step do not care which backend is in use.

## Compaction model

Raw memories are never deleted. They stay as append-only leaves. Compaction builds an index on top:

- Hierarchical index (openclaw#51612): a small, constant-cost ROOT the agent reads each session, so
  it knows what it knows without replaying every leaf.
- Newest-wins merge (RocksDB-style leveled compaction): when two memories conflict about the same
  thing, the more recent value supersedes the older and the stale one is dropped. The ROOT is the
  current merged state, not a contradictory pile.

`compact(provider, { priorRoot, entries })` takes any provider that exposes
`chat({ model, maxTokens, messages })` and returns the rewritten ROOT string. The system prompt
(`COMPACT_SYS`) is exported so you can inspect or reuse it.

## Node quickstart

Local backend, no wallet, no network. The provider is stubbed so the example runs with no API key:

```bash
node examples/node-local.mjs
```

```js
import { LocalMemory } from "agent-memory/node/local";
import { compact } from "agent-memory/node/compaction";

const mem = new LocalMemory({ file: "./.data/mem.jsonl" });
await mem.append([{ role: "user", text: "switch me to dark mode" }]);

// A provider is any object with chat({ model, maxTokens, messages }) -> { content }.
const root = await compact(myProvider, {
  priorRoot: (await mem.getRoot())?.text || "",
  entries: await mem.sinceRoot(),
});
await mem.setRoot(root);
```

On-chain backend (requires `viem`, a funded wallet, and a minted `agentId`):

```bash
AGENT_PRIVATE_KEY=0x... node examples/node-onchain.mjs <agentId>
```

```js
import { OnchainMemory } from "agent-memory/node/onchain";
const mem = new OnchainMemory({ agentId }); // reads AGENT_PRIVATE_KEY from env
await mem.append([{ role: "user", text: "launch is next Tuesday" }]); // one tx, encrypted
```

## Dependencies

`node/local.mjs` and `node/compaction.mjs` have zero runtime dependencies. `viem` and `fflate` are
optional: `viem` is needed only for the on-chain path, `fflate` and `viem` for the browser SDK.
Install them when you use those paths:

```bash
npm install viem fflate
```

Node 20 or newer.

## Interop

The blob format, key derivation, contract, and event layout are specified in
[FORMAT.md](./FORMAT.md). That is the contract that lets a memory written by a Node CLI, the browser
SDK, or an MCP server be read by any of the others from the same wallet. Read it before writing a new
surface.

## License

MIT. See [LICENSE](./LICENSE).
