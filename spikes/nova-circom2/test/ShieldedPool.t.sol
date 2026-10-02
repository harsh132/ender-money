// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ShieldedPool } from "../contracts/ShieldedPool.sol";
import { MockAUSD } from "../contracts/MockAUSD.sol";
import { IVerifier2, IVerifier16 } from "../contracts/IVerifier.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Proof-free checks. Proof paths are covered end-to-end on anvil by scripts/e2e.mjs.
contract ShieldedPoolTest is Test {
  ShieldedPool pool;
  MockAUSD token;
  address hasher;

  function setUp() public {
    bytes memory code = vm.parseJsonBytes(vm.readFile("build/Hasher.json"), ".bytecode");
    assembly { sstore(hasher.slot, create(0, add(code, 0x20), mload(code))) }
    token = new MockAUSD();
    pool = new ShieldedPool(IVerifier2(address(1)), IVerifier16(address(2)), 23, hasher, IERC20(address(token)), 100e6);
  }

  function test_zerosMatchOnChainPoseidon() public view {
    for (uint256 i = 0; i < 32; i++) {
      assertEq(pool.hashLeftRight(pool.zeros(i), pool.zeros(i)), pool.zeros(i + 1));
    }
    assertEq(pool.getLastRoot(), pool.zeros(23));
  }

  function test_publicAmount() public view {
    assertEq(pool.calculatePublicAmount(10e6, 0), 10e6);
    // withdraw 11.9 to recipient + 0.1 fee = -12 from the notes
    assertEq(pool.calculatePublicAmount(-11.9e6, 0.1e6), pool.FIELD_SIZE() - 12e6);
  }

  function test_depositCap() public {
    ShieldedPool.Proof memory p;
    ShieldedPool.ExtData memory e;
    e.extAmount = 100e6 + 1;
    vm.expectRevert("amount is larger than maximumDepositAmount");
    pool.transact(p, e);
  }

  function test_unknownRoot() public {
    ShieldedPool.Proof memory p;
    ShieldedPool.ExtData memory e;
    p.root = bytes32(uint256(123));
    vm.expectRevert("Invalid merkle root");
    pool.transact(p, e);
  }
}
