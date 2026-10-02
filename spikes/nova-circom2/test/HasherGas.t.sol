// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test, console } from "forge-std/Test.sol";

interface IHasher {
  function poseidon(bytes32[2] calldata inputs) external pure returns (bytes32);
}

// Gas of one Poseidon(2) call: standard circomlibjs hasher vs the Tornado-fork hasher Nova used
// (build/HasherFork.json, optional; see README for how it is generated).
contract HasherGasTest is Test {
  function _deploy(string memory f) internal returns (IHasher h) {
    bytes memory code = vm.parseJsonBytes(vm.readFile(f), ".bytecode");
    assembly { h := create(0, add(code, 0x20), mload(code)) }
  }

  function _gas(IHasher h) internal view returns (uint256 g) {
    bytes32[2] memory x = [bytes32(uint256(1)), bytes32(uint256(2))];
    h.poseidon(x); // warm the account
    g = gasleft();
    h.poseidon(x);
    g -= gasleft();
  }

  function test_hasherGas() public {
    console.log("standard Poseidon(2) call gas", _gas(_deploy("build/Hasher.json")));
    if (vm.exists("build/HasherFork.json")) console.log("tornado-fork Poseidon(2) call gas", _gas(_deploy("build/HasherFork.json")));
  }
}
