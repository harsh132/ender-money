/**
 * Auto-bridge with fetch mocked: Relay's quote and price API, and a JSON-RPC
 * stand-in for Base that answers what prepare and submit read. The Sponsor is
 * a stub that records what it was asked to send. No real network calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { encodeAbiParameters, encodeFunctionData, pad, parseAbi, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BRIDGE_FEE_RECIPIENT, RELAY_DEPOSITORY } from '../../protocol/bridge';
import { encodeExecute, erc20Abi } from '../../protocol/calibur';
import { CALIBUR, MULTICALL3, NETWORKS } from '../../protocol/networks';
import { signBridge, type BridgePrepared } from '../../app/src/lib/bridge';
import { d1, mockWorkers } from './test-env';

mockWorkers();
const { bridgeFee, pending, prepare, submit } = await import('./bridge');
const { GatewayError } = await import('./core');
type Env = import('./env').Env;

const PHONE = '+919800000001';
const user = privateKeyToAccount(generatePrivateKey());
const ME = user.address.toLowerCase() as Address;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address;
const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const THIEF = '0x9999999999999999999999999999999999999999' as Address;
const GATEWAY_KEY = generatePrivateKey();
const GATEWAY = privateKeyToAccount(GATEWAY_KEY).address.toLowerCase();
const ORACLE = '0x420000000000000000000000000000000000000f';
const ID = pad('0x17', { size: 32 }) as Hex;
const depository = parseAbi(['function depositNative(address depositor, bytes32 id) payable', 'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)']);

const config = { markup: 1.3, flatUsd: 0, maxPct: 5, minUsd: 1 };

describe('bridgeFee', () => {
  test('gas × markup × price in USD, as bps of the amount, rounded up', () => {
    // 0.0001 ETH of gas at $3000, × 1.3 = $0.39: 39 bps of $100, not 40 for float noise.
    expect(bridgeFee({ costWei: 10n ** 14n, nativeUsd: 3000, amountUsd: 100 }, config)).toMatchObject({ bps: 39, maxCost: 130_000_000_000_000n });
    expect(bridgeFee({ costWei: 10n ** 14n, nativeUsd: 3000, amountUsd: 99 }, config)).toMatchObject({ bps: 40 });
    // A sliver of gas still costs 1 bps.
    expect(bridgeFee({ costWei: 1n, nativeUsd: 3000, amountUsd: 100 }, config)).toMatchObject({ bps: 1 });
  });

  test('the flat fee adds on top', () => {
    const f = bridgeFee({ costWei: 10n ** 14n, nativeUsd: 3000, amountUsd: 100 }, { ...config, flatUsd: 0.5 });
    expect(f).toMatchObject({ bps: 89 });
  });

  test('over the cap or under the minimum: skipped', () => {
    // $0.39 of $5 is 7.8%.
    expect(bridgeFee({ costWei: 10n ** 14n, nativeUsd: 3000, amountUsd: 5 }, config)).toEqual({ skip: 'fee-too-high' });
    // Exactly 5% is allowed.
    expect(bridgeFee({ costWei: 10n ** 14n, nativeUsd: 3000, amountUsd: 7.8 }, config)).toMatchObject({ bps: 500 });
    expect(bridgeFee({ costWei: 1n, nativeUsd: 3000, amountUsd: 0.99 }, config)).toEqual({ skip: 'too-small' });
    expect(bridgeFee({ costWei: 1n, nativeUsd: 3000, amountUsd: NaN }, config)).toEqual({ skip: 'too-small' });
  });
});

// ---------------------------------------------------------------- fetch stand-in

let chain: {
  usdc: bigint;
  native: bigint;
  delegated: boolean;
  sponsor: bigint;
  /** eth_estimateGas: the prepare simulation (state override) and submit's real transaction. */
  simGas: bigint;
  realGas: bigint;
  reverts: boolean;
};
let relayDown: 'unsupported' | undefined;
let quoteBodies: Array<Record<string, unknown>>;
let estimates: unknown[][];

const word = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n]);

