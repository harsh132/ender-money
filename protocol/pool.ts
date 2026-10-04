/** ABI of ShieldedPool (spikes/nova-splitkey/contracts/ShieldedPool.sol, guarded version: depositWithAuthorization, gateway-only transfers). Generated from forge out/. */
export const shieldedPoolAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "_verifier2",
        "type": "address",
        "internalType": "contract IVerifier2"
      },
      {
        "name": "_verifier6",
        "type": "address",
        "internalType": "contract IVerifier6"
      },
      {
        "name": "_verifier12",
        "type": "address",
        "internalType": "contract IVerifier12"
      },
      {
        "name": "_levels",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "_hasher",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "_token",
        "type": "address",
        "internalType": "contract IERC20"
      },
      {
        "name": "_maximumDepositAmount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "_gateway",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "_admin",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "FIELD_SIZE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_EXT_AMOUNT",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "int256",
        "internalType": "int256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_FEE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "NULL_COMMITMENT",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ROOT_HISTORY_SIZE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ZERO_VALUE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "admin",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "calculatePublicAmount",
    "inputs": [
      {
        "name": "_extAmount",
        "type": "int256",
        "internalType": "int256"
      },
      {
        "name": "_fee",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "currentRootIndex",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "depositWithAuthorization",
    "inputs": [
      {
        "name": "_args",
        "type": "tuple",
        "internalType": "struct ShieldedPool.Proof",
        "components": [
          {
            "name": "proof",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "root",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "inputNullifiers",
            "type": "bytes32[]",
            "internalType": "bytes32[]"
          },
          {
            "name": "outputCommitments",
            "type": "bytes32[2]",
            "internalType": "bytes32[2]"
          },
          {
            "name": "publicAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "extDataHash",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "_extData",
        "type": "tuple",
        "internalType": "struct ShieldedPool.ExtData",
        "components": [
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "extAmount",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "relayer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "fee",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "deadline",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "encryptedOutput1",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "encryptedOutput2",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      },
      {
        "name": "_from",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "_signature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "filledSubtrees",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "gateway",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getLastRoot",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hashLeftRight",
    "inputs": [
      {
        "name": "_left",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "_right",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hasher",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IHasher"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isKnownRoot",
    "inputs": [
      {
        "name": "_root",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isSpent",
    "inputs": [
      {
        "name": "_nullifierHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "levels",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maximumDepositAmount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nextIndex",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nullifierHashes",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "roots",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setGateway",
    "inputs": [
      {
        "name": "_gateway",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "token",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "transact",
    "inputs": [
      {
        "name": "_args",
        "type": "tuple",
        "internalType": "struct ShieldedPool.Proof",
        "components": [
          {
            "name": "proof",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "root",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "inputNullifiers",
            "type": "bytes32[]",
            "internalType": "bytes32[]"
          },
          {
            "name": "outputCommitments",
            "type": "bytes32[2]",
            "internalType": "bytes32[2]"
          },
          {
            "name": "publicAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "extDataHash",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "_extData",
        "type": "tuple",
        "internalType": "struct ShieldedPool.ExtData",
        "components": [
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "extAmount",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "relayer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "fee",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "deadline",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "encryptedOutput1",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "encryptedOutput2",
            "type": "bytes",
            "internalType": "bytes"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "verifier12",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IVerifier12"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "verifier2",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IVerifier2"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "verifier6",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IVerifier6"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "verifyProof",
    "inputs": [
      {
        "name": "_args",
        "type": "tuple",
        "internalType": "struct ShieldedPool.Proof",
        "components": [
          {
            "name": "proof",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "root",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "inputNullifiers",
            "type": "bytes32[]",
            "internalType": "bytes32[]"
          },
          {
            "name": "outputCommitments",
            "type": "bytes32[2]",
            "internalType": "bytes32[2]"
          },
          {
            "name": "publicAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "extDataHash",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "zeros",
    "inputs": [
      {
        "name": "i",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "event",
    "name": "NewCommitment",
    "inputs": [
      {
        "name": "commitment",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "encryptedOutput",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "NewNullifier",
    "inputs": [
      {
        "name": "nullifier",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  }
] as const;
