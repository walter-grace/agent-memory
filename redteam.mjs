// Red-team AgentMemory on RH mainnet. Attacker = a random throwaway wallet that owns NOTHING.
// Auth checks use simulateContract (eth_call with from=attacker) → proves the revert without
// spending gas. Forgery checks attack the off-chain recall verifier directly.
import { createPublicClient, http, keccak256, encodePacked, hexToBytes, bytesToHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync } from "node:fs";
import { privateKey } from "./lib/env.mjs";

const RH = "https://rpc.mainnet.chain.robinhood.com";
const chain = { id: 4663, name: "RH", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RH] } } };
const pub = createPublicClient({ chain, transport: http(RH) });
const { abi, address: MEM } = { ...JSON.parse(readFileSync("out/AgentMemory.json", "utf8")), ...JSON.parse(readFileSync("out/deployment.json", "utf8")) };

const attacker = privateKeyToAccount(generatePrivateKey()); // owns nothing, has no gas
const owner = privateKeyToAccount(privateKey());
let pass = 0, fail = 0;
const ok = (name) => { console.log(`  ✓ BLOCKED: ${name}`); pass++; };
const bad = (name, detail) => { console.log(`  ✗ GAMED: ${name} — ${detail}`); fail++; };

// expect a state-changing call from `from` to REVERT
async function expectRevert(name, functionName, args, from) {
  try {
    await pub.simulateContract({ address: MEM, abi, functionName, args, account: from });
    bad(name, "call SUCCEEDED — this should have reverted");
  } catch (e) {
    ok(`${name} (${(e.shortMessage || e.message).replace(/\n.*/s, "").slice(0, 60)})`);
  }
}

