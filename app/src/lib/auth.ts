/**
 * Sign-in by wallet signature: the gateway's challenge, signed with the
 * passkey's wallet key over the message the app builds itself
 * (protocol/auth.ts), for a token. The first sign-in creates the account and
 * its random Ender ID. A token the gateway refuses (expired, or a phone-number
 * one from before) is replaced from the open Quick send key, else dropped
 * until the next passkey unlock signs in again (wallet.ts afterUnlock).
 */
import { loginMessage } from '../../../protocol/auth';
import { api, onUnauthorized } from './api';
import { quickSend, type Unlocked } from './keys';
import { setState } from './store';

export const signIn = async (u: Unlocked) => {
  const c = await api.challenge(u.address);
  const signature = await u.account.signMessage!({ message: loginMessage({ address: u.address, ...c }) });
  const r = await api.verifyAuth({ address: u.address, signature });
  setState({ token: r.token });
  return r;
};

const renew = async () => {
  const session = quickSend.get();
  if (session)
    try {
      await signIn(session.unlocked);
      return true;
    } catch {
      // Dropped below: the next unlock signs in.
    }
  setState({ token: undefined });
  return false;
};

/** One sign-in at a time, however many requests got a 401 together. */
let pending: Promise<boolean> | null = null;
onUnauthorized(() => (pending ??= renew().finally(() => (pending = null))));
