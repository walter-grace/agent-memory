# ZK v2 — trustless proofs for the memory market

The bonded-escrow market (`contracts/HeroMemoryMarket.sol`) has one irreducible trust point: fair
exchange of a *secret* (the decryption key) for money has no fully trustless solution without
zero-knowledge proofs. v1 handles it with a seller bond + an arbiter whose job is narrow and
objective. **ZK removes the arbiter entirely.** This directory is the working first step.

## 1. Proof-of-contents — DONE, verifies end to end

`proof_of_contents.circom` proves that a **sealed dataset**, kept private, is exactly the one behind
a public commitment **and** satisfies its advertised description (record count + checksum) — without
revealing a single record. The buyer checks this against the commitment a seller posts at listing,
so *"the description matches what's in the dataset"* becomes verifiable, not trusted.

- Public: `commitment` (Poseidon of the padded records), `claimedCount`, `claimedSum`.
- Private: `records[8]`.
- Constraints: `Poseidon(records) == commitment`, count of non-zero slots `== claimedCount`,
  `sum(records) == claimedSum`.

Run it:

```bash
npm install snarkjs circomlib circomlibjs
curl -sL -o circom https://github.com/iden3/circom/releases/latest/download/circom-macos-amd64 && chmod +x circom
node run.mjs      # compile → trusted setup → prove → verify → export Verifier.sol + calldata
```

Verified live: an honest dataset (`[10,20,30,40]`, count 4, sum 100) proves and verifies (`OK!`); a
false claim (sum 999) is **rejected at witness generation** — the circuit enforces the claim. The
exported `Verifier.sol` is a standard Groth16 verifier (~250k gas), proof calldata ~775 bytes, so
Robinhood Chain can verify a proof on-chain cheaply.

## 2. Proof-of-correct-encryption — NEXT

Prove that the ECIES `salekey::` wrap the seller posts decrypts the committed ciphertext to plaintext
whose commitment equals the advertised one. This makes **key delivery verifiable**: a bad key cannot
produce a valid proof, so the buyer checks the proof instead of trusting a dispute. Proving AES-GCM
in-circuit is expensive, so the practical route is a SNARK-friendly cipher for the wrapped payload (or
a hash-lock reveal, below) rather than proving full AES.

## 3. Zero-knowledge contingent payment (ZKCP) — the endgame

The classic construction (Maxwell 2016): the seller encrypts the key under a fresh key `k` and proves
in ZK that (a) the ciphertext decrypts under `k` to a key that correctly opens the committed data, and
(b) `y = H(k)`. The buyer pays into a hash-lock that releases the payment on-chain **only** when `k`
is revealed, which simultaneously hands the buyer a provably-correct key. Atomic, trustless — it
removes the **bond, the arbiter, and the dispute window** all at once. `HeroMemoryMarket` v2 becomes a
proof-gated hash-lock swap instead of a bonded escrow.

## Integration path into the market

1. Listing posts a Poseidon `commitment` of the dataset (alongside the AgentMemory head hash) + a
   proof-of-contents. The `/market` UI verifies the proof before showing "buy".
2. Add the generated `Verifier.sol` to the market and gate `buy`/`settle` on `verifyProof(...)`.
3. Swap the bond+arbiter path for the ZKCP hash-lock once proof-of-correct-encryption lands.

Files: `proof_of_contents.circom` (circuit), `run.mjs` (full pipeline), `Verifier.sol` (exported
on-chain verifier), `vkey.json` / `proof.json` / `public.json` (a verified example).
