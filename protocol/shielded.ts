/**
 * Split-key shielded-pool client logic, shared by the app (phone) and the
 * gateway. Port of spikes/nova-splitkey/src/shielded.mjs: both sides call
 * buildTx with the same inputs and must get identical nullifiers, output
 * notes, ciphertexts, extDataHash and signed message, which is what lets a
 * 64-byte signature over SMS authorize a transaction the gateway then proves.
 * Pure JS (no WebAssembly, no Buffer): runs on Hermes and in Workers.
 *
 * Keys: the phone holds authSk (the EdDSA spending authority, never shared),
 * nk (nullifier key) and viewSk (x25519 note-decryption key). The gateway gets
 * provingKeys(): nk, viewSk and the authority PUBLIC key.
 */
import { xsalsa20poly1305, hsalsa } from '@noble/ciphers/salsa.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  bytesToHex,
  bytesToBigInt,
  concat,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  numberToBytes,
  stringToBytes,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { FIELD_SIZE, packSignature, poseidon, prv2pub, signPoseidon, unpackSignature, verifyPoseidon } from './babyjub';
import { CIRCUITS } from './select';

export { FIELD_SIZE, poseidon };
export const LEVELS = 23;
/** keccak256("tornado") % FIELD_SIZE: the empty-leaf value of the pool's Merkle tree. */
export const ZERO_VALUE = 21663839004416932945382355908790599225266501822907911457504978515578255421292n;

export type User = { authSk: Uint8Array; nk: bigint; viewSk: Uint8Array };
export type ProvingKeys = { nk: bigint; viewSk: Uint8Array; Ax: bigint; Ay: bigint };
export type Owner = ProvingKeys & { ownerKey: bigint; encPk: Uint8Array };
/** Where an output goes: a shielded address, or NULL_OWNER (encPk null). */
export type Recipient = { ownerKey: bigint; encPk: Uint8Array | null };
/** chainId and pool address, hashed into extDataHash (one deployment per signature). */
export type Domain = { chainId: number; pool: Address };
export type Note = { amount: bigint; blinding: bigint; pos: number };
export type TxIn = Note & { commitment: bigint; nullifier: bigint };
export type Output = { amount: bigint; to: Recipient };
export type TxOut = Output & { blinding: bigint; commitment: bigint };
export type ExtData = {
  recipient: Address;
  extAmount: bigint;
  relayer: Address;
  fee: bigint;
  deadline: bigint;
  encryptedOutput1: Hex;
  encryptedOutput2: Hex;
};
export type Sealed = { outs: TxOut[]; extData: ExtData; extDataHash: bigint; publicAmount: bigint };
export type Tx = Sealed & { ins: TxIn[]; msg: bigint };
export type Deposit = Sealed & { value: bigint; nonce: Hex };

const b32 = (x: bigint) => numberToBytes(x, { size: 32 });
const kdf = (tag: string, ...xs: bigint[]) => hexToBytes(keccak256(concat([stringToBytes(tag), ...xs.map(b32)])));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const randomField = () => bytesToBigInt(random(31));

// ---------- keys

/** Random keys (the gateway's own deposit authority, tests). The app uses shieldedKeysFromSeed. */
export const newUser = (): User => ({ authSk: random(32), nk: randomField(), viewSk: random(32) });

/**
 * A user's shielded keys from one secret (the app: a passkey PRF output under
 * its own salt, distinct from the EVM wallet key's). HKDF-SHA256, no salt,
 * one info label per key:
 *   authSk = HKDF(seed, "ender/shielded/v1/auth", 32)
 *   nk     = HKDF(seed, "ender/shielded/v1/nk",   31) as a big-endian integer (< 2^248, a field element)
 *   viewSk = HKDF(seed, "ender/shielded/v1/view", 32)
 */
