pragma circom 2.2.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/eddsaposeidon.circom";
include "./merkleProof.circom";

/*
Split-key variant of the Circom 2 port of tornado-nova's transaction.circom.

Keys (one owner per transaction):
  nk         nullifier key, a field element; the gateway holds it and can compute nullifiers and prove
  (Ax, Ay)   spending-authority public key, EdDSA on BabyJubJub; its private key stays on the phone
  ownerKey = Poseidon(Ax, Ay, Poseidon(nk))           (Nova: pubkey = Poseidon(privkey))

Notes:
  commitment = Poseidon(amount, ownerKey, blinding)    (unchanged)
  nullifier  = Poseidon(nk, commitment, pathIndex)     (Nova: Poseidon(commitment, pathIndex, Poseidon(privkey, commitment, pathIndex)))

Authorization: one EdDSA-Poseidon signature by (Ax, Ay) over
  msg = Poseidon(inputNullifier[0..nIns), outputCommitment[0..nOuts), extDataHash, publicAmount)
Every input (dummies included) is owned by the same (Ax, Ay, nk). Chain and pool binding lives in extDataHash
(the pool hashes block.chainid and address(this) into it), so the signature and the proof are bound to one deployment.
nIns + nOuts + 2 <= 16 (circomlib Poseidon width): with 2 outputs, nIns is at most 12 (transaction2, 6 and 12 use it).
*/
template Transaction(levels, nIns, nOuts) {
    signal input root;
    signal input publicAmount; // extAmount - fee, range enforced by the contract
    signal input extDataHash;

    signal input inputNullifier[nIns];
    signal input inAmount[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];

    // owner of all inputs
    signal input nk;
    signal input authAx;
    signal input authAy;
    // phone's signature
    signal input sigR8x;
    signal input sigR8y;
    signal input sigS;

    signal input outputCommitment[nOuts];
    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    component nkHash = Poseidon(1);
    nkHash.inputs[0] <== nk;
    component ownerKey = Poseidon(3);
    ownerKey.inputs[0] <== authAx;
    ownerKey.inputs[1] <== authAy;
    ownerKey.inputs[2] <== nkHash.out;

    component inCommitmentHasher[nIns];
    component inNullifierHasher[nIns];
    component inTree[nIns];
    component inCheckRoot[nIns];
    component inAmountCheck[nIns];
    var sumIns = 0;

    for (var tx = 0; tx < nIns; tx++) {
        inCommitmentHasher[tx] = Poseidon(3);
        inCommitmentHasher[tx].inputs[0] <== inAmount[tx];
        inCommitmentHasher[tx].inputs[1] <== ownerKey.out;
        inCommitmentHasher[tx].inputs[2] <== inBlinding[tx];

        inNullifierHasher[tx] = Poseidon(3);
        inNullifierHasher[tx].inputs[0] <== nk;
        inNullifierHasher[tx].inputs[1] <== inCommitmentHasher[tx].out;
        inNullifierHasher[tx].inputs[2] <== inPathIndices[tx];
        inNullifierHasher[tx].out === inputNullifier[tx];

        inTree[tx] = MerkleProof(levels);
        inTree[tx].leaf <== inCommitmentHasher[tx].out;
        inTree[tx].pathIndices <== inPathIndices[tx];
        for (var i = 0; i < levels; i++) {
            inTree[tx].pathElements[i] <== inPathElements[tx][i];
        }

        // check merkle proof only if amount is non-zero (Nova's dummy-input rule)
        inCheckRoot[tx] = ForceEqualIfEnabled();
        inCheckRoot[tx].in[0] <== root;
        inCheckRoot[tx].in[1] <== inTree[tx].root;
        inCheckRoot[tx].enabled <== inAmount[tx];

        // fix 1 from docs/nova-spike.md: range-check input amounts too (Nova relied on them having been outputs)
        inAmountCheck[tx] = Num2Bits(248);
        inAmountCheck[tx].in <== inAmount[tx];

        sumIns += inAmount[tx];
    }

    component outCommitmentHasher[nOuts];
    component outAmountCheck[nOuts];
    var sumOuts = 0;

    for (var tx = 0; tx < nOuts; tx++) {
        outCommitmentHasher[tx] = Poseidon(3);
        outCommitmentHasher[tx].inputs[0] <== outAmount[tx];
        outCommitmentHasher[tx].inputs[1] <== outPubkey[tx];
        outCommitmentHasher[tx].inputs[2] <== outBlinding[tx];
        outCommitmentHasher[tx].out === outputCommitment[tx];

        outAmountCheck[tx] = Num2Bits(248);
        outAmountCheck[tx].in <== outAmount[tx];

        sumOuts += outAmount[tx];
    }

    component sameNullifiers[nIns * (nIns - 1) / 2];
    var index = 0;
    for (var i = 0; i < nIns - 1; i++) {
      for (var j = i + 1; j < nIns; j++) {
          sameNullifiers[index] = IsEqual();
          sameNullifiers[index].in[0] <== inputNullifier[i];
          sameNullifiers[index].in[1] <== inputNullifier[j];
          sameNullifiers[index].out === 0;
          index++;
      }
    }

    sumIns + publicAmount === sumOuts;

    // ---- spending authority: one signature over everything the transaction does
    component msg = Poseidon(nIns + nOuts + 2);
    for (var i = 0; i < nIns; i++) msg.inputs[i] <== inputNullifier[i];
    for (var i = 0; i < nOuts; i++) msg.inputs[nIns + i] <== outputCommitment[i];
    msg.inputs[nIns + nOuts] <== extDataHash;
    msg.inputs[nIns + nOuts + 1] <== publicAmount;

    // circomlib's verifier does not check that A and R8 are on the curve; doing it costs a few constraints
    component aOnCurve = BabyCheck();
    aOnCurve.x <== authAx;
    aOnCurve.y <== authAy;
    component rOnCurve = BabyCheck();
    rOnCurve.x <== sigR8x;
    rOnCurve.y <== sigR8y;

    component sig = EdDSAPoseidonVerifier();
    sig.enabled <== 1;
    sig.Ax <== authAx;
    sig.Ay <== authAy;
    sig.S <== sigS;
    sig.R8x <== sigR8x;
    sig.R8y <== sigR8y;
    sig.M <== msg.out;
}
