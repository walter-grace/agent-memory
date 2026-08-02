# Interoperability contract

This document is the wire contract for wallet-owned agent memory. Any surface that holds the same
wallet (Node CLI, browser SDK, MCP server) produces and consumes the same bytes, so a memory written
on one is readable on every other. The constants below are read from the source, not restated from
memory: `node/onchain.mjs` and `browser/agent-memory.js` are the reference.

## Chain and contract

- Contract address: `0x881a9f7ed58b7655c3c04bb2f9ef2cffd233a5ef`
- Chain id: `4663` (hex `0x1237`), Robinhood Chain
- Default RPC: `https://rpc.mainnet.chain.robinhood.com`

The contract address is public. The 40-hex address above is safe to commit. A 64-hex private key is
not; it never appears in this repo.

## Canonical blob format

Every checkpoint payload is a single byte string laid out as:

```
[1 marker byte][IV: 12 bytes][ciphertext]
```

The first byte selects how the rest is read:

| Marker | Meaning                       | Layout                          | Written by             |
|--------|-------------------------------|---------------------------------|------------------------|
| 0      | plaintext gzip                | `[0x00][gzip(json)]` (no IV)    | either surface, opt-in |
| 1      | passphrase / PBKDF2 encrypted | `[0x01][IV 12][ciphertext]`     | reserved, not written here |
| 2      | wallet-derived AES-256-GCM    | `[0x02][IV 12][ciphertext]`     | Node OnchainMemory, browser SDK |

Node `OnchainMemory` writes marker 2. Marker 1 is reserved for passphrase-encrypted memory; both
backends in this repo treat marker 1 as sealed and will not read it, so writing marker 1 from another
tool would make that memory unreadable here. Marker 0 is plaintext gzip with no IV and no encryption:
the browser SDK writes it only when `isPublic` is set.

For markers 1 and 2 the ciphertext is AES-256-GCM output (the 16-byte GCM auth tag is appended to the
ciphertext by the Web Crypto / Node webcrypto `encrypt`, so it travels inside the ciphertext field).
The plaintext inside is gzip of a JSON document (see "Payload envelope" below).

## Key derivation

The AES-GCM key is derived from the wallet signature, with no key stored anywhere:

```
key = keccak256( personal_sign( KEY_MSG ) )
```

There are two `KEY_MSG` versions. The 32 bytes of the keccak256 hash of the signature are imported
directly as a raw AES-GCM key in both cases. ECDSA signatures are deterministic (RFC 6979), so the
same wallet always signs a given message the same way and always derives the same key. There is
nothing to store or share: hold the wallet, hold the key. On-chain observers see only the marker byte,
a random IV, and ciphertext.

### v2 (current — all writes use this)

`KEY_MSG` is exactly this string (with real newlines, contract address interpolated):

```
Hero Run Agent Memory key v2
Only sign this on herorunai.com. It derives the private key to your agent memory. Never sign it on any other site.
Contract: 0x881a9f7ed58b7655c3c04bb2f9ef2cffd233a5ef
Chain: 4663
```

The v2 message is domain-separated and self-warning, so a single blind phished signature is not
silently reusable, and it is versioned so it can rotate in future. This string is **byte-identical
across every surface** (Node, browser SDK, hosted MCP) — that is the whole point: the same wallet must
derive the same key everywhere for cross-surface interop.

### v1 (legacy — read-only fallback)

Blobs written before v2 were sealed with the v1 message:

```
Hero Agent Memory encryption key v1
Contract: 0x881a9f7ed58b7655c3c04bb2f9ef2cffd233a5ef
Chain: 4663
```

### Write / read rule

- **Writers** always seal with the **v2** key.
- **Readers** derive the v2 key eagerly and try it first. If an AES-GCM decrypt of a marker-2 blob
  fails, they lazily derive the **v1** key (from the v1 message) and retry once. So a normal session
  is one signature; only a wallet with pre-existing v1 blobs pays a second signature, and only when an
  old blob is actually encountered.

### Honest limitation

A portable cross-surface key **cannot** bind to a web origin — if it did, the key would differ per
surface and interop would break. The v2 domain-separation is therefore not origin-binding: the warning
line ("Only sign this on herorunai.com … Never sign it on any other site") and the version number are
the mitigation, reducing blind-signature reuse and enabling rotation, not a cryptographic guarantee
that the signature was produced on herorunai.com.

Node (`node/onchain.mjs`): `raw = toBytes(keccak256(toBytes(sig)))`, then
`webcrypto.subtle.importKey("raw", raw, "AES-GCM", ...)`.
Browser (`browser/agent-memory.js`): `raw = hexToBytes(keccak256(sig))`, then
`crypto.subtle.importKey("raw", raw, "AES-GCM", ...)`. Same 32 bytes, same key.

## Checkpoint event layout

Writes call `checkpoint(uint256 agentId, bytes data)`. The contract emits:

```
Checkpoint(uint256 indexed agentId, uint64 indexed era, uint64 seq,
           uint64 prevBlock, bytes32 hash, bytes32 prevHash, bytes data)
```

- topic0: `keccak256("Checkpoint(uint256,uint64,uint64,uint64,bytes32,bytes32,bytes)")`
- topic1: `agentId` (indexed)
- topic2: `era` (indexed)

The non-indexed log `data` is standard ABI encoding, 32-byte words:

