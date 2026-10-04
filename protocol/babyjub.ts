/**
 * Poseidon and EdDSA-Poseidon on BabyJubJub, byte-for-byte what circomlibjs
 * (and so the circuit's EdDSAPoseidonVerifier) does, in plain BigInt: no
 * WebAssembly, so it runs on Hermes and in Workers.
 */
import { blake512 } from '@noble/hashes/blake1.js';
import { poseidon1 } from 'poseidon-lite/poseidon1';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { poseidon3 } from 'poseidon-lite/poseidon3';
import { poseidon4 } from 'poseidon-lite/poseidon4';
import { poseidon5 } from 'poseidon-lite/poseidon5';
import { poseidon6 } from 'poseidon-lite/poseidon6';
import { poseidon10 } from 'poseidon-lite/poseidon10';
import { poseidon16 } from 'poseidon-lite/poseidon16';

/** BN254 scalar field: the circuit's field and BabyJubJub's base field. */
export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const p = FIELD_SIZE;

const POSEIDON: Record<number, (xs: bigint[]) => bigint> = {
  1: poseidon1, 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 6: poseidon6, 10: poseidon10, 16: poseidon16,
};

/** circomlibjs poseidon(items). Widths the protocol uses: 1-6 (keys, notes, Merkle, EdDSA), 10 and 16 (6- and 12-in messages). */
export const poseidon = (items: bigint[]): bigint => {
  const h = POSEIDON[items.length];
  if (!h) throw new Error(`poseidon: no ${items.length}-input instance`);
  return h(items.map(BigInt));
};

// ---------- field and curve

const mod = (a: bigint, m = p) => ((a % m) + m) % m;
const pow = (b: bigint, e: bigint) => {
  let r = 1n;
  for (b = mod(b); e > 0n; e >>= 1n, b = (b * b) % p) if (e & 1n) r = (r * b) % p;
  return r;
};
const inv = (a: bigint) => pow(a, p - 2n);

const A = 168700n;
const D = 168696n;
const SUB_ORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
export const BASE8: Point = [
  5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  16950150798460657717958625567821834550301663161624707787222815936182638968203n,
];
export type Point = [bigint, bigint];

/** Projective twisted-Edwards addition (add-2008-bbjlp); same affine result as circomlibjs addPoint. */
type P3 = [bigint, bigint, bigint];
const add3 = ([x1, y1, z1]: P3, [x2, y2, z2]: P3): P3 => {
  const a = (z1 * z2) % p;
  const b = (a * a) % p;
  const c = (x1 * x2) % p;
  const d = (y1 * y2) % p;
  const e = (((D * c) % p) * d) % p;
  const f = mod(b - e);
  const g = (b + e) % p;
  const x3 = (((a * f) % p) * mod((x1 + y1) * (x2 + y2) - c - d)) % p;
  const y3 = (((a * g) % p) * mod(d - A * c)) % p;
  return [x3, y3, (f * g) % p];
};

export const mulPoint = ([x, y]: Point, e: bigint): Point => {
  let r: P3 = [0n, 1n, 1n];
  for (let b: P3 = [x, y, 1n]; e > 0n; e >>= 1n, b = add3(b, b)) if (e & 1n) r = add3(r, b);
  const zi = inv(r[2]);
  return [(r[0] * zi) % p, (r[1] * zi) % p];
};
export const addPoint = (a: Point, b: Point): Point => {
  const r = add3([a[0], a[1], 1n], [b[0], b[1], 1n]);
  const zi = inv(r[2]);
  return [(r[0] * zi) % p, (r[1] * zi) % p];
};

export const inCurve = ([x, y]: Point) => {
  const x2 = (x * x) % p;
  const y2 = (y * y) % p;
  return mod(A * x2 + y2) === mod(1n + ((x2 * y2) % p) * D);
};

