/**
 * Gateway side of the Groth16 prover container (prover/Dockerfile; copied from
 * prover/cloudflare/prover.ts). One named instance proves everything.
 */
import { Container, getContainer } from '@cloudflare/containers';

export class ProverContainer extends Container {
  defaultPort = 8080; // the server opens this port only after the 2-in key is loaded, so "port ready" means ready to prove
  sleepAfter = '60s';
  enableInternet = false; // the prover never calls out
  pingEndpoint = 'localhost/health';
}

export type Circuit = 2 | 6 | 12;
export type Groth16Proof = { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol: 'groth16'; curve: 'bn128' };
/** What snarkjs groth16.fullProve returns. */
export type ProveResult = { proof: Groth16Proof; publicSignals: string[] };
export type ProverEnv = { PROVER: DurableObjectNamespace<ProverContainer> };

/** status 400: bad request (a gateway bug). 422: the witness doesn't satisfy the circuit (bad input; don't retry). 500: prover fault. */
export class ProverError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ponytail: one named instance, one proof at a time (1.0 / 2.3 / 4.4 s for 2/6/12-in at 1 vCPU; the server queues). Shard by name when SIGs queue.
const prover = (env: ProverEnv) => getContainer(env.PROVER, 'prover');

/** input: protocol witnessInput(); bigints go as decimal strings (witnessJson). The body holds the user's nk: never log it. */
export const prove = async (env: ProverEnv, circuit: Circuit, inputJson: string): Promise<ProveResult> => {
  const res = await prover(env).fetch('http://prover/prove', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"circuit":${circuit},"input":${inputJson}}`,
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as ProveResult & { error?: string };
  if (!res.ok) throw new ProverError(res.status, body.error ?? `prover ${res.status}`);
  return body;
};

/**
 * Starts the container if it's asleep and loads the circuit's key (the 2-in is
 * always loaded), so the SIG that follows never waits on a cold start. Called
 * when a Q goes out; the idle timer then runs 60 s from this call.
 */
export const warm = async (env: ProverEnv, circuit: Circuit = 2): Promise<void> => {
  const res = await prover(env).fetch(`http://prover/warm?circuit=${circuit}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new ProverError(res.status, `warm ${circuit}: ${res.status}`);
};
