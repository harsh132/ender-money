// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Interfaces of the snarkjs 0.7 generated Groth16 verifiers (Verifier2.sol / Verifier16.sol).
interface IVerifier2 {
  function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[7] calldata pub) external view returns (bool);
}

interface IVerifier16 {
  function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[21] calldata pub) external view returns (bool);
}
