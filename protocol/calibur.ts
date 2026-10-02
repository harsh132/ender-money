import {
  encodeAbiParameters,
  encodeFunctionData,
  pad,
  parseAbi,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { CALIBUR } from './networks';

export type Call = { to: Address; value: bigint; data: Hex };

export const caliburAbi = parseAbi([
  'struct Call { address to; uint256 value; bytes data; }',
  'struct BatchedCall { Call[] calls; bool revertOnFailure; }',
  'struct SignedBatchedCall { BatchedCall batchedCall; uint256 nonce; bytes32 keyHash; address executor; uint256 deadline; }',
  'function execute(SignedBatchedCall signedBatchedCall, bytes wrappedSignature) payable',
  'function getSeq(uint256 key) view returns (uint256)',
]);

export const erc20Abi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]);

/** True when `code` is an EIP-7702 delegation designator pointing at Calibur. */
export const isDelegatedToCalibur = (code: Hex | undefined) =>
  (code ?? '0x').toLowerCase() === `0xef0100${CALIBUR.slice(2).toLowerCase()}`;

/** The recipient transfer, then the fee to the treasury, in one all-or-nothing batch. */
export const transferWithFee = (token: Address, to: Address, amount: bigint, feeRecipient: Address, fee: bigint): Call[] => [
  { to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }) },
  { to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [feeRecipient, fee] }) },
];

/**
 * Calibur's EIP-712 typed data for a batch signed by the account's root key.
 * The domain's verifyingContract is the user's own address (the code runs there
 * after delegation) and its salt is the Calibur implementation address.
 */
export const signedBatchTypedData = (account: Address, chainId: number, calls: Call[], nonce: bigint, deadline: bigint) =>
  ({
    domain: { name: 'Calibur', version: '1.0.0', chainId, verifyingContract: account, salt: pad(CALIBUR, { size: 32 }) },
    types: {
      SignedBatchedCall: [
        { name: 'batchedCall', type: 'BatchedCall' },
        { name: 'nonce', type: 'uint256' },
        { name: 'keyHash', type: 'bytes32' },
        { name: 'executor', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
      BatchedCall: [
        { name: 'calls', type: 'Call[]' },
        { name: 'revertOnFailure', type: 'bool' },
      ],
      Call: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
      ],
    },
    primaryType: 'SignedBatchedCall',
    message: {
      batchedCall: { calls, revertOnFailure: true },
      nonce,
      keyHash: zeroHash,
      executor: zeroAddress,
      deadline,
    },
  }) as const;

/** `execute(SignedBatchedCall, wrappedSignature)` calldata; the root key signs and takes no hook data. */
export const encodeExecute = (calls: Call[], nonce: bigint, deadline: bigint, signature: Hex) =>
  encodeFunctionData({
    abi: caliburAbi,
    functionName: 'execute',
    args: [
      { batchedCall: { calls, revertOnFailure: true }, nonce, keyHash: zeroHash, executor: zeroAddress, deadline },
      encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [signature, '0x']),
    ],
  });
