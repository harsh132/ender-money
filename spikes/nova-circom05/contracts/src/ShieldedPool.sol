// SPDX-License-Identifier: MIT
// Stripped port of Tornado Cash Nova's TornadoPool (https://github.com/tornadocash/tornado-nova).
// Removed: OmniBridge/ERC-677 (onTokenBridged/onTransact), L1 unwrapper + isL1Withdrawal/l1Fee,
// CrossChainGuard/upgradeability/initializer, multisig/rescueTokens/configureLimits, register()/Account.
// TESTNET SPIKE ONLY. Not audited.
pragma solidity ^0.8.21;

import { MerkleTreeWithHistory } from "./MerkleTreeWithHistory.sol";

interface IERC20 {
  function transfer(address to, uint256 amount) external returns (bool);
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IVerifier {
  function verifyProof(bytes memory _proof, uint256[7] memory _input) external view returns (bool);
  function verifyProof(bytes memory _proof, uint256[21] memory _input) external view returns (bool);
}

contract ShieldedPool is MerkleTreeWithHistory {
  int256 public constant MAX_EXT_AMOUNT = 2**248;
  uint256 public constant MAX_FEE = 2**248;

  IVerifier public immutable verifier2;
  IVerifier public immutable verifier16;
  IERC20 public immutable token;
  uint256 public immutable maximumDepositAmount;

  mapping(bytes32 => bool) public nullifierHashes;
  uint256 private locked = 1;

  struct ExtData {
    address recipient;
    int256 extAmount;
    address relayer;
    uint256 fee;
    bytes encryptedOutput1;
    bytes encryptedOutput2;
  }

  struct Proof {
    bytes proof;
    bytes32 root;
    bytes32[] inputNullifiers;
    bytes32[2] outputCommitments;
    uint256 publicAmount;
    bytes32 extDataHash;
  }

  event NewCommitment(bytes32 commitment, uint256 index, bytes encryptedOutput);
  event NewNullifier(bytes32 nullifier);

  modifier nonReentrant() {
    require(locked == 1, "reentrant");
    locked = 2;
    _;
    locked = 1;
  }

  constructor(
    IVerifier _verifier2,
    IVerifier _verifier16,
    uint32 _levels,
    address _hasher,
    IERC20 _token,
    uint256 _maximumDepositAmount
  ) MerkleTreeWithHistory(_levels, _hasher) {
    verifier2 = _verifier2;
    verifier16 = _verifier16;
    token = _token;
    maximumDepositAmount = _maximumDepositAmount;
  }

  /** @dev Deposits (extAmount > 0, pulled from msg.sender), private transfers (0) and withdrawals (< 0). */
  function transact(Proof memory _args, ExtData memory _extData) public nonReentrant {
    if (_extData.extAmount > 0) {
      require(uint256(_extData.extAmount) <= maximumDepositAmount, "amount is larger than maximumDepositAmount");
      require(token.transferFrom(msg.sender, address(this), uint256(_extData.extAmount)), "transferFrom failed");
    }

    require(isKnownRoot(_args.root), "Invalid merkle root");
    for (uint256 i = 0; i < _args.inputNullifiers.length; i++) {
      require(!isSpent(_args.inputNullifiers[i]), "Input is already spent");
    }
    require(uint256(_args.extDataHash) == uint256(keccak256(abi.encode(_extData))) % FIELD_SIZE, "Incorrect external data hash");
    require(_args.publicAmount == calculatePublicAmount(_extData.extAmount, _extData.fee), "Invalid public amount");
    require(verifyProof(_args), "Invalid transaction proof");

    for (uint256 i = 0; i < _args.inputNullifiers.length; i++) {
      nullifierHashes[_args.inputNullifiers[i]] = true;
    }

    if (_extData.extAmount < 0) {
      require(_extData.recipient != address(0), "Can't withdraw to zero address");
      require(token.transfer(_extData.recipient, uint256(-_extData.extAmount)), "transfer failed");
    }
    if (_extData.fee > 0) {
      require(token.transfer(_extData.relayer, _extData.fee), "fee transfer failed");
    }

    _insert(_args.outputCommitments[0], _args.outputCommitments[1]);
    emit NewCommitment(_args.outputCommitments[0], nextIndex - 2, _extData.encryptedOutput1);
    emit NewCommitment(_args.outputCommitments[1], nextIndex - 1, _extData.encryptedOutput2);
    for (uint256 i = 0; i < _args.inputNullifiers.length; i++) {
      emit NewNullifier(_args.inputNullifiers[i]);
    }
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

  function verifyProof(Proof memory _args) public view returns (bool) {
    if (_args.inputNullifiers.length == 2) {
      return
        verifier2.verifyProof(
          _args.proof,
          [
            uint256(_args.root),
            _args.publicAmount,
            uint256(_args.extDataHash),
            uint256(_args.inputNullifiers[0]),
            uint256(_args.inputNullifiers[1]),
            uint256(_args.outputCommitments[0]),
            uint256(_args.outputCommitments[1])
          ]
        );
    } else if (_args.inputNullifiers.length == 16) {
      uint256[21] memory input;
      input[0] = uint256(_args.root);
      input[1] = _args.publicAmount;
      input[2] = uint256(_args.extDataHash);
      for (uint256 i = 0; i < 16; i++) input[3 + i] = uint256(_args.inputNullifiers[i]);
      input[19] = uint256(_args.outputCommitments[0]);
      input[20] = uint256(_args.outputCommitments[1]);
      return verifier16.verifyProof(_args.proof, input);
    } else {
      revert("unsupported input count");
    }
  }
}