export const shieldedKeysFromSeed = (seed: Uint8Array): User => {
  if (seed.length < 32) throw new Error('shielded seed must be at least 32 bytes');
  const d = (label: string, n: number) => hkdf(sha256, seed, undefined, stringToBytes(`ender/shielded/v1/${label}`), n);
  return { authSk: d('auth', 32), nk: bytesToBigInt(d('nk', 31)), viewSk: d('view', 32) };
};

/** Everything but the authority private key: what the gateway gets at onboarding. */
export const provingKeys = ({ authSk, nk, viewSk }: User): ProvingKeys => {
  const [Ax, Ay] = prv2pub(authSk);
  return { nk, viewSk, Ax, Ay };
};

/** Derived public values: ownerKey = Poseidon(Ax, Ay, Poseidon(nk)); encPk = x25519(viewSk). */
export const owner = ({ nk, viewSk, Ax, Ay }: ProvingKeys): Owner => ({
  nk,
  viewSk,
  Ax,
  Ay,
  ownerKey: poseidon([Ax, Ay, poseidon([nk])]),
  encPk: x25519.getPublicKey(viewSk),
});

/** Shielded address, 64 bytes: ownerKey || x25519 encryption key. Off-chain only. */
export const packAddress = ({ ownerKey, encPk }: { ownerKey: bigint; encPk: Uint8Array }) => concat([b32(ownerKey), encPk]);
export const unpackAddress = (b: Uint8Array): { ownerKey: bigint; encPk: Uint8Array } => {
  if (b.length !== 64) throw new Error('shielded address must be 64 bytes');
  return { ownerKey: bytesToBigInt(b.subarray(0, 32)), encPk: b.slice(32) };
};

// ---------- notes

export const commitment = (amount: bigint, ownerKey: bigint, blinding: bigint) => poseidon([amount, ownerKey, blinding]);
export const nullifier = (nk: bigint, c: bigint, pos: number | bigint) => poseidon([nk, c, BigInt(pos)]);

// NaCl box (x25519-xsalsa20-poly1305), as tweetnacl: key = HSalsa20(x25519(sk, pk), 0).
const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
const u32 = (b: Uint8Array) => new Uint32Array(Uint8Array.from(b).buffer);
const boxKey = (pk: Uint8Array, sk: Uint8Array) => {
  const out = new Uint32Array(8);
  hsalsa(SIGMA, u32(x25519.getSharedSecret(sk, pk)), new Uint32Array(4), out);
  return new Uint8Array(out.buffer);
};

/**
 * Deterministic note encryption, 135 bytes: nonce 24 | ephemeral pubkey 32 |
 * box 79 (plaintext amount 31 + blinding 32). Ephemeral key and nonce come
 * from the sender's nk and the note's commitment, so the phone reproduces the
 * gateway's ciphertext (it is inside extDataHash, which the phone signs).
 */
export const encryptNote = (o: { amount: bigint; blinding: bigint; commitment: bigint }, encPk: Uint8Array, nk: bigint): Hex => {
  const ephSk = kdf('ender/note-eph', nk, o.commitment);
  const nonce = kdf('ender/note-nonce', nk, o.commitment).subarray(0, 24);
  const pt = concat([numberToBytes(o.amount, { size: 31 }), b32(o.blinding)]);
  const box = xsalsa20poly1305(boxKey(encPk, ephSk), nonce).encrypt(pt);
  return bytesToHex(concat([nonce, x25519.getPublicKey(ephSk), box]));
};

export const decryptNote = (data: Hex, viewSk: Uint8Array): { amount: bigint; blinding: bigint } | null => {
  const b = hexToBytes(data);
  if (b.length < 56 + 16) return null;
  try {
    const pt = xsalsa20poly1305(boxKey(b.subarray(24, 56), viewSk), b.subarray(0, 24)).decrypt(b.subarray(56));
    return pt.length === 63 ? { amount: bytesToBigInt(pt.subarray(0, 31)), blinding: bytesToBigInt(pt.subarray(31)) } : null;
  } catch {
    return null;
  }
};

// ---------- the transaction both sides build