// Tonelli-Shanks, returning the root <= (p-1)/2 like ffjavascript.
const TWO_ADICITY = 28n;
const ODD = (p - 1n) >> TWO_ADICITY;
const NQR = 5n;
const sqrt = (n: bigint): bigint | null => {
  if (n === 0n) return 0n;
  if (pow(n, (p - 1n) / 2n) !== 1n) return null;
  let m = TWO_ADICITY;
  let c = pow(NQR, ODD);
  let t = pow(n, ODD);
  let r = pow(n, (ODD + 1n) / 2n);
  while (t !== 1n) {
    let i = 0n;
    for (let t2 = t; t2 !== 1n; t2 = (t2 * t2) % p) i++;
    let b = c;
    for (let j = 0n; j < m - i - 1n; j++) b = (b * b) % p;
    m = i;
    c = (b * b) % p;
    t = (t * c) % p;
    r = (r * b) % p;
  }
  return r > (p - 1n) / 2n ? p - r : r;
};

// ---------- little-endian bytes

const le = (b: Uint8Array) => {
  let x = 0n;
  for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]!);
  return x;
};
const toLe = (x: bigint, n = 32) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++, x >>= 8n) b[i] = Number(x & 0xffn);
  return b;
};

/** circomlibjs packPoint: y little-endian, top bit set when x > (p-1)/2. */
export const packPoint = ([x, y]: Point) => {
  const b = toLe(y);
  if (x > (p - 1n) / 2n) b[31]! |= 0x80;
  return b;
};

/** circomlibjs unpackPoint, without its in-place mutation of the input. */
export const unpackPoint = (buf: Uint8Array): Point | null => {
  const b = Uint8Array.from(buf);
  const sign = (b[31]! & 0x80) !== 0;
  b[31]! &= 0x7f;
  const y = le(b) % p;
  const y2 = (y * y) % p;
  const x2 = (mod(1n - y2) * inv(mod(A - D * y2))) % p;
  if (pow(x2, (p - 1n) / 2n) !== 1n) return null;
  const x = sqrt(x2)!;
  return [sign ? mod(-x) : x, y];
};

// ---------- EdDSA-Poseidon

const secret = (sk: Uint8Array) => {
  const h = blake512(sk);
  h[0]! &= 0xf8;
  h[31]! &= 0x7f;
  h[31]! |= 0x40;
  return { s: le(h.subarray(0, 32)), prefix: h.subarray(32) };
};

/** circomlibjs prv2pub: Base8 * (s >> 3), s the pruned first half of blake512(sk). */
export const prv2pub = (sk: Uint8Array): Point => mulPoint(BASE8, secret(sk).s >> 3n);

export type Signature = { R8: Point; S: bigint };

/** circomlibjs signPoseidon(sk, msg). */
export const signPoseidon = (sk: Uint8Array, msg: bigint): Signature => {
  const { s, prefix } = secret(sk);
  const pub = mulPoint(BASE8, s >> 3n);
  const compose = new Uint8Array(64);
  compose.set(prefix, 0);
  compose.set(toLe(msg), 32);
  const r = le(blake512(compose)) % SUB_ORDER;
  const R8 = mulPoint(BASE8, r);
  const hm = poseidon([R8[0], R8[1], pub[0], pub[1], msg]);
  return { R8, S: (r + hm * s) % SUB_ORDER };
};

/** circomlibjs verifyPoseidon(msg, sig, A). */
export const verifyPoseidon = (msg: bigint, sig: Signature, pub: Point): boolean => {
  if (!inCurve(sig.R8) || !inCurve(pub) || sig.S >= SUB_ORDER) return false;
  const hm = poseidon([sig.R8[0], sig.R8[1], pub[0], pub[1], msg]);
  const left = mulPoint(BASE8, sig.S);
  const right = addPoint(sig.R8, mulPoint(pub, hm * 8n));
  return left[0] === right[0] && left[1] === right[1];
};

/** 64 bytes: packed R8 || S little-endian (circomlibjs packSignature). */
export const packSignature = ({ R8, S }: Signature) => {
  const b = new Uint8Array(64);
  b.set(packPoint(R8), 0);
  b.set(toLe(S), 32);
  return b;
};

/** circomlibjs unpackSignature; R8 is null when the bytes are not a curve point. */
export const unpackSignature = (b: Uint8Array): { R8: Point | null; S: bigint } => ({
  R8: unpackPoint(b.subarray(0, 32)),
  S: le(b.subarray(32, 64)),
});
