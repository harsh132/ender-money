// Gateway side of the Groth16 prover container (../Dockerfile). Copy into gateway/src, export ProverContainer from the
// Worker entry (`export { ProverContainer } from './prover'`), and merge wrangler.snippet.jsonc into gateway/wrangler.jsonc.
// Needs `@cloudflare/containers` (checked against 0.3.7).
import { Container, getContainer } from '@cloudflare/containers'

export class ProverContainer extends Container {
  defaultPort = 8080 // the server opens this port only after the 2-in key is loaded, so "port ready" means ready to prove
  sleepAfter = '60s'
  enableInternet = false // the prover never calls out
  pingEndpoint = 'localhost/health'
}

export type Circuit = 2 | 6 | 12
export type Groth16Proof = { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol: 'groth16'; curve: 'bn128' }
export type ProveResult = { proof: Groth16Proof; publicSignals: string[] } // what snarkjs groth16.fullProve returns
export type ProverEnv = { PROVER: DurableObjectNamespace<ProverContainer> }

/** status 400: bad request (a gateway bug). 422: the witness doesn't satisfy the circuit (bad input; don't retry). 500: prover fault. */
export class ProverError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

// ponytail: one named instance proves everything, one proof at a time (1.0 / 2.3 / 4.4 s for 2/6/12-in at 1 vCPU). Shard by name when SIGs queue.
const prover = (env: ProverEnv) => getContainer(env.PROVER, 'prover')

/** input: exactly what the spike's witnessInput() returns; BigInts go as decimal strings. The body holds the user's nk: never log it. */
export async function prove(env: ProverEnv, circuit: Circuit, input: Record<string, unknown>): Promise<ProveResult> {
  const res = await prover(env).fetch('http://prover/prove', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ circuit, input }, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.json()) as ProveResult & { error?: string }
  if (!res.ok) throw new ProverError(res.status, body.error ?? `prover ${res.status}`)
  return body
}

/**
 * Start the container if it's asleep and load the circuit's key (the 2-in is always loaded), so the SIG that follows
 * never waits on a cold start. Call when sending a Q, with the circuit the selection rule picks:
 * `ctx.waitUntil(warm(env, circuit).catch(() => {}))`. The idle timer then runs 60 s from this call.
 */
export async function warm(env: ProverEnv, circuit: Circuit = 2): Promise<void> {
  const res = await prover(env).fetch(`http://prover/warm?circuit=${circuit}`, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new ProverError(res.status, `warm ${circuit}: ${res.status}`)
}
