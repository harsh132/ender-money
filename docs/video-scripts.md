# Submission videos

Three videos: the technical demo (≤ 3 min), the pitch (≤ 2 min) and Agora's
(≤ 2 min: onboarding, balance, a completed send and receive). Timings are
targets; the voice-over is a guide, say it your way.

## Before recording

- Two Android phones with the latest APK
  ([assets.ender.money/android/ender.apk](https://assets.ender.money/android/ender.apk)).
  Phone A: you, with a verified phone number (Settings → Phone number). Phone B:
  a second account (fresh passkey) with its own Ender ID.
- Phone A in Testnet mode with about 50 test AUSD; Phone B in Testnet mode.
- Top up the gateway's testnet gas (`0x458E…af08`, 0.27 MON left; a private
  payment is about 2.3M gas). A few MON covers every take.
- Warm the prover: make one private payment a few minutes before recording, so
  the first take isn't a cold start.
- "No internet" means mobile data and Wi-Fi off, not airplane mode: SMS needs
  the cellular radio.
- Screen-record both phones (Android's built-in recorder), plus a laptop
  browser for the pay page and the explorer.
- Clear Activity clutter: hidden rows don't show, but old failed test payments
  do. A fresh Phone B account is cleanest.

## 1. Technical demo (≤ 3:00)

| Time | Screen | Voice-over |
| --- | --- | --- |
| 0:00–0:15 | ender.money hero | "Ender is a self-custodial dollar wallet that works with spotty internet, or none at all, and keeps your payments private." |
| 0:15–0:40 | Phone B: open app → Create passkey → "Your Ender ID" screen | "Sign-up is one passkey. No seed phrase, no phone number, no gas token. You get a name, and the passkey is the key: it never leaves the phone." |
| 0:40–1:10 | Phone A: Send → type Phone B's Ender ID → amount → Review → slide → done. Phone B: balance updates | "Pay anyone by name. This payment is private: on chain it's a pool transaction, and nobody can see who paid whom. The recipient still sees it's from me." |
| 1:10–1:25 | Phone B: Activity row "from harsh.ender.my" → tap → details | "Every received payment names the sender: their Ender ID, never an address dump." |
| 1:25–2:05 | Phone A: turn off data and Wi-Fi → Send to Phone B's ID → Review → send (the app opens the SMS composer; tap send) → reply SMS arrives → app updates | "Now no internet. Same payment, it goes as a text message. The phone signs it, the gateway relays it on chain and texts back the result. One SMS each way." |
| 2:05–2:25 | Phone A: data back on → Home: one balance; Settings → Auto Shield | "Money that lands on your public address moves into your private balance automatically. One balance, private by default." |
| 2:25–2:45 | Laptop: `harsh.ender.my` pay page; MetaMask send field resolving `harsh.ender.my` | "Your Ender ID is a real ENS name: any wallet can pay it, and it has a page with your addresses." |
| 2:45–3:00 | README architecture diagram | "Under the hood: passkey accounts with EIP-7702, a Groth16 shielded pool with a split key, Alchemy webhooks for alerts, and an SMS relay. Self-custodial throughout." |

Cut if long: the pay page (2:25–2:45). Try the MetaMask lookup once before
recording; if it doesn't resolve there, show only the pay page.

## 2. Pitch (≤ 2:00)

Talking head or voice over slides; the app on screen where it helps.

1. **Problem (0:00–0:30).** Hundreds of millions of people send money home.
   They pay high fees and wait days, and many have patchy data or a basic
   phone plan. Crypto dollars could fix the cost, but wallets assume good
   internet, seed phrases and gas tokens, and every payment is public.
2. **Product (0:30–1:05).** Ender: a dollar wallet that works with spotty
   internet, by plain SMS when there's none. Sign up with a passkey, get a
   name, pay anyone by name or phone number. Payments are private by default.
   Self-custody: the key never leaves the phone.
3. **Why now (1:05–1:25).** Fast, cheap settlement on Monad, regulated dollars
   with AUSD, passkey accounts, and zero-knowledge proofs fast enough to run on
   every payment.
4. **Go to market (1:25–1:50).** Start with remittance corridors into India,
   where SMS is universal: migrant workers and their families. Free to receive,
   a flat cent to send. Grow through names: every payment to an Ender ID is an
   invite.
5. **Ask (1:50–2:00).** "We're live, with a waitlist at ender.money. Try it:
   download the app and pay someone by name."

## 3. Agora: onboarding, balance, send and receive (≤ 2:00)

| Time | Screen | Voice-over |
| --- | --- | --- |
| 0:00–0:10 | ender.money | "Ender: AUSD payments that work over the internet or SMS." |
| 0:10–0:40 | Phone B: Create passkey → Your Ender ID → Home with zero balance | "Onboarding is one passkey. You get a dollar account and a name in under 30 seconds." |
| 0:40–1:00 | Phone B: Receive screen (name, QR, address); Phone A sends 10 AUSD to it | "To receive, share your name or QR code." |
| 1:00–1:15 | Phone B: balance becomes $10.00; Activity row from Phone A's ID | "It arrives in seconds. Balances are AUSD, always a dollar." |
| 1:15–1:45 | Phone B: Send 5 AUSD back to Phone A's ID → Review → done; Phone A receives | "Sending is the same: a name, an amount, one confirmation. The fee is one cent, and gas is covered." |
| 1:45–2:00 | Phone A: the same payment with data off (if time) or the explorer page of the transfer | "And when the internet drops, the same payment goes by text." |

Keep to public AUSD payments here; the private and SMS parts are in the
technical demo.
