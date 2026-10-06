# Runbook: auto-bridge gas and fees

How to keep the gateway able to pay for bridges, and how to collect the fees
they earn. Background: [gateway.md, Auto-bridge](gateway.md#auto-bridge).

The gateway key pays the gas for every bridge on the origin chain. Relay
collects our app fee in USDC and holds it off-chain until we claim it. The two
never meet: fees don't refill gas, so both are manual.

| | |
| --- | --- |
| Gateway key | `0x458E8F51EC2B833209b5C71372376eeb1e40af08` (same address on every chain) |
| Private key | `GATEWAY_PRIVATE_KEY` in `.env` (also the gateway's Worker secret) |
| Fee recipient | the same address (`BRIDGE_FEE_RECIPIENT`) |

**Careful:** this key also signs and pays for every Monad transaction the
gateway sends. Never paste it into a website, a chat or a command line that
lands in shell history. If it leaks, rotate it everywhere (Worker secret,
`.env`, pool gateway via the admin) before anything else.

## 1. Fund the gateway key

### Starting amounts

| Chain | Send | Network to pick when withdrawing | Lasts roughly |
| --- | --- | --- | --- |
| Ethereum | 0.02 ETH | Ethereum (ERC-20) | 50 bridges at 3 gwei |
| Base | 0.002 ETH | Base | hundreds to thousands |
| Arbitrum | 0.002 ETH | Arbitrum One (not Nova) | hundreds to thousands |
| Polygon | 10 POL | Polygon PoS (native POL, not POL on Ethereum) | thousands |

A bridge costs about 125-135k gas the first time on a chain (it includes the
delegation) and about 100k after that.

### Steps

1. From an exchange or your own wallet, send the native token for each chain
   to `0x458E8F51EC2B833209b5C71372376eeb1e40af08`. Pick the network in the
   table: the wrong network sends the funds somewhere the gateway can't use.
   Send a small test amount first if you're withdrawing from an exchange.
2. Check each balance arrived (needs Foundry's `cast`):

   ```bash
   cast balance 0x458E8F51EC2B833209b5C71372376eeb1e40af08 --ether --rpc-url https://eth.drpc.org
   cast balance 0x458E8F51EC2B833209b5C71372376eeb1e40af08 --ether --rpc-url https://base.drpc.org
   cast balance 0x458E8F51EC2B833209b5C71372376eeb1e40af08 --ether --rpc-url https://arbitrum.drpc.org
   cast balance 0x458E8F51EC2B833209b5C71372376eeb1e40af08 --ether --rpc-url https://polygon.drpc.org
   ```

   Or look the address up on etherscan.io, basescan.org, arbiscan.io and
   polygonscan.com.

### When to top up

The gateway refuses a bridge (`sponsor-low`) unless the key holds twice that
bridge's priced gas cost, and logs `bridge: the gateway key is low on <chain>`.
Nothing alerts you beyond that log line, so:

- Check the four balances weekly with the commands above, and top up any chain
  below about a quarter of its starting amount.
- Or watch for the log live:

  ```bash
  bunx wrangler tail -c gateway/wrangler.jsonc --search "is low"
  ```

## 2. Claim the fees

Fees accrue at Relay as USDC. Claiming sends them on-chain to an address of
your choice; Relay deducts the claim's gas from the amount.

### Check what has accrued

```bash
curl https://api.relay.link/app-fees/0x458E8F51EC2B833209b5C71372376eeb1e40af08/balances
```

Each entry has the `currency` (chain and token), `amountFormatted` and
`minimumAmount`. Claim only entries above their `minimumAmount`, and wait for
a balance large enough that the claim's gas is a small part of it.

### Option A: Relay's website

Easiest, but it means loading the gateway key into a browser wallet.

1. Import `GATEWAY_PRIVATE_KEY` into a browser wallet (Rabby or MetaMask) by
   copying it from `.env`. Don't use a wallet profile that syncs to the cloud.
2. Open https://relay.link/claim-app-fees, connect that account, choose the
   balance and the recipient address, and sign the message (a plain message
   signature, no gas).
3. Remove the imported account from the browser wallet afterwards.

### Option B: the API (key stays on this machine)

1. Ask Relay for the claim. Use the `chainId` and `currency` address from the
   balances response; `recipient` is where the USDC should go (the gateway key
   or your own wallet):

   ```bash
   curl -X POST https://api.relay.link/app-fees/0x458E8F51EC2B833209b5C71372376eeb1e40af08/claim \
     -H 'content-type: application/json' \
     -d '{"chainId": 8453, "currency": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "recipient": "0x458E8F51EC2B833209b5C71372376eeb1e40af08"}'
   ```

   The response's `steps[0]` has a `sign` block (`"signatureKind": "eip191"`)
   with a hex `message`, and a `requestId`.
2. Sign that message as an EIP-191 personal message with the gateway key,
   reading the key from `.env` rather than typing it:

   ```bash
   set -a; . ./.env; set +a
   cast wallet sign --private-key "$GATEWAY_PRIVATE_KEY" <message from step 1>
   ```

   `cast wallet sign` treats a `0x…` message as raw bytes, which is what Relay
   expects. Check that `cast wallet verify --address 0x458E8F51EC2B833209b5C71372376eeb1e40af08 <message> <signature>`
   says it's valid before submitting.
3. Submit the signature with the `requestId`:

   ```bash
   curl -X POST "https://api.relay.link/execute/permits?signature=<signature>" \
     -H 'content-type: application/json' \
     -d '{"kind": "request", "requestId": "<requestId from step 1>"}'
   ```
4. Run the balances call again: the claimed entry drops to about zero, and the
   USDC shows up at the recipient shortly after.

Reference: https://docs.relay.link/features/app-fees

### Turning fees back into gas (optional)

To refill the gateway key from what you claimed, swap the USDC into each
chain's native token at https://relay.link (USDC on Base → ETH on Base,
Arbitrum and Ethereum, POL on Polygon), with the gateway key as the recipient.
