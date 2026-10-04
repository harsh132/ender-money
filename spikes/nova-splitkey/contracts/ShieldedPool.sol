// SPDX-License-Identifier: MIT
// Minimal port of tornado-nova contracts/TornadoPool.sol (Solidity 0.7) to 0.8.
// Kept: Merkle tree with root history, nullifier set, transact(Proof, ExtData), extDataHash binding,
// publicAmount = extAmount - fee, relayer fee in the token, one verifier per input count, deposit cap.
// Removed: OmniBridge/ERC-677 (onTokenBridged/onTransact), L1Unwrapper/isL1Withdrawal/l1Fee,
// CrossChainGuard + upgradeable proxy + initializer, multisig/governance (configureLimits, rescueTokens),
// register()/Account public-key registry, lastBalance.
// Split-key spike (vs ../nova-circom2): Verifier2/6/12 instead of Verifier2/16, picked by the number of nullifiers;
// ExtData gains `deadline` (the SMS quote's expiry, enforced here); extDataHash also hashes block.chainid and
// address(this), binding signature and proof to one deployment.
// EIP-3009 deposits and guardrails: deposits only through depositWithAuthorization (AUSD receiveWithAuthorization,
// nonce = keccak256(extDataHash, outputCommitment0, outputCommitment1), computed here); transfers and deposits only
// from the gateway; withdrawals open to anyone only when both outputs are the null commitment (then no leaves are
// inserted); admin rotates the gateway.
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IVerifier2, IVerifier6, IVerifier12 } from "./IVerifier.sol";
import { MerkleTreeWithHistory } from "./MerkleTreeWithHistory.sol";

/// AUSD's EIP-3009 receive (bytes-signature overload; AUSD also has the v, r, s one).
interface IERC3009 {
  function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external;
}

