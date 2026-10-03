pragma circom 2.2.0;

// Measures what the authorization block of transaction.circom costs on its own (msg hash + curve checks + EdDSA).
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/eddsaposeidon.circom";

template Probe() {
    signal input m[6];
    signal input Ax; signal input Ay; signal input R8x; signal input R8y; signal input S;
    component msg = Poseidon(6);
    for (var i = 0; i < 6; i++) msg.inputs[i] <== m[i];
    component a = BabyCheck(); a.x <== Ax; a.y <== Ay;
    component r = BabyCheck(); r.x <== R8x; r.y <== R8y;
    component sig = EdDSAPoseidonVerifier();
    sig.enabled <== 1; sig.Ax <== Ax; sig.Ay <== Ay; sig.S <== S; sig.R8x <== R8x; sig.R8y <== R8y; sig.M <== msg.out;
}
component main {public [m]} = Probe();
