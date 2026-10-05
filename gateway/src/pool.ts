/**
 * The gateway's view of the shielded pool: leaves, nullifiers, the Merkle tree
 * (persisted, incremental) and each registered user's notes.
 *
 * Every pool transaction goes through the gateway (deposits and transfers are
 * gateway-only on-chain; open exits aren't supported yet), so the index is fed
 * from the gateway's own receipts (`ingest`). The only log scan is a catch-up
 * from the deploy block on first use, or after a gap (a receipt we never saw),
 * chunked, with its cursor saved after every chunk.
 *
 * TODO(open-exit): scan pool events for transactions not relayed by the gateway
 * (a null-output withdrawal anyone may send spends nullifiers the index then
 * misses). It would go in scheduled() in index.ts, calling scanPool().
 */
import { parseEventLogs, type Log } from 'viem';
import { shieldedPoolAbi } from '../../protocol/pool';
import { NETWORKS, type NetworkName } from '../../protocol/networks';
import { commitment, decryptNote, LEVELS, nullifier, poseidon, ZERO_VALUE, type MerkleTree } from '../../protocol/shielded';
import { publicClient } from './chain';
import { GatewayError } from './core';
import type { Env } from './env';
import { usersFor } from './shielded';

/** zeros[l]: an empty subtree's root at level l (the pool contract's zeros(l)). */
const zeros = [ZERO_VALUE];
for (let l = 1; l <= LEVELS; l++) zeros.push(poseidon([zeros[l - 1]!, zeros[l - 1]!]));

/** Leaves per D1 batch: about 2 writes per leaf plus one per level. */
const APPEND_CHUNK = 256;
/** Monad's public RPCs cap eth_getLogs at 100 blocks. */
const LOG_RANGE = 100n;
/** Chunks per catch-up call; the caller gets `syncing` (503) and retries if the pool is further behind. */
const CATCH_UP_CHUNKS = 200;

export const poolOf = (network: NetworkName) => {
  const net = NETWORKS[network];
  if (!net.pool) throw new GatewayError('unsupported');
  return { pool: net.pool, fromBlock: net.poolDeployBlock ?? 0n };
};

const treeSize = async (env: Env, network: NetworkName) =>
  (await env.DB.prepare('SELECT MAX(to_size) AS n FROM pool_appends WHERE network = ?').bind(network).first<{ n: number | null }>())?.n ?? 0;

/** Rows matching any of the (level, idx) pairs, chunked under D1's bound-parameter cap. */
const nodes = async (env: Env, network: NetworkName, keys: Array<[number, number]>) => {
  const out = new Map<string, bigint>();
  for (let i = 0; i < keys.length; i += 45) {
    const part = keys.slice(i, i + 45);
    const { results } = await env.DB.prepare(
      `SELECT level, idx, hash FROM pool_nodes WHERE network = ? AND (level, idx) IN (VALUES ${part.map(() => '(?, ?)').join(', ')})`,
    )
      .bind(network, ...part.flat())
      .all<{ level: number; idx: number; hash: string }>();
    for (const r of results) out.set(`${r.level}:${r.idx}`, BigInt(r.hash));
  }
  return out;
};

/**
 * Appends every stored leaf that continues the tree, in batches. Each batch
 * starts with an insert into pool_appends keyed by the size it read, so a
 * racing append from the same size fails and rolls back instead of writing
 * hashes computed from stale siblings. Returns the tree size.
 */
