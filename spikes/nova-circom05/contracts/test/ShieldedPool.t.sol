// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { Test } from "forge-std/Test.sol";
import { ShieldedPool, IVerifier, IERC20 } from "../src/ShieldedPool.sol";
import { MockAUSD } from "../src/MockAUSD.sol";

// Proof-free checks. Proof paths (deposit/merge/transfer/withdraw/16-in, replay, tamper) run in scripts/e2e.js.
contract ShieldedPoolTest is Test {
  ShieldedPool pool;
  MockAUSD token;

  function setUp() public {
    token = new MockAUSD();
    // verifiers/hasher are never reached by these tests (all revert earlier)
    pool = new ShieldedPool(IVerifier(address(1)), IVerifier(address(2)), 23, address(3), IERC20(address(token)), 1000e6);
  }

  function _args(uint256 n) internal pure returns (ShieldedPool.Proof memory p) {
    p.inputNullifiers = new bytes32[](n);
  }

  function testEmptyRootIsZeros23() public view {
    assertEq(pool.getLastRoot(), pool.zeros(23));
  }

  function testPublicAmount() public view {
    assertEq(pool.calculatePublicAmount(10e6, 0), 10e6);
    assertEq(pool.calculatePublicAmount(-11.9e6, 0.1e6), pool.FIELD_SIZE() - 12e6);
    assertEq(pool.calculatePublicAmount(0, 0), 0);
  }

  function testDepositCap() public {
    token.mint(address(this), 1001e6);
    token.approve(address(pool), type(uint256).max);
    ShieldedPool.ExtData memory e;
    e.extAmount = 1001e6;
    vm.expectRevert("amount is larger than maximumDepositAmount");
    pool.transact(_args(2), e);
  }

  function testUnknownRoot() public {
    ShieldedPool.Proof memory p = _args(2);
    p.root = bytes32(uint256(123));
    ShieldedPool.ExtData memory e;
    vm.expectRevert("Invalid merkle root");
    pool.transact(p, e);
  }

  function testExtDataHashBinding() public {
    ShieldedPool.Proof memory p = _args(2);
    p.root = pool.getLastRoot();
    ShieldedPool.ExtData memory e;
    e.recipient = address(0xBEEF);
    p.extDataHash = bytes32(uint256(keccak256(abi.encode(e))) % pool.FIELD_SIZE());
    e.recipient = address(0xBAD);
    vm.expectRevert("Incorrect external data hash");
    pool.transact(p, e);
  }

  function testUnsupportedInputCount() public {
    ShieldedPool.Proof memory p = _args(3);
    p.root = pool.getLastRoot();
    ShieldedPool.ExtData memory e;
    p.extDataHash = bytes32(uint256(keccak256(abi.encode(e))) % pool.FIELD_SIZE());
    vm.expectRevert("unsupported input count");
    pool.transact(p, e);
  }
}
