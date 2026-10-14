import { expect, test } from 'bun:test';
import { encodeFunctionData, pad, parseAbi, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverAuthorizationAddress } from 'viem/utils';
import { BRIDGE_FEE_RECIPIENT, RELAY_DEPOSITORY, type RelayQuote } from '../../../protocol/bridge';
import { erc20Abi, signedBatchTypedData } from '../../../protocol/calibur';
import { CALIBUR, NETWORKS } from '../../../protocol/networks';
import { autoBridgeOn, bridgeOutcome, checkPrepared, shouldAutoBridge, signBridge, type BridgePrepared } from './bridge';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address;
const me = privateKeyToAccount(generatePrivateKey());
const prepared: BridgePrepared = {
  id: 'abc',
  chainId: 8453,
  token: USDC,
  amount: '5000000',
  amountUsd: 5,
  bps: 12,
  feeRecipient: BRIDGE_FEE_RECIPIENT,
  nonce: '0',
  delegated: false,
  authNonce: 3,
};
const ID = pad('0x17', { size: 32 }) as Hex;
const calls = [
  { to: USDC, value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [RELAY_DEPOSITORY, 5_000_000n] }) },
  {
    to: RELAY_DEPOSITORY,
    value: '0',
    data: encodeFunctionData({
      abi: parseAbi(['function depositErc20(address depositor, address token, uint256 amount, bytes32 id)']),
      functionName: 'depositErc20',
      args: [me.address, USDC, 5_000_000n, ID],
    }),
  },
];
const quote = (recipient: string = me.address): RelayQuote => ({
  requestId: ID,
  steps: calls.map((c, i) => ({ id: i ? 'deposit' : 'approve', kind: 'transaction', items: [{ data: { ...c, chainId: 8453 } }] })),
  details: {
    sender: me.address,
    recipient,
    currencyIn: { currency: { chainId: 8453, address: USDC }, amount: '5000000', amountFormatted: '5', amountUsd: '5' },
    currencyOut: { currency: { chainId: 143, address: NETWORKS.mainnet.ausd }, amount: '4970000', amountFormatted: '4.97', amountUsd: '4.97' },
  },
});

test('auto-bridge runs only when switched on, on mainnet, online, with the key in memory', () => {
  const on = { on: true, network: 'mainnet' as const, online: true, unlocked: true };
  expect(shouldAutoBridge(on)).toBe(true);
  expect(shouldAutoBridge({ ...on, network: 'testnet' })).toBe(false);
  expect(shouldAutoBridge({ ...on, online: false })).toBe(false);
  expect(shouldAutoBridge({ ...on, unlocked: false })).toBe(false);
  expect(shouldAutoBridge({ ...on, on: false })).toBe(false);
  // Older installs never stored the setting: on.
  expect(autoBridgeOn({})).toBe(true);
  expect(autoBridgeOn({ autoBridge: false })).toBe(false);
});

test('the gateway may not raise the fee past the cap, send it elsewhere, or name another chain', () => {
  expect(checkPrepared(prepared)).toBeNull();
  expect(checkPrepared({ ...prepared, bps: 501 })).toBe('fee-too-high');
  expect(checkPrepared({ ...prepared, bps: 1.5 })).toBe('fee-too-high');
  expect(checkPrepared({ ...prepared, feeRecipient: '0x9999999999999999999999999999999999999999' })).toBe('wrong-fee-recipient');
  expect(checkPrepared({ ...prepared, chainId: 143 })).toBe('bad-chain');
});

test('signs the quote steps as a Calibur batch on the origin chain, with the 7702 authorization only where not delegated', async () => {
  const body = await signBridge(me, prepared, quote(), 1000);
  expect(body.calls).toEqual(calls);
  expect(body.deadline).toBe(1600);
  expect(body.requestId).toBe(ID);
  const typed = signedBatchTypedData(me.address, 8453, calls.map((c) => ({ ...c, value: 0n })), 0n, 1600n);
  expect(await recoverTypedDataAddress({ ...typed, signature: body.signature })).toBe(me.address);
  expect(body.authorization).toMatchObject({ address: CALIBUR, chainId: 8453, nonce: 3 });
  expect(await recoverAuthorizationAddress({ authorization: body.authorization! })).toBe(me.address);

  expect((await signBridge(me, { ...prepared, delegated: true }, quote())).authorization).toBeUndefined();
});

test('a quote to anyone else, or a fee past the cap, is never signed', async () => {
  await expect(signBridge(me, prepared, quote('0x9999999999999999999999999999999999999999'))).rejects.toThrow('wrong-recipient');
  await expect(signBridge(me, { ...prepared, bps: 900 }, quote())).rejects.toThrow('fee-too-high');
});

test("Relay's status settles the row", () => {
  expect(bridgeOutcome('success')).toBe('sent');
  expect(bridgeOutcome('refund')).toBe('failed');
  expect(bridgeOutcome('failure')).toBe('failed');
  expect(bridgeOutcome('pending')).toBeUndefined();
  expect(bridgeOutcome('waiting')).toBeUndefined();
});