contract ShieldedPool is MerkleTreeWithHistory, ReentrancyGuard {
  using SafeERC20 for IERC20;

  int256 public constant MAX_EXT_AMOUNT = 2**248;
  uint256 public constant MAX_FEE = 2**248;

  IVerifier2 public immutable verifier2;
  IVerifier6 public immutable verifier6;
  IVerifier12 public immutable verifier12;
  IERC20 public immutable token;
  uint256 public immutable maximumDepositAmount;
  // Poseidon(0, 0, 0) (circomlibjs): the commitment of an empty output (amount 0, owner key 0, blinding 0).
  bytes32 public constant NULL_COMMITMENT = 0x0bc188d27dcceadc1dcfb6af0a7af08fe2864eecec96c5ae7cee6db31ba599aa;

  address public immutable admin; // production: a multisig
  address public gateway;

  mapping(bytes32 => bool) public nullifierHashes;

  struct ExtData {
    address recipient;
    int256 extAmount;
    address relayer;
    uint256 fee;
    uint256 deadline;
    bytes encryptedOutput1;
    bytes encryptedOutput2;
  }

  struct Proof {
    bytes proof; // abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c), 256 bytes
    bytes32 root;
    bytes32[] inputNullifiers;
    bytes32[2] outputCommitments;
    uint256 publicAmount;
    bytes32 extDataHash;
  }

  event NewCommitment(bytes32 commitment, uint256 index, bytes encryptedOutput);
  event NewNullifier(bytes32 nullifier);

  constructor(
    IVerifier2 _verifier2,
    IVerifier6 _verifier6,
    IVerifier12 _verifier12,
    uint32 _levels,
    address _hasher,
    IERC20 _token,
    uint256 _maximumDepositAmount,
    address _gateway,
    address _admin
  ) MerkleTreeWithHistory(_levels, _hasher) {
    verifier2 = _verifier2;
    verifier6 = _verifier6;
    verifier12 = _verifier12;
    token = _token;
    maximumDepositAmount = _maximumDepositAmount;
    gateway = _gateway;
    admin = _admin;
  }

  function setGateway(address _gateway) external {
    require(msg.sender == admin, "only admin");
    gateway = _gateway;
  }

  /**
   * @dev Transfers and withdrawals. Gateway only, except a withdrawal whose two outputs are both the null commitment
   * (it creates no note, so anyone may submit it: the exit that doesn't need the gateway).
   */
  function transact(Proof memory _args, ExtData memory _extData) public {
    require(_extData.extAmount <= 0, "deposits: depositWithAuthorization");
    require(msg.sender == gateway || (_extData.extAmount < 0 && _nullOutputs(_args)), "only gateway");
    _transact(_args, _extData);
  }

  /**
   * @dev Deposit pulled from `_from` with its EIP-3009 ReceiveWithAuthorization{to: this, value: extAmount,
   * validAfter: 0, validBefore: deadline, nonce}. The nonce is computed here, never passed in, so the authorization
   * pins extData (through extDataHash, which _transact checks against _extData) and both output commitments.
   */
  function depositWithAuthorization(Proof memory _args, ExtData memory _extData, address _from, bytes memory _signature) public {
    require(msg.sender == gateway, "only gateway");
    require(_extData.extAmount > 0, "not a deposit");
    require(uint256(_extData.extAmount) <= maximumDepositAmount, "amount is larger than maximumDepositAmount");
    bytes32 nonce = keccak256(abi.encode(_args.extDataHash, _args.outputCommitments[0], _args.outputCommitments[1]));
    IERC3009(address(token)).receiveWithAuthorization(_from, address(this), uint256(_extData.extAmount), 0, _extData.deadline, nonce, _signature);
    _transact(_args, _extData);
  }

  function _nullOutputs(Proof memory _args) internal pure returns (bool) {
    return _args.outputCommitments[0] == NULL_COMMITMENT && _args.outputCommitments[1] == NULL_COMMITMENT;
  }

  function calculatePublicAmount(int256 _extAmount, uint256 _fee) public pure returns (uint256) {
    require(_fee < MAX_FEE, "Invalid fee");
    require(_extAmount > -MAX_EXT_AMOUNT && _extAmount < MAX_EXT_AMOUNT, "Invalid ext amount");
    int256 publicAmount = _extAmount - int256(_fee);
    return (publicAmount >= 0) ? uint256(publicAmount) : FIELD_SIZE - uint256(-publicAmount);
  }

  /** @dev whether a note is already spent */
  function isSpent(bytes32 _nullifierHash) public view returns (bool) {
    return nullifierHashes[_nullifierHash];
  }

  // Public input order = circuit declaration order: root, publicAmount, extDataHash, inputNullifier[n], outputCommitment[2]
  function verifyProof(Proof memory _args) public view returns (bool) {
    (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = abi.decode(_args.proof, (uint256[2], uint256[2][2], uint256[2]));
    uint256 n = _args.inputNullifiers.length;
    require(n == 2 || n == 6 || n == 12, "unsupported input count");
    uint256[] memory p = new uint256[](n + 5);
    p[0] = uint256(_args.root);
    p[1] = _args.publicAmount;
    p[2] = uint256(_args.extDataHash);
    for (uint256 i = 0; i < n; i++) p[3 + i] = uint256(_args.inputNullifiers[i]);
    p[n + 3] = uint256(_args.outputCommitments[0]);
    p[n + 4] = uint256(_args.outputCommitments[1]);
    if (n == 2) {
      uint256[7] memory pub;
      for (uint256 i = 0; i < 7; i++) pub[i] = p[i];
      return verifier2.verifyProof(a, b, c, pub);
    } else if (n == 6) {
      uint256[11] memory pub;
      for (uint256 i = 0; i < 11; i++) pub[i] = p[i];
      return verifier6.verifyProof(a, b, c, pub);
    } else {
      uint256[17] memory pub;
      for (uint256 i = 0; i < 17; i++) pub[i] = p[i];
      return verifier12.verifyProof(a, b, c, pub);
    }
  }

  function _transact(Proof memory _args, ExtData memory _extData) internal nonReentrant {
    require(isKnownRoot(_args.root), "Invalid merkle root");
    for (uint256 i = 0; i < _args.inputNullifiers.length; i++) {
      require(!isSpent(_args.inputNullifiers[i]), "Input is already spent");
    }
    require(block.timestamp <= _extData.deadline, "Expired");
    require(uint256(_args.extDataHash) == uint256(keccak256(abi.encode(block.chainid, address(this), _extData))) % FIELD_SIZE, "Incorrect external data hash");
    require(_args.publicAmount == calculatePublicAmount(_extData.extAmount, _extData.fee), "Invalid public amount");
    require(verifyProof(_args), "Invalid transaction proof");

    for (uint256 i = 0; i < _args.inputNullifiers.length; i++) {
      nullifierHashes[_args.inputNullifiers[i]] = true;
    }

    if (_extData.extAmount < 0) {
      require(_extData.recipient != address(0), "Can't withdraw to zero address");
      token.safeTransfer(_extData.recipient, uint256(-_extData.extAmount));
    }
    if (_extData.fee > 0) {
      token.safeTransfer(_extData.relayer, _extData.fee);
    }

    // Two null outputs are not notes: skip the leaves (and their events), the tree stays as it was.
    if (!_nullOutputs(_args)) {
      _insert(_args.outputCommitments[0], _args.outputCommitments[1]);
      emit NewCommitment(_args.outputCommitments[0], nextIndex - 2, _extData.encryptedOutput1);
      emit NewCommitment(_args.outputCommitments[1], nextIndex - 1, _extData.encryptedOutput2);
    }
    for (uint256 i = 0; i < _args.inputNullifiers.length; i++) {
      emit NewNullifier(_args.inputNullifiers[i]);
    }
  }
}