/** An empty output: amount 0, owner key 0, blinding 0, no ciphertext. Its commitment is the pool's NULL_COMMITMENT. */
export const NULL_OWNER: Recipient = Object.freeze({ ownerKey: 0n, encPk: null });
export const NULL_COMMITMENT = commitment(0n, 0n, 0n);
const isNull = (to: Recipient) => to.encPk === null;

/** A withdrawal's outputs: [0 to self, change], or two null outputs when there is no change (no leaves, ~860k less gas). */
export const withdrawOutputs = (change: Output): Output[] =>
  change.amount > 0n ? [{ amount: 0n, to: change.to }, change] : [{ amount: 0n, to: NULL_OWNER }, { amount: 0n, to: NULL_OWNER }];

/** Must match ShieldedPool: uint256(keccak256(abi.encode(block.chainid, address(this), extData))) % FIELD_SIZE. */
export const EXT_DATA_TYPE = {
  type: 'tuple',
  components: [
    { name: 'recipient', type: 'address' },
    { name: 'extAmount', type: 'int256' },
    { name: 'relayer', type: 'address' },
    { name: 'fee', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'encryptedOutput1', type: 'bytes' },
    { name: 'encryptedOutput2', type: 'bytes' },
  ],
} as const;
export const extDataHash = (extData: ExtData, { chainId, pool }: Domain) =>
  BigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, EXT_DATA_TYPE], [BigInt(chainId), pool, extData]))) %
  FIELD_SIZE;

export type BuildTx = {
  me: Owner;
  /** Circuit size: 2, 6 or 12. */
  nIns?: number;
  /** 0-nIns real notes of `me`, any order (sorted by tree position here). */
  inputs: Note[];
  /** Exactly two. */
  outputs: Output[];
  extAmount?: bigint;
  fee?: bigint;
  recipient?: Address;
  relayer?: Address;
  deadline: bigint | number;
  domain: Domain;
};

/**
 * Dummy inputs (amount 0, root check skipped) use the owner's keys; their
 * blinding derives from the first real nullifier. Output blinding_i =
 * Poseidon(nk, nullifier0, nullifier1, i). Signed message:
 * Poseidon(nullifier[0..nIns), commitment0, commitment1, extDataHash, publicAmount).
 */
export const buildTx = ({ me, nIns = 2, inputs, outputs, extAmount = 0n, fee = 0n, recipient = zeroAddress, relayer = zeroAddress, deadline, domain }: BuildTx): Tx => {
  if (!CIRCUITS.includes(nIns) || inputs.length > nIns || outputs.length !== 2) throw new Error(`transaction${nIns}: 0-${nIns} inputs, 2 outputs`);
  const ins: TxIn[] = [...inputs]
    .sort((a, b) => a.pos - b.pos)
    .map((n) => {
      const c = commitment(n.amount, me.ownerKey, n.blinding);
      return { amount: n.amount, blinding: n.blinding, pos: n.pos, commitment: c, nullifier: nullifier(me.nk, c, n.pos) };
    });
  addDummies(me, ins, nIns, () => randomField());
  const blindingOf = (i: number) => poseidon([me.nk, ins[0]!.nullifier, ins[1]!.nullifier, BigInt(i)]);
  return withMsg(ins, seal({ nk: me.nk, outputs, blindingOf, extAmount, fee, recipient, relayer, deadline, domain }));
};

/** Fills ins up to nIns. The first dummy's blinding is random only when there is no real input (a deposit). */
const addDummies = (me: { nk: bigint; ownerKey: bigint }, ins: TxIn[], nIns: number, first: () => bigint) => {
  while (ins.length < nIns) {
    const blinding = ins.length ? poseidon([me.nk, ins[0]!.nullifier, BigInt(ins.length)]) : first();
    const c = commitment(0n, me.ownerKey, blinding);
    ins.push({ amount: 0n, blinding, pos: 0, commitment: c, nullifier: nullifier(me.nk, c, 0) });
  }
};

