// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Interfaces of the snarkjs 0.7 generated Groth16 verifiers (generated/Verifier{2,6,12}.sol).
// Public inputs: root, publicAmount, extDataHash, inputNullifier[n], outputCommitment[2].
interface IVerifier2 {
  function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[7] calldata pub) external view returns (bool);
}

interface IVerifier6 {
  function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[11] calldata pub) external view returns (bool);
}

interface IVerifier12 {
  function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[17] calldata pub) external view returns (bool);
}