(async () => {
  console.log(`\nAttacker ${attacker.address} (owns nothing) vs owner ${owner.address}`);
  console.log(`Contract ${MEM} on Robinhood Chain\n`);
  console.log("== 1. Can a stranger tamper with an agent they don't own? ==");
  await expectRevert("checkpoint someone else's agent #1", "checkpoint", [1n, "0xdeadbeef"], attacker);
  await expectRevert("rebase (wipe head of) someone else's agent #1", "rebase", [1n], attacker);
  await expectRevert("steal agent #1 via transferFrom", "transferFrom", [owner.address, attacker.address, 1n], attacker);
  await expectRevert("write to a nonexistent agent #9999", "checkpoint", [9999n, "0xdead"], attacker);
  await expectRevert("approve yourself on someone else's agent", "approve", [attacker.address, 1n], attacker);

  console.log("\n== 2. Positive control: the real owner CAN write (simulate, no tx) ==");
  try { await pub.simulateContract({ address: MEM, abi, functionName: "checkpoint", args: [1n, "0x00deadbeef"], account: owner }); ok("owner checkpoint simulates fine"); }
  catch (e) { bad("owner checkpoint", e.shortMessage || e.message); }

  console.log("\n== 2b. H1: an approved operator can checkpoint but must NOT be able to rebase ==");
  // A session key or delegate granted approve()/setApprovalForAll should be able to do routine
  // writes on the owner's behalf, but rebase() blanks the whole chain head — that must stay
  // owner-only, or an approved operator could erase-by-omission an agent's entire memory.
  const operator = privateKeyToAccount(generatePrivateKey());
  try {
    await pub.simulateContract({ address: MEM, abi, functionName: "approve", args: [operator.address, 1n], account: owner });
    ok("owner can approve() an operator (simulate)");
  } catch (e) { bad("owner approve", e.shortMessage || e.message); }
  try {
    await pub.simulateContract({ address: MEM, abi, functionName: "checkpoint", args: [1n, "0x00deadbeef"], account: operator });
    ok("approved operator CAN checkpoint (simulate) — expected, this is fine");
  } catch (e) { bad("approved operator checkpoint", e.shortMessage || e.message); }
  await expectRevert("approved operator CANNOT rebase (must revert)", "rebase", [1n], operator);
  try {
    await pub.simulateContract({ address: MEM, abi, functionName: "setApprovalForAll", args: [operator.address, true], account: owner });
    ok("owner can setApprovalForAll (simulate)");
  } catch (e) { bad("owner setApprovalForAll", e.shortMessage || e.message); }
  await expectRevert("setApprovalForAll operator CANNOT rebase (must revert)", "rebase", [1n], operator);
  try {
    await pub.simulateContract({ address: MEM, abi, functionName: "rebase", args: [1n], account: owner });
    ok("owner (only) CAN rebase (simulate)");
  } catch (e) { bad("owner rebase", e.shortMessage || e.message); }

  console.log("\n== 2c. Oversized checkpoint data is rejected on-chain ==");
  // MAX_CHECKPOINT_BYTES bounds the blob so a single checkpoint can't grief indexers/RPCs with an
  // unbounded event payload. One byte over the limit must revert; at the limit it must not.
  const maxBytesHex = abi.find((x) => x.type === "function" && x.name === "MAX_CHECKPOINT_BYTES");
  if (!maxBytesHex) console.log("  (contract has no MAX_CHECKPOINT_BYTES — skipping, deploy the fix first)");
  else {
    const cap = await pub.readContract({ address: MEM, abi, functionName: "MAX_CHECKPOINT_BYTES" });
    const overData = bytesToHex(new Uint8Array(Number(cap) + 1));
    await expectRevert(`checkpoint over MAX_CHECKPOINT_BYTES (${cap}B)`, "checkpoint", [1n, overData], owner);
    const atCapData = bytesToHex(new Uint8Array(Number(cap)));
    try { await pub.simulateContract({ address: MEM, abi, functionName: "checkpoint", args: [1n, atCapData], account: owner }); ok(`checkpoint at exactly the cap (${cap}B) simulates fine`); }
    catch (e) { bad(`checkpoint at exactly the cap (${cap}B)`, e.shortMessage || e.message); }
  }

  console.log("\n== 3. Can a forged/tampered history pass the hash-chain verifier? ==");
  // Pull agent #1's real checkpoints, then attack the verifier used by SDK/MCP/browser.
  const head = await pub.readContract({ address: MEM, abi, functionName: "headOf", args: [1n] });
  const [headHash, count, lastBlock, era] = head;
  const ev = abi.find((x) => x.type === "event" && x.name === "Checkpoint");
  const logs = [];
  let blk = BigInt(lastBlock);
  for (let i = 0; i < Number(count) && blk > 0n; i++) {
    const l = await pub.getLogs({ address: MEM, event: ev, args: { agentId: 1n, era }, fromBlock: blk, toBlock: blk });
    l.sort((a, b) => Number(a.logIndex - b.logIndex));
    logs.unshift(...l);
    blk = BigInt(l[0].args.prevBlock);
  }
  const verify = (chainLogs) => {
    let h = "0x" + "0".repeat(64);
    for (const l of chainLogs) {
      if (keccak256(encodePacked(["bytes32", "bytes"], [h, l.args.data])) !== l.args.newHash) return false;
      h = l.args.newHash;
    }
    return h === headHash;
  };
  // real history verifies
  if (verify(logs)) ok("real history verifies (control)"); else bad("real history", "genuine chain failed to verify!");
  // attack A: swap a memory's bytes but keep its newHash
  {
    const forged = logs.map((l, i) => i === 1 ? { ...l, args: { ...l.args, data: bytesToHex(new Uint8Array([0, 1, 2, 3, 4, 5])) } } : l);
    verify(forged) ? bad("byte-swap forgery", "tampered data passed verification") : ok("byte-swapped memory rejected");
  }
  // attack B: reorder two checkpoints
  {
    const forged = [...logs]; if (forged.length > 1) [forged[0], forged[1]] = [forged[1], forged[0]];
    verify(forged) ? bad("reorder forgery", "reordered history passed") : ok("reordered history rejected");
  }
  // attack C: drop a checkpoint (truncate the middle)
  {
    const forged = logs.filter((_, i) => i !== Math.floor(logs.length / 2));
    verify(forged) ? bad("drop-checkpoint forgery", "history with a gap passed") : ok("dropped checkpoint rejected");
  }
  // attack D: inject a fabricated memory at the end with a self-consistent hash
  {
    const fakeData = bytesToHex(new Uint8Array([0, 9, 9, 9]));
    const fakeHash = keccak256(encodePacked(["bytes32", "bytes"], [headHash, fakeData]));
    const forged = [...logs, { args: { data: fakeData, newHash: fakeHash, seq: count, prevBlock: lastBlock } }];
    verify(forged) ? bad("append forgery", "injected memory passed vs on-chain head") : ok("appended fake memory rejected (head mismatch)");
  }

  console.log("\n== 4. Can a stranger read PRIVATE memory? ==");
  // marker-2 blobs are AES-GCM under a key = keccak(sign(fixed msg)). A different wallet derives a
  // different key → decrypt throws. (Proven live in the MCP test earlier; re-assert the property.)
  const sealed = logs.map((l) => hexToBytes(l.args.data)).find((b) => b[0] === 2);
  if (!sealed) console.log("  (no marker-2 blob on agent #1 to test here; covered by MCP stranger test)");
  else {
    const { webcrypto } = await import("node:crypto");
    const wrongKey = await webcrypto.subtle.importKey("raw", hexToBytes(keccak256("0xdeadbeef")), "AES-GCM", false, ["decrypt"]);
    try { await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(1, 13) }, wrongKey, sealed.subarray(13)); bad("private read", "wrong key decrypted!"); }
    catch { ok("private memory undecryptable with wrong key"); }
  }

  console.log(`\n${fail === 0 ? "🛡  ALL ATTACKS BLOCKED" : "⚠  " + fail + " HOLES FOUND"} — ${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
})();
