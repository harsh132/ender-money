pragma circom 2.2.0;

include "./transaction.circom";

// Tree height 23 = Nova's production height (config.js MERKLE_TREE_HEIGHT, circuit_prod). Repo default 5 is test-only.
// zeroLeaf: unused by the template (as in Nova). The value below is Nova's Tornado-fork Poseidon(zero, zero), kept verbatim;
// with the standard circomlib Poseidon used here it would be 0x13e37f2d6cb86c78ccc1788607c2b199788c6bb0a615a21f2e7a8e88384222f8.
// default `zero` value is keccak256("tornado") % FIELD_SIZE = 21663839004416932945382355908790599225266501822907911457504978515578255421292
// port: Circom 2 needs public inputs listed; circom orders them by declaration, matching Nova's verifier input order.
component main {public [root, publicAmount, extDataHash, inputNullifier, outputCommitment]} = Transaction(23, 16, 2, 11850551329423159860688778991827824730037759162201783566284850822760196767874);
