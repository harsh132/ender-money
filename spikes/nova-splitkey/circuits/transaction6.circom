pragma circom 2.2.0;

include "./transaction.circom";

// Height 23, 6 inputs, 2 outputs. Same public inputs as transaction2, with 6 nullifiers.
component main {public [root, publicAmount, extDataHash, inputNullifier, outputCommitment]} = Transaction(23, 6, 2);
