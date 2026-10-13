/** The emergency stop: PAUSED = "1" turns every request away and skips the cron. */
import { expect, test } from 'bun:test';
import { mockWorkers } from './test-env';

mockWorkers();
const worker = (await import('./index')).default;
type Env = import('./env').Env;

// Nothing is bound: a paused gateway must answer without touching any of it.
const env = { PAUSED: '1' } as unknown as Env;
const ctx = { waitUntil: () => { throw new Error('no work while paused'); }, passThroughOnException: () => {} } as unknown as ExecutionContext;

test('paused: every request gets 503 paused', async () => {
  for (const path of ['/auth/challenge', '/shielded/quote', '/webhooks/alchemy', '/webhooks/twilio', '/activity']) {
    const res = await worker.fetch!(new Request(`https://api.ender.money${path}`, { method: 'POST', body: '{}' }) as never, env, ctx);
    expect(res.status).toBe(503);
    expect((await res.json()) as unknown).toEqual({ error: 'paused' });
  }
});

test('paused: the cron does nothing', async () => {
  await worker.scheduled!({} as ScheduledController, env, ctx); // waitUntil throws if anything is scheduled
});
