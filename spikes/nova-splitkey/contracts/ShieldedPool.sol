// SPDX-License-Identifier: MIT
// Minimal port of tornado-nova contracts/TornadoPool.sol (Solidity 0.7) to 0.8.
// Kept: Merkle tree with root history, nullifier set, transact(Proof, ExtData), extDataHash binding,
// publicAmount = extAmount - fee, relayer fee in the token, Verifier2/Verifier16, deposit cap.
// Removed: OmniBridge/ERC-677 (onTokenBridged/onTransact), L1Unwrapper/isL1Withdrawal/l1Fee,
// CrossChainGuard + upgradeable proxy + initializer, multisig/governance (configureLimits, rescueTokens),
// register()/Account public-key registry, lastBalance.
// Split-key spike (vs ../nova-circom2): transaction2 only (no Verifier16); ExtData gains `deadline` (the SMS quote's
// expiry, enforced here); extDataHash also hashes block.chainid and address(this), binding signature and proof to
// one deployment.
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IVerifier2 } from "./IVerifier.sol";
import { MerkleTreeWithHistory } from "./MerkleTreeWithHistory.sol";

contract ShieldedPool is MerkleTreeWithHistory, ReentrancyGuard {
  using SafeERC20 for IERC20;

  int256 public constant MAX_EXT_AMOUNT = 2**248;
  uint256 public constant MAX_FEE = 2**248;

  IVerifier2 public immutable verifier2;
  IERC20 public immutable token;
  uint256 public immutable maximumDepositAmount;

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
    uint32 _levels,
    address _hasher,
    IERC20 _token,
    uint256 _maximumDepositAmount
  ) MerkleTreeWithHistory(_levels, _hasher) {
    verifier2 = _verifier2;
    token = _token;
    maximumDepositAmount = _maximumDepositAmount;
  }

  /** @dev Main function that allows deposits, transfers and withdrawal. */
  function transact(Proof memory _args, ExtData memory _extData) public {
    if (_extData.extAmount > 0) {
      require(uint256(_extData.extAmount) <= maximumDepositAmount, "amount is larger than maximumDepositAmount");
      token.safeTransferFrom(msg.sender, address(this), uint256(_extData.extAmount));
    }
    _transact(_args, _extData);
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
    require(_args.inputNullifiers.length == 2, "unsupported input count");
    uint256[7] memory pub = [
      uint256(_args.root),
      _args.publicAmount,
      uint256(_args.extDataHash),
      uint256(_args.inputNullifiers[0]),
      uint256(_args.inputNullifiers[1]),
      uint256(_args.outputCommitments[0]),
      uint256(_args.outputCommitments[1])
    ];
    return verifier2.verifyProof(a, b, c, pub);
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

    _insert(_args.outputCommitments[0], _args.outputCommitments[1]);
    emit NewCommitment(_args.outputCommitments[0], nextIndex - 2, _extData.encryptedOutput1);
    emit NewCommitment(_args.outputCommitments[1], nextIndex - 1, _extData.encryptedOutput2);
    for (uint256 i = 0; i < _args.inputNullifiers.length; i++) {
      emit NewNullifier(_args.inputNullifiers[i]);
    }
  }
}
