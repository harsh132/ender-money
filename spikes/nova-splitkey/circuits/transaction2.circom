pragma circom 2.2.0;

include "./transaction.circom";

// Tree height 23 (Nova's production height). Public inputs and their order are the Circom 2 port's, so the pool is unchanged apart from the verifier.
component main {public [root, publicAmount, extDataHash, inputNullifier, outputCommitment]} = Transaction(23, 2, 2);
