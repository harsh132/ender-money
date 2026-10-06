import { expect, test } from 'bun:test';
import { encodeFunctionData, pad, parseAbi, type Address, type Hex } from 'viem';
import { checkBridgeCalls, checkBridgeQuote, quoteCalls, RELAY_CONTRACTS, RELAY_DEPOSITORY, type RelayQuote } from './bridge';
import { erc20Abi, type Call } from './calibur';
import { NETWORKS } from './networks';

const USER = '0x1111111111111111111111111111111111111111' as Address;
const THIEF = '0x9999999999999999999999999999999999999999' as Address;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address;
const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const ID = pad('0x17', { size: 32 });
const depository = parseAbi(['function depositNative(address depositor, bytes32 id) payable', 'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)']);

const approve = (spender: Address, amount: bigint, token = USDC): Call => ({ to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) });
const depositErc20 = (depositor: Address, amount: bigint): Call => ({
  to: RELAY_DEPOSITORY,
  value: 0n,
  data: encodeFunctionData({ abi: depository, functionName: 'depositErc20', args: [depositor, USDC, amount, ID] }),
});
const depositNative = (depositor: Address, value: bigint): Call => ({ to: RELAY_DEPOSITORY, value, data: encodeFunctionData({ abi: depository, functionName: 'depositNative', args: [depositor, ID] }) });

/** As Relay answers for 5 USDC on Base (trimmed to what we read). */
const quote = (calls: Call[], o: { recipient?: Address; out?: { chainId: number; address: string }; amount?: string; chainId?: number } = {}): RelayQuote => ({
  requestId: ID as Hex,
  steps: calls.map((c, i) => ({
    id: i === calls.length - 1 ? 'deposit' : 'approve',
    kind: 'transaction',
    items: [{ data: { to: c.to, data: c.data, value: c.value.toString(), chainId: o.chainId ?? 8453 } }],
  })),
  details: {
    sender: USER,
    recipient: o.recipient ?? USER,
    currencyIn: { currency: { chainId: 8453, address: USDC }, amount: o.amount ?? '5000000', amountFormatted: '5.0', amountUsd: '4.9994' },
    currencyOut: { currency: o.out ?? { chainId: 143, address: NETWORKS.mainnet.ausd.toLowerCase() }, amount: '4976890', amountFormatted: '4.97689', amountUsd: '4.97' },
  },
});

const usdc = { user: USER, token: USDC, amount: 5_000_000n };

test('a token bridge is approve to a Relay contract, then the deposit to that contract, for the whole amount', () => {
  expect(checkBridgeCalls(usdc, [approve(RELAY_DEPOSITORY, 5_000_000n), depositErc20(USER, 5_000_000n)])).toBeNull();
  // Through the approval proxy (a swap first): its calldata isn't ours to read.
  const proxy = RELAY_CONTRACTS[1]!;
  expect(checkBridgeCalls(usdc, [approve(proxy, 5_000_000n), { to: proxy, value: 0n, data: '0xf9e4bab4' }])).toBeNull();
});

test('calls to anything else, or approvals elsewhere, are refused', () => {
  const ok = depositErc20(USER, 5_000_000n);
  expect(checkBridgeCalls(usdc, [approve(RELAY_DEPOSITORY, 5_000_000n), { ...ok, to: THIEF }])).toBe('bad-target');
  expect(checkBridgeCalls(usdc, [approve(THIEF, 5_000_000n), ok])).toBe('bad-approve');
  // Approve on another token, a transfer dressed as the first call, more than the amount, a third call, value on a token.
  expect(checkBridgeCalls(usdc, [approve(RELAY_DEPOSITORY, 5_000_000n, THIEF), ok])).toBe('bad-target');
  expect(checkBridgeCalls(usdc, [{ to: USDC, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [THIEF, 5_000_000n] }) }, ok])).toBe('bad-approve');
  expect(checkBridgeCalls(usdc, [approve(RELAY_DEPOSITORY, 5_000_001n), ok])).toBe('bad-approve');
  expect(checkBridgeCalls(usdc, [approve(RELAY_DEPOSITORY, 1n), approve(RELAY_DEPOSITORY, 1n), ok])).toBe('bad-target');
  expect(checkBridgeCalls(usdc, [approve(RELAY_DEPOSITORY, 5_000_000n), { ...ok, value: 1n }])).toBe('bad-value');
  expect(checkBridgeCalls(usdc, [ok])).toBe('bad-target');
});

test('a deposit to the depository must name the user as depositor (refunds go there), the token and the amount', () => {
  expect(checkBridgeCalls(usdc, [approve(RELAY_DEPOSITORY, 5_000_000n), depositErc20(THIEF, 5_000_000n)])).toBe('bad-deposit');
  expect(checkBridgeCalls(usdc, [approve(RELAY_DEPOSITORY, 4_000_000n), depositErc20(USER, 4_000_000n)])).toBe('bad-deposit');
  const native = { user: USER, token: NATIVE, amount: 10n ** 15n };
  expect(checkBridgeCalls(native, [depositNative(USER, 10n ** 15n)])).toBeNull();
  expect(checkBridgeCalls(native, [depositNative(THIEF, 10n ** 15n)])).toBe('bad-deposit');
  expect(checkBridgeCalls(native, [depositNative(USER, 10n ** 14n)])).toBe('bad-value');
  expect(checkBridgeCalls(native, [{ to: THIEF, value: 10n ** 15n, data: '0x' }])).toBe('bad-target');
});

test('the app signs only a quote to itself, AUSD on Monad, for exactly what was prepared', () => {
  const calls = [approve(RELAY_DEPOSITORY, 5_000_000n), depositErc20(USER, 5_000_000n)];
  const o = { user: USER, chainId: 8453, token: USDC, amount: 5_000_000n };
  expect(checkBridgeQuote(quote(calls), o)).toBeNull();
  expect(quoteCalls(quote(calls))).toEqual(calls);
  expect(checkBridgeQuote(quote(calls, { recipient: THIEF }), o)).toBe('wrong-recipient');
  expect(checkBridgeQuote(quote(calls, { out: { chainId: 143, address: USDC } }), o)).toBe('wrong-destination');
  expect(checkBridgeQuote(quote(calls, { out: { chainId: 10143, address: NETWORKS.mainnet.ausd } }), o)).toBe('wrong-destination');
  expect(checkBridgeQuote(quote(calls, { amount: '4000000' }), o)).toBe('wrong-input');
  expect(checkBridgeQuote(quote(calls), { ...o, chainId: 1 })).toBe('wrong-input');
  expect(checkBridgeQuote(quote(calls, { chainId: 1 }), o)).toBe('wrong-chain');
  expect(checkBridgeQuote({ ...quote(calls), steps: [{ ...quote(calls).steps[0]!, kind: 'signature' }, quote(calls).steps[1]!] }, o)).toBe('bad-steps');
  expect(checkBridgeQuote(quote([calls[0]!, { ...calls[1]!, to: THIEF }]), o)).toBe('bad-target');
});