type SealArgs = {
  nk: bigint;
  outputs: Output[];
  blindingOf: (i: number) => bigint;
  extAmount: bigint;
  fee: bigint;
  recipient: Address;
  relayer: Address;
  deadline: bigint | number;
  domain: Domain;
};

/** Output notes, extData, extDataHash, publicAmount. nk keys the deterministic note encryption. */
const seal = ({ nk, outputs, blindingOf, extAmount, fee, recipient, relayer, deadline, domain }: SealArgs): Sealed => {
  const outs: TxOut[] = outputs.map((o, i) => {
    if (isNull(o.to) && o.amount !== 0n) throw new Error('a null output carries no amount');
    const blinding = isNull(o.to) ? 0n : blindingOf(i);
    return { amount: o.amount, to: o.to, blinding, commitment: commitment(o.amount, o.to.ownerKey, blinding) };
  });
  const enc = (o: TxOut): Hex => (o.to.encPk === null ? '0x' : encryptNote(o, o.to.encPk, nk));
  const extData: ExtData = {
    recipient,
    extAmount,
    relayer,
    fee,
    deadline: BigInt(deadline),
    encryptedOutput1: enc(outs[0]!),
    encryptedOutput2: enc(outs[1]!),
  };
  const h = extDataHash(extData, domain);
  const publicAmount = (((extAmount - fee) % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE;
  return { outs, extData, extDataHash: h, publicAmount };
};

const withMsg = (ins: TxIn[], s: Sealed): Tx => ({
  ins,
  ...s,
  msg: poseidon([...ins.map((x) => x.nullifier), s.outs[0]!.commitment, s.outs[1]!.commitment, s.extDataHash, s.publicAmount]),
});

// ---------- EIP-3009 deposits

/** Per-quote seed for deposit blindings: unique per (quote id, exp), known to the phone and the gateway. */
export const quoteSeed = (id: string, exp: number | bigint) => (BigInt(exp) << 32n) | bytesToBigInt(stringToBytes(id));

export type BuildDeposit = {
  me: Owner;
  outputs: Output[];
  fee?: bigint;
  relayer?: Address;
  deadline: bigint | number;
  seed: bigint;
  domain: Domain;
};

/**
 * A deposit as the depositor builds it alone (no inputs, no gateway keys):
 * outputs, extData (recipient 0, extAmount = outputs + fee), and the EIP-3009
 * nonce keccak256(extDataHash, commitment0, commitment1). Output blinding_i =
 * Poseidon(nk, seed, i). value is what the authorization moves: deposit + fee.
 */
export const buildDeposit = ({ me, outputs, fee = 0n, relayer = zeroAddress, deadline, seed, domain }: BuildDeposit): Deposit => {
  const value = outputs.reduce((s, o) => s + o.amount, 0n) + fee;
  const blindingOf = (i: number) => poseidon([me.nk, seed, BigInt(i)]);
  const s = seal({ nk: me.nk, outputs, blindingOf, extAmount: value, fee, recipient: zeroAddress, relayer, deadline, domain });
  const nonce = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [toFixedHex(s.extDataHash), toFixedHex(s.outs[0]!.commitment), toFixedHex(s.outs[1]!.commitment)],
    ),
  );
  return { ...s, value, nonce };
};

/**
 * The gateway completes a deposit: dummy inputs under its own keys (gw =
 * owner(...)), and the message its own EdDSA key signs. firstBlinding is the
 * first dummy's blinding (random; injectable for tests).
 */
export const depositTx = (gw: Owner, dep: Deposit, nIns = 2, firstBlinding: bigint = randomField()): Tx => {
  const ins: TxIn[] = [];
  addDummies(gw, ins, nIns, () => firstBlinding);
  return withMsg(ins, dep);
};