const rpc = (method: string, params: any[]): unknown => {
  switch (method) {
    case 'eth_chainId':
      return toHex(8453);
    case 'eth_gasPrice':
      return toHex(10n ** 9n);
    case 'eth_getTransactionCount':
      return '0x3';
    case 'eth_getBalance':
      return toHex(params[0].toLowerCase() === GATEWAY ? chain.sponsor : chain.native);
    case 'eth_getCode':
      if (params[0].toLowerCase() === MULTICALL3.toLowerCase()) return '0x6080';
      return chain.delegated ? `0xef0100${CALIBUR.slice(2).toLowerCase()}` : '0x';
    case 'eth_call': {
      const to = params[0].to.toLowerCase();
      if (to === USDC) return word(chain.usdc);
      if (to === ORACLE) return word(10n ** 12n);
      if (to === ME) return chain.delegated ? word(7n) : '0x';
      break;
    }
    case 'eth_estimateGas':
      estimates.push(params);
      if (chain.reverts) throw { code: 3, message: 'execution reverted' };
      return toHex(params.length > 2 ? chain.simGas : chain.realGas);
  }
  throw { code: -32601, message: `no ${method}` };
};

/** Relay's answer for whatever was asked, as its depository routes USDC and ETH. */
const relayQuote = (body: Record<string, any>) => {
  const amount = BigInt(body.amount);
  const native = body.originCurrency === NATIVE;
  const calls = native
    ? [{ to: RELAY_DEPOSITORY, value: amount, data: encodeFunctionData({ abi: depository, functionName: 'depositNative', args: [body.user, ID] }) }]
    : [
        { to: USDC, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [RELAY_DEPOSITORY, amount] }) },
        { to: RELAY_DEPOSITORY, value: 0n, data: encodeFunctionData({ abi: depository, functionName: 'depositErc20', args: [body.user, USDC, amount, ID] }) },
      ];
  return {
    requestId: ID,
    steps: calls.map((c, i) => ({
      id: i === calls.length - 1 ? 'deposit' : 'approve',
      kind: 'transaction',
      requestId: ID,
      items: [{ data: { to: c.to, data: c.data, value: c.value.toString(), chainId: 8453 } }],
    })),
    details: {
      sender: body.user,
      recipient: body.recipient,
      currencyIn: { currency: { chainId: 8453, address: body.originCurrency.toLowerCase() }, amount: body.amount, amountFormatted: '', amountUsd: native ? String(Number(amount) / 1e18 * 3000) : String(Number(amount) / 1e6) },
      currencyOut: { currency: { chainId: 143, address: NETWORKS.mainnet.ausd.toLowerCase() }, amount: '1', amountFormatted: '1', amountUsd: '1' },
    },
  };
};

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.relay.link/quote') {
      const body = JSON.parse(String(init!.body));
      quoteBodies.push(body);
      if (relayDown === 'unsupported') return Response.json({ message: 'nope', errorCode: 'INVALID_INPUT_CURRENCY' }, { status: 400 });
      return Response.json(relayQuote(body));
    }
    if (url.startsWith('https://api.relay.link/currencies/token/price?')) return Response.json({ price: 3000 });
    if (url === 'http://rpc.test/base') {
      const req = JSON.parse(String(init!.body));
      try {
        return Response.json({ jsonrpc: '2.0', id: req.id, result: rpc(req.method, req.params) });
      } catch (error) {
        return Response.json({ jsonrpc: '2.0', id: req.id, error });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------- env

let env: Env;
let sent: Array<{ chain: string; item: { kind: string; target: Address; data: Hex; authorizationList?: unknown[] } }>;

beforeEach(async () => {
  chain = { usdc: 100_000_000n, native: 0n, delegated: false, sponsor: 10n ** 18n, simGas: 150_000n, realGas: 230_000n, reverts: false };
  relayDown = undefined;
  quoteBodies = [];
  estimates = [];
  sent = [];
  env = {
    DB: d1(),
    GATEWAY_PRIVATE_KEY: GATEWAY_KEY,
    RPC_BASE: 'http://rpc.test/base',
    SPONSOR: {
      idFromName: (n: string) => n,
      get: () => ({
        submit: async (chain: string, item: (typeof sent)[number]['item']) => {
          sent.push({ chain, item });
          return { ok: true, txHash: pad('0xb5', { size: 32 }) };
        },
      }),
    },
  } as unknown as Env;
  await env.DB.prepare('INSERT INTO links (phone, address, network, created_at) VALUES (?, ?, ?, 0)').bind(PHONE, ME, 'mainnet').run();
  await env.DB.prepare('INSERT INTO foreign_balances (address, chain_id, token, seen_at) VALUES (?, 8453, ?, 1)').bind(ME, USDC).run();
});

const rows = <T>(sql: string, ...params: Array<string | number>) => env.DB.prepare(sql).bind(...params).all<T>().then((r) => r.results);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => (e instanceof GatewayError ? e.code : String(e)),
  );

describe('pending and prepare', () => {
  test('lists what arrived and is not waiting', async () => {
    await env.DB.prepare('INSERT INTO foreign_balances (address, chain_id, token, seen_at, retry_at) VALUES (?, 1, ?, 2, 9999999999)').bind(ME, NATIVE).run();
    expect(await pending(env, PHONE)).toEqual({ items: [{ chainId: 8453, token: USDC }] });
  });

  test('prices the fee from a draft quote and the simulated batch, and hands back the nonces', async () => {
    const p = await prepare(env, PHONE, { chainId: 8453, token: USDC });
    // gas: 150k simulated + 20k Calibur + 25k delegation = 195k at 1 gwei, + 1e12 L1: 1.96e14 wei × 1.3 × $3000 = $0.76 of $100.
    expect(p).toMatchObject({ chainId: 8453, token: USDC, amount: '100000000', amountUsd: 100, bps: 77, feeRecipient: BRIDGE_FEE_RECIPIENT, nonce: '0', delegated: false, authNonce: 3 });
    // The draft: the whole balance, to ourselves, without an app fee.
    expect(quoteBodies).toEqual([
      {
        user: ME,
        recipient: ME,
        originChainId: 8453,
        destinationChainId: 143,
        originCurrency: USDC,
        destinationCurrency: NETWORKS.mainnet.ausd,
        amount: '100000000',
        tradeType: 'EXACT_INPUT',
      },
    ]);
    // Simulated as the user, with Multicall3's code over their address and the gateway key topped up.
    const [tx, , overrides] = estimates[0] as [{ from: string; to: string }, string, Record<string, { code?: string }>];
    expect([tx.from.toLowerCase(), tx.to.toLowerCase()]).toEqual([GATEWAY, ME]);
    expect(Object.entries(overrides).find(([a]) => a.toLowerCase() === ME)?.[1].code).toBe('0x6080');
    expect(await rows('SELECT chain_id, token, amount, bps, nonce, delegate, max_cost, state FROM bridges')).toEqual([
      { chain_id: 8453, token: USDC, amount: '100000000', bps: 77, nonce: '0', delegate: 1, max_cost: '254800000000000', state: 'prepared' },
    ]);
  });

  test('a delegated address takes no authorization and keeps its Calibur nonce', async () => {
    chain.delegated = true;
    expect(await prepare(env, PHONE, { chainId: 8453, token: USDC })).toMatchObject({ delegated: true, nonce: '7' });
  });

  test("refusals: unknown chain, nothing there, a token Relay can't take, too small, too dear, the gateway key short", async () => {
    expect(await code(prepare(env, PHONE, { chainId: 143, token: USDC }))).toBe('bad-chain');
    expect(await code(prepare(env, PHONE, { chainId: 8453, token: 'nope' }))).toBe('bad-token');

    chain.usdc = 0n;
    expect(await code(prepare(env, PHONE, { chainId: 8453, token: USDC }))).toBe('nothing-to-bridge');
    expect(await rows('SELECT * FROM foreign_balances')).toEqual([]);

    await env.DB.prepare('INSERT INTO foreign_balances (address, chain_id, token, seen_at) VALUES (?, 8453, ?, 1)').bind(ME, USDC).run();
    chain.usdc = 100_000_000n;
    relayDown = 'unsupported';
    expect(await code(prepare(env, PHONE, { chainId: 8453, token: USDC }))).toBe('unsupported-token');
    // Not listed again until more arrives (or a week passes).
    expect(await pending(env, PHONE)).toEqual({ items: [] });
    relayDown = undefined;

    chain.usdc = 900_000n;
    expect(await code(prepare(env, PHONE, { chainId: 8453, token: USDC }))).toBe('too-small');
    chain.usdc = 5_000_000n;
    chain.simGas = 2_000_000n;
    expect(await code(prepare(env, PHONE, { chainId: 8453, token: USDC }))).toBe('fee-too-high');
    chain.simGas = 150_000n;
    chain.usdc = 100_000_000n;
    chain.sponsor = 10n ** 12n;
    expect(await code(prepare(env, PHONE, { chainId: 8453, token: USDC }))).toBe('sponsor-low');
    chain.sponsor = 10n ** 18n;
    chain.reverts = true;
    expect(await code(prepare(env, PHONE, { chainId: 8453, token: USDC }))).toBe('reverted');
    expect(await rows('SELECT * FROM bridges')).toEqual([]);
  });
});

describe('submit', () => {
  /** Prepare, fetch the quote with the fee as the app does, and sign it with the app's code. */
  const signed = async (token = USDC) => {
    const p = (await prepare(env, PHONE, { chainId: 8453, token })) as BridgePrepared;
    const q = relayQuote({ user: user.address, recipient: user.address, originCurrency: token, amount: p.amount });
    return signBridge(user as Parameters<typeof signBridge>[0], p, q as never); // the app resolves its own copy of viem
  };

  test('sends the user-signed batch with their authorization, from the gateway key, in one transaction', async () => {
    const body = await signed();
    expect(await submit(env, PHONE, body)).toEqual({ txHash: pad('0xb5', { size: 32 }) });
    expect(sent).toHaveLength(1);
    const { chain: name, item } = sent[0]!;
    expect(name).toBe('base');
    expect(item.kind).toBe('direct');
    expect(item.target.toLowerCase()).toBe(ME);
    expect(item.data).toBe(encodeExecute(body.calls.map((c) => ({ ...c, value: BigInt(c.value) })), 0n, BigInt(body.deadline), body.signature));
    expect(item.authorizationList).toEqual([{ ...body.authorization!, address: CALIBUR }]);
    // The real transaction was simulated, authorization and all.
    expect((estimates.at(-1)![0] as { authorizationList?: unknown[] }).authorizationList).toHaveLength(1);
    expect(await rows('SELECT state, tx_hash, request_id FROM bridges')).toEqual([{ state: 'sent', tx_hash: pad('0xb5', { size: 32 }), request_id: ID }]);
    expect(await rows('SELECT * FROM foreign_balances')).toEqual([]);
    // Once only.
    expect(await code(submit(env, PHONE, body))).toBe('unknown-bridge');
  });

  test('the native coin goes as the deposit value, no approve', async () => {
    chain.native = 10n ** 17n;
    const body = await signed(NATIVE);
    expect(body.calls).toHaveLength(1);
    expect(await submit(env, PHONE, body)).toMatchObject({ txHash: expect.any(String) });
  });

  test('calls elsewhere, a different depositor, a bad signature, a missing authorization: refused, nothing sent', async () => {
    const cases: Array<[string, (b: Awaited<ReturnType<typeof signed>>) => unknown]> = [
      ['bad-target', (b) => ({ ...b, calls: [b.calls[0], { ...b.calls[1]!, to: THIEF }] })],
      [
        'bad-deposit',
        (b) => ({
          ...b,
          calls: [b.calls[0], { ...b.calls[1]!, data: encodeFunctionData({ abi: depository, functionName: 'depositErc20', args: [THIEF, USDC, 100_000_000n, ID] }) }],
        }),
      ],
      ['bad-approve', (b) => ({ ...b, calls: [{ ...b.calls[0]!, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [THIEF, 1n] }) }, b.calls[1]] })],
      ['bad-sig', (b) => ({ ...b, signature: `0x${'22'.repeat(64)}1b` })],
      ['bad-authorization', (b) => ({ ...b, authorization: undefined })],
      ['bad-nonce', (b) => ({ ...b, nonce: '1' })],
      ['bad-deadline', (b) => ({ ...b, deadline: b.deadline + 3600 })],
    ];
    for (const [want, tamper] of cases) {
      const body = await signed();
      expect([want, await code(submit(env, PHONE, tamper(body) as never))]).toEqual([want, want]);
    }
    expect(sent).toEqual([]);
  });

  test("another user's bridge is unknown", async () => {
    const body = await signed();
    await env.DB.prepare('INSERT INTO links (phone, address, network, created_at) VALUES (?, ?, ?, 0)').bind('+919800000002', THIEF, 'mainnet').run();
    expect(await code(submit(env, '+919800000002', body))).toBe('unknown-bridge');
  });

  test('would revert, or now costs more than the fee pays for: refused, so the app prepares again', async () => {
    let body = await signed();
    chain.reverts = true;
    expect(await code(submit(env, PHONE, body))).toBe('reverted');
    chain.reverts = false;
    body = await signed();
    // Prepared at 195k gas (the fee covers 1.3× that, 253k); 310k now is past it.
    chain.realGas = 310_000n;
    expect(await code(submit(env, PHONE, body))).toBe('gas-rose');
    expect(sent).toEqual([]);
    expect(await rows('SELECT state, error FROM bridges ORDER BY created_at')).toEqual([
      { state: 'failed', error: 'reverted' },
      { state: 'failed', error: 'gas-rose' },
    ]);
  });
});
