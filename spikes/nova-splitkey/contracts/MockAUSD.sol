// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// Testnet stand-in for AUSD: 6 decimals, anyone can mint, and a minimal EIP-3009 receiveWithAuthorization
/// (EIP-712, plain ecrecover; real AUSD also accepts ERC-1271 signers).
contract MockAUSD is ERC20("Mock AUSD", "AUSD"), EIP712("Mock AUSD", "1") {
  bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
    keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

  mapping(address => mapping(bytes32 => bool)) public authorizationState;

  function decimals() public pure override returns (uint8) {
    return 6;
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external {
    require(msg.sender == to, "caller must be the payee");
    require(block.timestamp > validAfter && block.timestamp < validBefore, "authorization not valid now");
    require(!authorizationState[from][nonce], "authorization used");
    bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)));
    require(ECDSA.recover(digest, signature) == from, "invalid signature");
    authorizationState[from][nonce] = true;
    _transfer(from, to, value);
  }
}
