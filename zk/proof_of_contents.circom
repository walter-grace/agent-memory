pragma circom 2.1.6;

// Proof-of-contents for the memory market: prove that a SEALED dataset (kept private) is exactly the
// one behind a public commitment AND satisfies the advertised description — its record count and its
// checksum — WITHOUT revealing any record. The buyer verifies this against the commitment posted at
// listing time before paying, so "the description matches what's in the dataset" becomes checkable,
// not trusted. This is the first ZK-v2 primitive; it composes with proof-of-correct-encryption / ZKCP
// to remove the arbiter entirely.
//
// Public:  commitment (Poseidon of the padded records), claimedCount, claimedSum.
// Private: records[N] (the dataset, zero-padded to N).
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

template ProofOfContents(N) {
    signal input records[N];       // private
    signal input claimedCount;     // public
    signal input claimedSum;       // public
    signal input commitment;       // public

    // 1) The commitment binds these exact records — the seller cannot show one dataset and sell another.
    component H = Poseidon(N);
    for (var i = 0; i < N; i++) { H.inputs[i] <== records[i]; }
    H.out === commitment;

    // 2) Count of non-zero records == claimedCount (records are zero-padded to N).
    component isz[N];
    signal nz[N];
    signal countAcc[N + 1];
    countAcc[0] <== 0;
    for (var i = 0; i < N; i++) {
        isz[i] = IsZero();
        isz[i].in <== records[i];
        nz[i] <== 1 - isz[i].out;             // 1 if the slot holds a real record
        countAcc[i + 1] <== countAcc[i] + nz[i];
    }
    countAcc[N] === claimedCount;

    // 3) Sum of records == claimedSum (a checksum over the advertised column).
    signal sumAcc[N + 1];
    sumAcc[0] <== 0;
    for (var i = 0; i < N; i++) { sumAcc[i + 1] <== sumAcc[i] + records[i]; }
    sumAcc[N] === claimedSum;
}

component main { public [claimedCount, claimedSum, commitment] } = ProofOfContents(8);
