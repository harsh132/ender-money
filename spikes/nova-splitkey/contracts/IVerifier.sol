// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Interface of the snarkjs 0.7 generated Groth16 verifier (generated/Verifier2.sol).
interface IVerifier2 {
  function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[7] calldata pub) external view returns (bool);
}