export const extendTree = async (env: Env, network: NetworkName): Promise<number> => {
  for (;;) {
    const size = await treeSize(env, network);
    const { results } = await env.DB.prepare('SELECT idx, commitment FROM pool_leaves WHERE network = ? AND idx >= ? ORDER BY idx LIMIT ?')
      .bind(network, size, APPEND_CHUNK)
      .all<{ idx: number; commitment: string }>();
    const leaves = results.filter((r, i) => r.idx === size + i).map((r) => BigInt(r.commitment));
    if (!leaves.length) return size;

    // The left neighbour of the first changed node, wherever it is a right child; everything right of the new leaves is empty.
    const lefts: Array<[number, number]> = [];
    for (let l = 0; l < LEVELS; l++) if ((size >> l) & 1) lefts.push([l, (size >> l) - 1]);
    const known = await nodes(env, network, lefts);

    const writes: Array<[number, number, bigint]> = [];
    let level = new Map(leaves.map((h, i) => [size + i, h]));
    for (let l = 0; l < LEVELS; l++) {
      for (const [i, h] of level) writes.push([l, i, h]);
      const get = (i: number) => level.get(i) ?? known.get(`${l}:${i}`) ?? zeros[l]!;
      const parents = new Map<number, bigint>();
      for (const i of level.keys()) parents.set(i >> 1, 0n);
      for (const p of parents.keys()) parents.set(p, poseidon([get(2 * p), get(2 * p + 1)]));
      level = parents;
    }
    for (const [i, h] of level) writes.push([LEVELS, i, h]);

    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO pool_appends (network, from_size, to_size) VALUES (?, ?, ?)').bind(network, size, size + leaves.length),
        ...writes.map(([l, i, h]) =>
          env.DB.prepare('INSERT OR REPLACE INTO pool_nodes (network, level, idx, hash) VALUES (?, ?, ?, ?)').bind(network, l, i, h.toString()),
        ),
      ]);
    } catch (e) {
      // Someone else appended from this size first; reread and continue from theirs.
      if (!String(e instanceof Error ? e.message : e).includes('UNIQUE')) throw e;
    }
  }
};

/**
 * The tree as protocol's witnessInput wants it (synchronous), with the paths
 * of `positions` preloaded. Throws if a position isn't in the tree yet.
 */
export const treeFor = async (env: Env, network: NetworkName, positions: number[]): Promise<MerkleTree & { size: number }> => {
  const size = await treeSize(env, network);
  if (positions.some((p) => p >= size)) throw new GatewayError('syncing', 503);
  const keys: Array<[number, number]> = [[LEVELS, 0]];
  for (const p of positions) for (let l = 0; l < LEVELS; l++) keys.push([l, (p >> l) ^ 1]);
  const known = await nodes(env, network, keys);
  return {
    size,
    root: known.get(`${LEVELS}:0`) ?? zeros[LEVELS]!,
    path: (pos: number) => ({ pathElements: Array.from({ length: LEVELS }, (_, l) => known.get(`${l}:${(pos >> l) ^ 1}`) ?? zeros[l]!) }),
  };
};

/**
 * Pool logs (a receipt's, or a catch-up chunk's) into the index: leaves,
 * nullifiers, the tree, and trial decryption of new leaves for every
 * registered user on the network. Idempotent.
 *
 * ponytail: trial decryption is leaves x users (one x25519 each); fine at
 * testnet scale. Past that, decrypt only for the parties of the gateway's own
 * quote (it knows them) and keep the full scan for the catch-up.
 */