/** EIP-712 typed data of AUSD's ReceiveWithAuthorization. ausd: { address, name, version }. */
export const receiveAuth = (
  ausd: { address: Address; name: string; version: string },
  chainId: number,
  { from, to, value, validBefore, nonce }: { from: Address; to: Address; value: bigint; validBefore: bigint | number; nonce: Hex },
) => ({
  domain: { name: ausd.name, version: ausd.version, chainId, verifyingContract: ausd.address },
  types: {
    ReceiveWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'ReceiveWithAuthorization' as const,
  message: { from, to, value, validAfter: 0n, validBefore: BigInt(validBefore), nonce },
});

// ---------- spending authority (phone)

/** 64 bytes: compressed R8 (32) || S (32, little-endian), circomlibjs packSignature. */
export const sign = (authSk: Uint8Array, msg: bigint) => packSignature(signPoseidon(authSk, msg));

export const verifySig = (sig: Uint8Array, msg: bigint, { Ax, Ay }: { Ax: bigint; Ay: bigint }) => {
  if (sig.length !== 64) return false;
  const { R8, S } = unpackSignature(sig);
  return R8 !== null && verifyPoseidon(msg, { R8, S }, [Ax, Ay]);
};

// ---------- proving (gateway)

/** What witnessInput needs of the gateway's Merkle tree (fixed-merkle-tree's shape). */
export type MerkleTree = { root: bigint; path(pos: number): { pathElements: bigint[] } };
export type WitnessInput = ReturnType<typeof witnessInput>;

/** Circuit input for the prover. keys: {nk, Ax, Ay}; sig: 64 bytes (garbage gives a zero R8, for negative tests). */
export const witnessInput = (tx: Tx, tree: MerkleTree, keys: { nk: bigint; Ax: bigint; Ay: bigint }, sig: Uint8Array) => {
  let R8 = [0n, 0n];
  let S = 0n;
  if (sig.length === 64) {
    const s = unpackSignature(sig);
    if (s.R8) R8 = s.R8;
    S = s.S;
  }
  return {
    root: tree.root,
    publicAmount: tx.publicAmount,
    extDataHash: tx.extDataHash,
    inputNullifier: tx.ins.map((x) => x.nullifier),
    inAmount: tx.ins.map((x) => x.amount),
    inBlinding: tx.ins.map((x) => x.blinding),
    inPathIndices: tx.ins.map((x) => x.pos),
    inPathElements: tx.ins.map((x) => (x.amount > 0n ? tree.path(x.pos).pathElements : new Array<bigint | number>(LEVELS).fill(0))),
    nk: keys.nk,
    authAx: keys.Ax,
    authAy: keys.Ay,
    sigR8x: R8[0]!,
    sigR8y: R8[1]!,
    sigS: S,
    outputCommitment: tx.outs.map((x) => x.commitment),
    outAmount: tx.outs.map((x) => x.amount),
    outPubkey: tx.outs.map((x) => x.to.ownerKey),
    outBlinding: tx.outs.map((x) => x.blinding),
  };
};

/** JSON for the prover (snarkjs input): bigints as decimal strings. */
export const witnessJson = (input: WitnessInput) => JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

export const toFixedHex = (n: bigint | number | string, length = 32) => `0x${BigInt(n).toString(16).padStart(length * 2, '0')}` as Hex;

/** snarkjs groth16 proof (decimal strings). */
export type Groth16Proof = { pi_a: string[]; pi_b: string[][]; pi_c: string[] };

/** The pool's Proof struct for transact()/depositWithAuthorization() from a snarkjs proof and its input (Nova's limb order). */
export const proofArgs = (proof: Groth16Proof, input: WitnessInput) => ({
  proof: `0x${[proof.pi_a[0], proof.pi_a[1], proof.pi_b[0]![1], proof.pi_b[0]![0], proof.pi_b[1]![1], proof.pi_b[1]![0], proof.pi_c[0], proof.pi_c[1]]
    .map((x) => toFixedHex(x!).slice(2))
    .join('')}` as Hex,
  root: toFixedHex(input.root),
  inputNullifiers: input.inputNullifier.map((x) => toFixedHex(x)),
  outputCommitments: input.outputCommitment.map((x) => toFixedHex(x)),
  publicAmount: input.publicAmount,
  extDataHash: toFixedHex(input.extDataHash),
});
