// End-to-end proof-of-contents: compute the commitment, prove the sealed dataset matches the
// advertised count+checksum without revealing records, verify, and export a Solidity verifier.
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { buildPoseidon } from "circomlibjs";

const sh = (c) => { console.log("$ " + c); execSync(c, { stdio: "inherit" }); };

// 1) the dataset (private) + the advertised claims (public)
const records = [10n, 20n, 30n, 40n, 0n, 0n, 0n, 0n];       // 4 real records, zero-padded to 8
const claimedCount = 4n;
const claimedSum = 100n;                                     // 10+20+30+40

const poseidon = await buildPoseidon();
const F = poseidon.F;
const commitment = F.toObject(poseidon(records));           // Poseidon over the 8 slots
console.log("commitment:", commitment.toString());

writeFileSync("input.json", JSON.stringify({
  records: records.map(String),
  claimedCount: claimedCount.toString(),
  claimedSum: claimedSum.toString(),
  commitment: commitment.toString(),
}));

// 2) compile the circuit
sh("./circom proof_of_contents.circom --r1cs --wasm --sym -l node_modules");

// 3) trusted setup (Groth16): tiny powers-of-tau is fine — this circuit has few constraints
sh("node_modules/.bin/snarkjs powersoftau new bn128 12 pot12_0.ptau -v");
sh('node_modules/.bin/snarkjs powersoftau contribute pot12_0.ptau pot12_1.ptau --name="hero" -v -e="hero-run entropy"');
sh("node_modules/.bin/snarkjs powersoftau prepare phase2 pot12_1.ptau pot12_final.ptau -v");
sh("node_modules/.bin/snarkjs groth16 setup proof_of_contents.r1cs pot12_final.ptau poc_0.zkey");
sh('node_modules/.bin/snarkjs zkey contribute poc_0.zkey poc_final.zkey --name="hero2" -v -e="more entropy"');
sh("node_modules/.bin/snarkjs zkey export verificationkey poc_final.zkey vkey.json");

// 4) witness + proof
sh("node proof_of_contents_js/generate_witness.js proof_of_contents_js/proof_of_contents.wasm input.json witness.wtns");
sh("node_modules/.bin/snarkjs groth16 prove poc_final.zkey witness.wtns proof.json public.json");

// 5) verify
sh("node_modules/.bin/snarkjs groth16 verify vkey.json public.json proof.json");

// 6) export the on-chain verifier + calldata
sh("node_modules/.bin/snarkjs zkey export solidityverifier poc_final.zkey Verifier.sol");
const calldata = execSync("node_modules/.bin/snarkjs zkey export soliditycalldata public.json proof.json").toString();
writeFileSync("calldata.txt", calldata);
console.log("\npublic signals:", readFileSync("public.json", "utf8").replace(/\s+/g, " "));
console.log("Verifier.sol exported; calldata.txt written.");
