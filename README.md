# Agent Memory

**Give an AI agent a memory that lives in a wallet, not a database.**

Most agent memory sits in someone else's Postgres. You cannot see it, move it, verify it, or take it with you. This is a small, open toolkit for the other model: an agent *is* an NFT you own, and its memory is a hash-linked chain of encrypted checkpoints written on-chain. Kill the process, run it on any machine that holds the key, and the agent walks its own history back out of the chain and picks up where it left off.

It runs on [Robinhood Chain](https://robinhoodchain.blockscout.com) (an Arbitrum Orbit L2) and is powered by the **$HERO** token. Part of [Hero Run](https://herorunai.com).

Live contract (v2, hardened): [`0xce4dc968827a996f7bd5bbdb0fcb72348b18d0dc`](https://robinhoodchain.blockscout.com/address/0xce4dc968827a996f7bd5bbdb0fcb72348b18d0dc)

This repo has two halves that ship together: the **contracts + tooling** (Solidity, deploy, migration, a memory CLI, red team) and a **client library** (`node/`, `browser/`) that any Node or browser app can install and point at any wallet and contract following the format. `node/onchain.mjs` is the one memory implementation used by both the CLI and the library; there is no second copy.

---

## The idea

An agent's memory has the exact shape of things NFTs are already good at:

- **Ownership.** A wallet owns the agent. Nobody else can write to it, and only the owner's key decrypts it.
- **History.** Each checkpoint links to the one before it by hash, so the whole chain is tamper-evident. You can prove what the agent knew and when.
- **Portability.** The memory is not trapped in one app's account system. Any machine with the key can resume it. Memory written on one surface (Node CLI, browser, hosted MCP) is readable on every other surface that holds the same wallet.
- **No indexer.** Each checkpoint event embeds the previous checkpoint's block number, so resume walks backward with one single-block query per checkpoint. No full-chain scan, no subgraph.

So instead of inventing a storage format, we use the one the wallet already understands: the NFT.

## How it works

```
wallet ──owns──▶ Agent NFT ──chain of──▶ checkpoints (gzipped, wallet-derived AES-GCM, hash-linked)
                     │                         │
                     │                         └─ compaction writes a ROOT summary to keep recall cheap
                     │
                     └──▶ Memory Card NFT (fully on-chain cover, visible in any wallet)
```

1. **Mint an agent.** `mint(label)` creates an ERC-721 on Robinhood Chain. That token is the agent's identity.
2. **Write a memory.** `checkpoint(agentId, blob)` appends a checkpoint. The blob is gzipped, sealed with AES-256-GCM under a key derived from the wallet's own signature, and rides in event data (near-free on RH). Each checkpoint keccak-links to the previous one.
3. **Resume.** `headOf(agentId)` gives the latest checkpoint's block; each event points at the previous block; the reader walks backward and re-verifies the hash chain on the way up, so a tampered or reordered history cannot masquerade as the real one.
4. **Compact.** As history grows, `setRoot()` writes a ROOT summary checkpoint (marked, not deleted) so recall stays cheap without dropping the raw record. `node/compaction.mjs` produces the summary text; any LLM provider you inject can write it.
5. **Mint a cover.** Anything the agent produces (an image, code, a conversation) can be minted as a **Memory Card**: an ERC-721 whose entire token URI is a `data:` document stored on-chain with a small embedded image. No server, no IPFS, no gateway. It renders in any wallet for as long as the chain exists.

## Why $HERO

$HERO is the token of the [Hero Run](https://herorunai.com) mission: fund one frontier open training run. It is the rail here, not decoration.

- **Skin in the game.** Durable, always-on agent rights are gated on holding $HERO, tying the right to automate to a stake in the mission.
- **Minting.** Memory Cards mint for a $HERO fee that flows to the treasury, so every card is a small contribution toward the run.
- **Generation.** Images, code, and text are generated through the Hero SDK and paid for in $HERO.

Gas is the chain's native ETH; $HERO is the stake and the currency, never the gas.

## Contracts

| Contract | What it does |
| --- | --- |
| [`contracts/AgentMemory.sol`](contracts/AgentMemory.sol) | ERC-721 agents + `checkpoint(agentId, bytes)` hash-linked history + compaction. `rebase()` is owner-only (an approved operator can `checkpoint` but never erase-by-omission the chain head) and every `checkpoint` is gated by `MAX_CHECKPOINT_BYTES` so one write can't grief indexers with an unbounded blob. Live on Robinhood Chain at `0xce4dc968…` (v2). |
| [`contracts/HeroMemoryCard.sol`](contracts/HeroMemoryCard.sol) | Fully on-chain cover NFTs. `mint(to, uri, maxFee)` stores a complete `data:` token URI on-chain and pulls `mintFee` in $HERO to the treasury via `SafeERC20` (approve first). `maxFee` is the caller's slippage guard: the mint reverts with `FeeTooHigh` rather than charging more than quoted if the owner raises the fee in between. `maxUriBytes` bounds the stored URI, and `rescue` recovers tokens sent to the contract by mistake. Live on Robinhood Chain at `0x35777ae6…` (v2). |

## What is in the box

**Contracts + tooling** (repo-local, needs a funded wallet and `PRIVATE_KEY` in `.env`):

- `contracts/AgentMemory.sol`, `contracts/HeroMemoryCard.sol` the Solidity source.
- `compile.mjs` compiles `AgentMemory.sol` with `solc-js` into `out/AgentMemory.json` (`{ abi, bytecode }`).
- `deploy.mjs` deploys `out/AgentMemory.json` and writes `out/deployment.json`.
- `migrate-agentmemory-v2.mjs` the one reviewed command that deployed the hardened v2 contract and repointed every hardcoded reference across the SDK, web app, and docs.
- `agent.mjs` the memory CLI: `mint`, `chat`, `recall`, `compact` (see Quickstart).
- `redteam.mjs` exercises auth, rebase, size-cap, forgery, and privacy checks against the live contract with `simulateContract` (no gas spent).

**Client library** (installable, brand-neutral, works with any wallet and any contract that follows [`FORMAT.md`](FORMAT.md)):

- `node/local.mjs` `LocalMemory`: append-only JSONL on disk, zero dependencies. Drop the agent on a small VPS and it works, no wallet required.
- `node/onchain.mjs` `OnchainMemory`: **the one canonical memory implementation** used by both this repo's CLI and any consumer of the npm package. Each checkpoint is AES-256-GCM encrypted with a key derived from the wallet signature, gzip'd, and written to the memory contract. Needs `viem` and a private key. Also exports `mintAgent(...)`.
- `node/compaction.mjs` compaction: turns a growing pile of raw leaves into a small ROOT index the agent reads each session. Backend-agnostic; the LLM provider is dependency-injected.
- `browser/agent-memory.js` browser SDK: mint an agent, checkpoint, and the full `recall()` that walks the checkpoint chain backwards and verifies the keccak hash chain. Uses `viem` and `fflate`.
- `browser/rpc-client.js` the two RPC helpers the SDK needs (`RH_RPC_URLS`, `rpcCall`).

Both Node backends implement the same interface: `append`, `raw`, `getRoot`, `setRoot`, `sinceRoot`, `label`. The harness and the compaction step do not care which backend is in use. `OnchainMemory` additionally exposes `recall({ maxCheckpoints })` for the entries-plus-proof-metadata shape (`checkpoints`, `verified`, `truncated`, `era`) that `agent.mjs` and the browser SDK both use.

## Compaction model

Raw memories are never deleted. They stay as append-only leaves. Compaction builds an index on top:

- Hierarchical index (openclaw#51612): a small, constant-cost ROOT the agent reads each session, so it knows what it knows without replaying every leaf.
- Newest-wins merge (RocksDB-style leveled compaction): when two memories conflict about the same thing, the more recent value supersedes the older and the stale one is dropped. The ROOT is the current merged state, not a contradictory pile.

`compact(provider, { priorRoot, entries })` takes any provider that exposes `chat({ model, maxTokens, messages })` and returns the rewritten ROOT string. The system prompt (`COMPACT_SYS`) is exported so you can inspect or reuse it. `setRoot(text)` writes the result as one more (marked) checkpoint in the *same* chain; nothing about compaction resets the contract's `era` (that is what `rebase()` is for, and it stays a deliberate, owner-only action separate from routine compaction).

## Quickstart (this repo: contracts + CLI)

```bash
npm install
cp .env.example .env        # fill in PRIVATE_KEY (a funded RH wallet) + CEREBRAS_API_KEY

# an agent whose only persistence is the chain
node agent.mjs mint "my agent"
node agent.mjs chat <agentId> "remember: I prefer terse answers"
node agent.mjs recall <agentId>       # dump the on-chain memory timeline
node agent.mjs compact <agentId>      # distill raw history into a ROOT summary

# compile / deploy your own instance, or red-team the live one
node compile.mjs
node deploy.mjs
node redteam.mjs
```

Secrets are read from your environment or a local `.env` (gitignored). Nothing is hardcoded and nothing is committed. `node/onchain.mjs` resolves the contract address it talks to in this order: an explicit `HERO_MEM_ADDR` override, then this repo's `out/deployment.json` (whatever `deploy.mjs` / `migrate-agentmemory-v2.mjs` last wrote there, currently the v2 address above), then a hardcoded fallback for standalone/library use with no local `out/` directory.

## Node quickstart (library usage, outside this repo)

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

On-chain backend (requires `viem`, a funded wallet, and a minted `agentId`; `AGENT_PRIVATE_KEY` here is a plain library env var, separate from this repo's own `PRIVATE_KEY`/`.env` convention used by `agent.mjs`):

```bash
AGENT_PRIVATE_KEY=0x... node examples/node-onchain.mjs <agentId>
```

```js
import { OnchainMemory, mintAgent } from "agent-memory/node/onchain";

const { agentId } = await mintAgent({ privateKey: "0x...", label: "my agent" });
const mem = new OnchainMemory({ agentId, privateKey: "0x..." }); // or reads AGENT_PRIVATE_KEY from env
await mem.append([{ role: "user", text: "launch is next Tuesday" }]); // one tx, encrypted
const { entries, verified } = await mem.recall();
```

## Any OpenAI harness, minting to the chain (the memory proxy)

Your agent framework already knows how to talk to an OpenAI-compatible `/v1`. The proxy inserts itself
there: it forwards inference upstream unchanged, and on the side it encrypts every exchange and
checkpoints it to your agent NFT. Any harness that reads `OPENAI_BASE_URL` gets wallet-owned,
hash-verified, portable memory with no code changes.

```bash
npx hero-memory-proxy
#   No wallet configured, so one was generated for you:
#     0xAbC…                saved to ~/.hero/proxy.json (0600, never leaves this machine)
```

Or from a clone (`npm link` puts the `hero-memory-proxy` command on your PATH; without it,
`node node/proxy.mjs` does the same thing):

```bash
git clone https://github.com/walter-grace/agent-memory && cd agent-memory
npm install          # viem is the only runtime dependency
npm link             # optional: gives you the `hero-memory-proxy` command

hero-memory-proxy    # or: node node/proxy.mjs
#   No wallet configured, so one was generated for you:
#     0xAbC…                saved to ~/.hero/proxy.json (0600, never leaves this machine)
#   Fund it with a small amount of ETH on Robinhood Chain (chain 4663) for gas, then:
#     hero-memory-proxy --mint "my-agent"

hero-memory-proxy --mint "my-coding-agent"   # remembers the agent id for you
hero-memory-proxy                            # now recording
#   hero-memory-proxy on http://localhost:8788/v1  ->  https://herorunai.com/v1
```

Already have a wallet (your own, or one your wallet factory issued)? Import it:

```bash
hero-memory-proxy --import 0x<private-key>   # stored 0600 in ~/.hero/proxy.json
hero-memory-proxy --whoami                   # wallet, agent, gas balance, config path
```

`AGENT_PRIVATE_KEY` and `HERO_AGENT_ID` still work and take precedence, so CI and existing setups are
unaffected. The only thing the managed wallet needs from you is a little Robinhood Chain gas: each
checkpoint is one transaction (about $0.003), and the proxy warns at startup if the balance is zero
instead of failing on every write.

Now point any harness at it. No SDK, no rewrite, one variable:

```bash
# LangChain, CrewAI, AutoGPT, LlamaIndex, the OpenAI SDK, a curl script...
export OPENAI_BASE_URL=http://localhost:8788/v1
export OPENAI_API_KEY=hr_live_...        # your Hero Run key: bills inference in $HERO
```

```python
# LangChain, unchanged. Every call is now minted to your agent's chain.
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(model="auto", base_url="http://localhost:8788/v1")
llm.invoke("Design a caching layer for the payments service.")
```

```bash
# prime-agent (or anything that honors the env var), unchanged
OPENAI_BASE_URL=http://localhost:8788/v1 prime-agent run "refactor the auth module"
```

Read it back anywhere the format is spoken, the same wallet decrypts it in the memory graph on
herorunai.com, in Claude Code via the MCP server, or here:

```js
import { OnchainMemory } from "agent-memory/node/onchain";
const { entries, verified } = await new OnchainMemory({ agentId: 42, privateKey: "0x..." }).recall();
```

**Config:** `HERO_MEMORY_UPSTREAM` (default `https://herorunai.com/v1`, point it at any OpenAI provider),
`HERO_RUN_KEY` (fallback inference key when the client sends none), `PORT` (default 8788),
`HERO_MEMORY_BATCH` (exchanges per checkpoint, default 5: one signature per batch, not per call). It
flushes the buffer on shutdown, so Ctrl-C never drops an in-flight batch. `GET /health` reports the
agent, wallet, and how many checkpoints it has written.

**Run it locally, or on infra you control, only.** The proxy holds the wallet key and, by necessity,
sees plaintext before it encrypts. On your machine the key never leaves it (`~/.hero/proxy.json`, 0600).
Hosted for other people, this process would be the plaintext honeypot the whole design exists to avoid,
so there is no hosted version and you should not build one.

**Why a wallet at all, when you already have an API key.** The `hr_live_` key is a billing credential:
it pays for inference in $HERO, and that is all it can do. Writing a checkpoint needs an ECDSA signature
from the wallet that owns the agent NFT, and the encryption key is derived from a wallet signature, so
without a wallet there is no signature, no key, and no private memory. Collapsing the two would mean
someone else holding the key that decrypts your memory, which is the one thing this project exists to
avoid. The wallet is generated for you so it costs you a funding step, not an understanding step.

## Dependencies

`node/local.mjs` and `node/compaction.mjs` have zero runtime dependencies. `viem` and `fflate` are optional at the library level: `viem` is needed only for the on-chain path, `fflate` and `viem` for the browser SDK. This repo's own tooling (`compile.mjs`) additionally uses `solc` as a dev dependency to build `out/AgentMemory.json` from `contracts/AgentMemory.sol`.

## Security & verification

- **One canonical memory module.** `node/onchain.mjs`'s `OnchainMemory` is the only on-chain memory implementation in this repo; the CLI (`agent.mjs`), the examples, and `test/security.mjs` all import it. There is no second, divergent copy to fall out of sync.
- **Verification is a client responsibility.** The contract does not expose an on-chain `verify()`. Every reader (this library, the CLI, a hosted MCP tool, the browser SDK) must redo the backward walk and re-hash the chain itself before trusting it: walk backward from `headOf(agentId)` via each checkpoint's `prevBlock`, then verify `keccak256(prevHash, data) == newHash` forward across the whole walk. Do not trust a checkpoint's `data` without doing this. See "Verified reads" in [`FORMAT.md`](FORMAT.md) for the exact algorithm.
- **Encryption is per-agent, wallet-derived.** Checkpoints are sealed with AES-256-GCM under a key derived from `keccak256(personal_sign(KEY_MSG))`: no passphrase, nothing to store, only the wallet that signed can decrypt. The `KEY_MSG` is versioned (**v2**, domain-separated and self-warning so a single blind phished signature is not silently reusable) with a **v1** read-only fallback for blobs written before the v2 rollout. Readers try v2 first, then lazily derive v1 only if that decrypt fails.
- **Non-deterministic signers are rejected, not silently mis-keyed.** The browser SDK signs the key message twice at onboarding and refuses to cache a key it cannot reproduce, so a smart-account/MPC wallet that returns a fresh signature every time fails loudly (would otherwise make the owner see their own memory as permanently "sealed") instead of derailing quietly.
- **Truncated reads are reported as partial, never as tamper.** A backward walk that is cut short before reaching an era's genesis (bounded by `maxCheckpoints`) seeds the forward hash-chain verification with the real on-chain `prevHash` of the oldest checkpoint it saw, instead of a manufactured zero hash, and returns `truncated: true` / `verified: false` with the entries it *could* read, rather than throwing a false "history is not authentic". A genuine per-link hash mismatch inside the walked window still throws. `node/onchain.mjs`'s `OnchainMemory.recall()` walks unbounded (full history to genesis) by default and only takes this partial-window path if you opt in with `maxCheckpoints`; the browser SDK and a hosted MCP cap the walk by default for responsiveness.
- **Decompression is bounded.** Every gunzip of a checkpoint's decrypted payload is capped (`maxOutputLength`, 8MB) so a malicious or buggy small on-chain blob cannot gzip-bomb a reader into unbounded memory use.
- **Index by `(agentId, era, seq)`, never `seq` alone.** `rebase()` starts a fresh era at `seq = 0`, so a bare `seq` collides across eras. `era` is part of every `Checkpoint` event and is required to place a checkpoint in its chain.
- **Reads need an archive-node RPC.** A verified read runs `eth_getLogs` on a single historical block per checkpoint, all the way back to the era's genesis (or `maxCheckpoints`, whichever comes first). There is no fallback range-scan for pruned nodes, so point it at an archive endpoint or the walk will fail with a "missing checkpoint" error partway through.
- **`rebase()` is owner-only.** An approved operator or session key can `checkpoint` (routine writes) but cannot `rebase` (which blanks the chain head every future resume reads). This keeps a delegate from being able to erase-by-omission an agent's entire memory; only the wallet holding the NFT can start a new era.
- **Oversized checkpoints revert on-chain.** `MAX_CHECKPOINT_BYTES` bounds a single checkpoint's blob so one write cannot grief indexers, block explorers, or the SDK's own `getLogs` walk with an unbounded event payload.
- **Cover images are public.** For a wallet to render a Memory Card, its image cannot be encrypted. Keep private memory in encrypted checkpoints; make only the cover public.
- **Known gap.** The v1 → v2 migration is still rolling out across surfaces: `node/onchain.mjs` in this repo now resolves its contract address dynamically (`out/deployment.json`, currently v2), but `browser/agent-memory.js` and `FORMAT.md` still hardcode the v1 address as a literal, and a sibling deployment (`hero-agent`) has already moved to v2 independently. `migrate-agentmemory-v2.mjs`'s `REFS` list does not currently include `browser/agent-memory.js`. Reconciling all surfaces onto v2 together is a deliberate follow-up, not something this merge silently changed.

## Status

Alpha. `redteam.mjs` exercises the auth and forgery paths against the live contract, `test/security.mjs` covers the crypto/verification fixes above without touching the network, but treat anything holding value as pre-audit until a professional review lands. Issues and PRs welcome.

## License

MIT. See [LICENSE](LICENSE).