| Word | Contents                                  |
|------|-------------------------------------------|
| 0    | `seq`                                     |
| 1    | `prevBlock`                               |
| 2    | `hash`                                     |
| 3    | `prevHash`                                |
| 4    | offset to the `data` bytes param          |
| 5    | length of the `data` bytes (in bytes)     |
| 6+   | the `data` bytes payload (the canonical blob above) |

The encrypted payload is the trailing `data` bytes param, not the whole log data. Node `_all()`
extracts it by reading the offset at word 4, then the length at that offset, then that many bytes:

```
off = parseInt(hex.slice(4*64, 5*64), 16) * 2   // offset to the bytes param
len = parseInt(hex.slice(off, off + 64), 16) * 2 // its byte length
blob = hex.slice(off + 64, off + 64 + len)       // the canonical blob
```

The browser `decodeCheckpoint()` reads the same words to recover `seq`, `prevBlock`, the chain hash,
and the `data` bytes for the backward hash-chain walk.

## ROOT index convention

Compaction does not delete raw memories. Raw checkpoints stay as immutable leaves; the compacted
index is written as one more entry, marked with the `root::` prefix on an `agent`-role entry.

- `setRoot(text)` appends an entry `{ role: "agent", text: "root::" + text }`.
- `getRoot()` returns the most recent `root::` entry (text stripped of the prefix) and its `seq`.
- `sinceRoot()` returns the raw leaves recorded after that ROOT, which are the inputs to the next
  compaction pass.
- `raw()` returns leaves only, filtering the `root::` entries out.

## Shared memory interface

Both backends (`LocalMemory`, `OnchainMemory`) implement the same async interface, so the harness and
the compaction step do not care which is in use:

- `append(entries)` where `entries` is `[{ role, text }]`
- `raw()` returns the leaf entries (ROOT entries excluded)
- `getRoot()` returns `{ text, seq }` for the latest ROOT, or `null`
- `setRoot(text)` writes a new ROOT
- `sinceRoot()` returns leaves recorded after the latest ROOT
- `label()` returns a human-readable backend id, e.g. `local:<file>` or `robinhood-chain:agent#<id>`

## Interop guarantee

A memory written by any surface that holds the same wallet is readable by every other surface that
holds it, because they all share this contract, this key derivation, and this blob format. There is
no server, no shared secret, and no indexer in the path: the wallet is the credential and the
decryption key at once.

## Payload envelope

The gzip'd JSON inside every blob is one canonical shape on every surface:

```json
{ "v": 1, "at": "<ISO 8601 write time>", "entries": [{ "role": "...", "text": "..." }] }
```

Writers seal this envelope. Readers accept it, and also accept a legacy shape: early Node
`OnchainMemory` versions sealed a bare `entries` array with no wrapper, and those blobs are
immutable on-chain, so every reader stays tolerant of both:

```js
const list = Array.isArray(doc) ? doc : (doc.entries || []);
```

A bare-array blob has no `at`; readers surface `at` only when the envelope provides it.

## Verified reads

Both readers are tamper-evident. The read starts from `headOf(agentId)` (the contract's running
keccak head: `hash`, `count`, `lastBlock`, `era`), walks `prevBlock` backwards one block at a time
(no indexer), rebuilds the chain with `keccak256(encodePacked(["bytes32","bytes"], [h, data]))`
over the raw blob of every checkpoint, sealed or not, and checks the final hash against
`headOf(agentId).hash`. Any link mismatch or head mismatch fails the read; a blob the caller's
wallet cannot decrypt is skipped after it has participated in verification. The browser
implementation is `recall()` in `browser/agent-memory.js`; the Node port is `_all()` in
`node/onchain.mjs`. `headOf` and `prevBlock` are the source of truth for block positions: on Orbit
chains, event block numbers are ArbSys numbers, so `eth_blockNumber` is never consulted.

Only the current era is walked. An era bump resets the chain; `headOf` reports the live era and
the walk verifies exactly the checkpoints belonging to it.

### Partial (truncated) reads

The browser SDK and the hosted MCP cap the backward walk at `maxCheckpoints` (default 200) for
responsiveness. When `headOf(agentId).count` exceeds that cap, the walk covers only the most recent
`maxCheckpoints` — a window that does not begin at genesis. Such a read:

- seeds the running hash with the earliest walked checkpoint's on-chain `prevHash` (not zero), so the
  per-link keccak check still validates the window's internal integrity;
- **skips** the from-zero comparison against `headOf().hash` (which would necessarily fail for a
  truncated window);
- returns `verified: false` with a `reason`/`partial` note like `partial (last 200 of 250)` and
  **never throws a tamper error**.

A genuine per-link mismatch inside the walked window still throws. Truncation is an availability
tradeoff (a partial view), not tampering, and must never be surfaced as "memory may be tampered".
The Node `_all()` reader walks the full `count` and so always does the from-zero head comparison.

### What the hash chain does and does not prove

The keccak hash chain proves **order and integrity** — that the returned checkpoints are in their
recorded sequence and that no blob was altered after the fact — and the contract restricts writes to
the agent's owner. It does **not** vouch for the **truth of the content**: an owner (or anything with
the owner's key) can write false or misleading memories, and those are just as "verified" as accurate
ones. Hash-chain verification is tamper-evidence for history, not a guarantee against bad or poisoned
content.