export const ingest = async (env: Env, network: NetworkName, logs: Log[]) => {
  const { pool } = poolOf(network);
  const events = parseEventLogs({ abi: shieldedPoolAbi, logs: logs.filter((l) => l.address.toLowerCase() === pool.toLowerCase()) });
  const leaves = events.flatMap((e) =>
    e.eventName === 'NewCommitment'
      ? [{ idx: Number(e.args.index), commitment: BigInt(e.args.commitment), ciphertext: e.args.encryptedOutput, block: Number(e.blockNumber), tx: e.transactionHash }]
      : [],
  );
  const nullifiers = events.flatMap((e) => (e.eventName === 'NewNullifier' ? [BigInt(e.args.nullifier)] : []));
  if (!leaves.length && !nullifiers.length) return;

  const notes = [];
  if (leaves.length) {
    for (const u of await usersFor(env, network)) {
      for (const leaf of leaves) {
        const d = decryptNote(leaf.ciphertext, u.keys.viewSk);
        if (!d || d.amount === 0n) continue;
        if (commitment(d.amount, u.me.ownerKey, d.blinding) !== leaf.commitment) continue; // not theirs, or a bogus ciphertext
        notes.push({ phone: u.phone, pos: leaf.idx, ...d, nullifier: nullifier(u.keys.nk, leaf.commitment, leaf.idx), tx: leaf.tx });
      }
    }
  }

  await env.DB.batch([
    ...leaves.map((l) =>
      env.DB.prepare('INSERT OR IGNORE INTO pool_leaves (network, idx, commitment, ciphertext, block) VALUES (?, ?, ?, ?, ?)').bind(
        network,
        l.idx,
        l.commitment.toString(),
        l.ciphertext,
        l.block,
      ),
    ),
    ...nullifiers.map((n) => env.DB.prepare('INSERT OR IGNORE INTO pool_nullifiers (network, nullifier) VALUES (?, ?)').bind(network, n.toString())),
    ...notes.map((n) =>
      env.DB.prepare(
        'INSERT OR IGNORE INTO shielded_notes (network, pos, phone, amount, blinding, nullifier, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(network, n.pos, n.phone, n.amount.toString(), n.blinding.toString(), n.nullifier.toString(), n.tx),
    ),
    env.DB.prepare(
      `UPDATE shielded_notes SET spent = 1 WHERE network = ? AND spent = 0
       AND nullifier IN (SELECT nullifier FROM pool_nullifiers WHERE network = ?)`,
    ).bind(network, network),
  ]);

  const size = await extendTree(env, network);
  // A leaf past the tree's end means a receipt we never ingested (say, a send that timed out): rescan from the last
  // contiguous leaf's block.
  const ahead = await env.DB.prepare('SELECT 1 FROM pool_leaves WHERE network = ? AND idx > ? LIMIT 1').bind(network, size).first();
  if (ahead) {
    const last = size
      ? await env.DB.prepare('SELECT block FROM pool_leaves WHERE network = ? AND idx = ?').bind(network, size - 1).first<{ block: number }>()
      : null;
    const block = last ? last.block - 1 : Number(poolOf(network).fromBlock) - 1;
    await env.DB.prepare(
      'INSERT INTO pool_cursors (network, block, done) VALUES (?, ?, 0) ON CONFLICT (network) DO UPDATE SET block = MIN(block, excluded.block), done = 0',
    )
      .bind(network, block)
      .run();
  }
};

/**
 * Makes sure the index holds every leaf: a no-op once caught up. Otherwise
 * scans pool logs from the cursor (the deploy block at first) until the tree
 * has the pool's nextIndex leaves, saving the cursor after each chunk so a
 * killed run still advances.
 */
export const catchUp = async (env: Env, network: NetworkName) => {
  const { pool, fromBlock } = poolOf(network);
  const cursor = await env.DB.prepare('SELECT block, done FROM pool_cursors WHERE network = ?').bind(network).first<{ block: number; done: number }>();
  if (cursor?.done) return;
  const pub = publicClient(env, network);
  const [nextIndex, head] = await Promise.all([pub.readContract({ address: pool, abi: shieldedPoolAbi, functionName: 'nextIndex' }), pub.getBlockNumber()]);
  const save = (block: bigint, done: boolean) =>
    env.DB.prepare('INSERT INTO pool_cursors (network, block, done) VALUES (?, ?, ?) ON CONFLICT (network) DO UPDATE SET block = excluded.block, done = excluded.done')
      .bind(network, Number(block), done ? 1 : 0)
      .run();
  let from = cursor ? BigInt(cursor.block) + 1n : fromBlock;
  for (let i = 0; ; i++) {
    if ((await treeSize(env, network)) >= nextIndex) return save(from - 1n, true);
    if (from > head || i === CATCH_UP_CHUNKS) {
      await save(from - 1n, false);
      throw new GatewayError('syncing', 503);
    }
    const to = from + LOG_RANGE - 1n < head ? from + LOG_RANGE - 1n : head;
    await ingest(env, network, await pub.getLogs({ address: pool, fromBlock: from, toBlock: to }));
    await save(to, false);
    from = to + 1n;
  }
};
