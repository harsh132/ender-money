/**
 * Proves the on-chain path end to end on one network, before any app or
 * gateway exists:
 *
 *   1. (testnet) top up the demo user's AUSD from Agora's faucet, gateway pays.
 *   2. The demo user signs an EIP-7702 authorization to Calibur (first run only).
 *   3. The demo user signs one Calibur batch: AUSD to the recipient + fee to the gateway.
 *   4. The gateway simulates, then sends it, paying all gas; the user holds no MON.
 *
 *   bun run onchain:check mainnet|testnet [--send]
 *
 * Without --send it stops after the simulation. Recipient defaults to the
 * gateway, so the AUSD stays in our own wallets.
 */
import { createPublicClient, createWalletClient, formatEther, formatUnits, http, parseAbi, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AUSD_DECIMALS, CALIBUR, NETWORKS, type NetworkName } from '../protocol/networks';
import { caliburAbi, encodeExecute, erc20Abi, isDelegatedToCalibur, signedBatchTypedData, transferWithFee } from '../protocol/calibur';

const name = process.argv[2] as NetworkName;
const send = process.argv.includes('--send');
if (!(name in NETWORKS)) throw new Error('usage: onchain-check mainnet|testnet [--send]');
const net = NETWORKS[name];

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing from .env`);
  return v as Hex;
};
const gateway = privateKeyToAccount(env('GATEWAY_PRIVATE_KEY'));
const user = privateKeyToAccount(env('DEMO_USER_PRIVATE_KEY'));
const recipient = (process.env.RECIPIENT as Address | undefined) ?? gateway.address;

const AMOUNT = parseUnits('0.10', AUSD_DECIMALS);
const FEE = parseUnits('0.01', AUSD_DECIMALS);
const DEADLINE_SECONDS = 300n;
// ponytail: flat 20% headroom on estimates; Monad bills the gas limit, so tune once real numbers exist.
const withHeadroom = (gas: bigint) => (gas * 12n) / 10n;

const pub = createPublicClient({ chain: net.chain, transport: http() });
const gw = createWalletClient({ account: gateway, chain: net.chain, transport: http() });
const usr = createWalletClient({ account: user, chain: net.chain, transport: http() });
const ausdBalance = (a: Address) => pub.readContract({ address: net.ausd, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const ausd = (v: bigint) => `${formatUnits(v, AUSD_DECIMALS)} AUSD`;
const txUrl = (h: Hex) => `${net.explorer}/tx/${h}`;

console.log(`network   ${name} (${net.chain.id})`);
console.log(`gateway   ${gateway.address}  ${formatEther(await pub.getBalance({ address: gateway.address }))} MON`);
console.log(`user      ${user.address}  ${ausd(await ausdBalance(user.address))}`);
console.log(`recipient ${recipient}`);

// 1. Testnet faucet, paid by the gateway.
if ((await ausdBalance(user.address)) < AMOUNT + FEE) {
  if (!net.ausdFaucet) throw new Error(`user needs at least ${ausd(AMOUNT + FEE)}`);
  if (!send) throw new Error('user needs faucet AUSD; rerun with --send');
  const hash = await gw.writeContract({
    address: net.ausdFaucet,
    abi: parseAbi(['function requestFunds(address to)']),
    functionName: 'requestFunds',
    args: [user.address],
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`faucet    ${txUrl(hash)} -> ${ausd(await ausdBalance(user.address))}`);
}

// 2. Delegation, only if the account isn't already Calibur.
const code = await pub.getCode({ address: user.address });
const delegated = isDelegatedToCalibur(code);
if (code && code !== '0x' && !delegated) throw new Error(`user already runs other code: ${code}`);
const authorization = delegated
  ? undefined
  : await usr.signAuthorization({
      contractAddress: CALIBUR,
      chainId: net.chain.id,
      nonce: await pub.getTransactionCount({ address: user.address }),
    });
console.log(`delegated ${delegated ? 'yes' : 'no, sending authorization with the batch'}`);

// 3. The batch the user signs.
const nonce = delegated
  ? await pub.readContract({ address: user.address, abi: caliburAbi, functionName: 'getSeq', args: [0n] })
  : 0n;
const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_SECONDS;
const calls = transferWithFee(net.ausd, recipient, AMOUNT, gateway.address, FEE);
const signature = await usr.signTypedData(signedBatchTypedData(user.address, net.chain.id, calls, nonce, deadline));
const data = encodeExecute(calls, nonce, deadline, signature);
const authorizationList = authorization ? [authorization] : undefined;

// 4. Simulate, then send from the gateway.
await pub.call({ account: gateway.address, to: user.address, data, authorizationList });
const gas = withHeadroom(await pub.estimateGas({ account: gateway.address, to: user.address, data, authorizationList }));
console.log(`simulate  ok, gas limit ${gas}`);
if (!send) {
  console.log('dry run   rerun with --send to broadcast');
  process.exit(0);
}

const before = { user: await ausdBalance(user.address), recipient: await ausdBalance(recipient), gw: await pub.getBalance({ address: gateway.address }) };
const hash = await gw.sendTransaction({ to: user.address, data, authorizationList, gas });
const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') throw new Error(`reverted: ${txUrl(hash)}`);

const after = { user: await ausdBalance(user.address), recipient: await ausdBalance(recipient), gw: await pub.getBalance({ address: gateway.address }) };
console.log(`sent      ${txUrl(hash)}`);
console.log(`gas used  ${receipt.gasUsed} of ${gas}, gateway paid ${formatEther(before.gw - after.gw)} MON`);
console.log(`user      ${ausd(before.user)} -> ${ausd(after.user)}`);
console.log(`recipient ${ausd(before.recipient)} -> ${ausd(after.recipient)}`);
console.log(`delegated ${isDelegatedToCalibur(await pub.getCode({ address: user.address })) ? 'yes' : 'NO'}`);
