/** In-memory hand-off between onboarding screens. Never persisted: the token is only kept once a wallet is linked. */
import type { Address } from 'viem';

export type Verified =
  | { phone: string; token: string; status: 'new' }
  | { phone: string; token: string; status: 'existing'; address: Address; balance: string; name?: string | null };

export const onboarding: { phone?: string; verified?: Verified; devCode?: string } = {};
