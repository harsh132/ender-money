// Port of tornado-nova src/utxo.js (BigNumber -> BigInt).
import { randomBN, poseidonHash, toBuffer } from './utils.mjs'
import { Keypair } from './keypair.mjs'

export class Utxo {
  constructor({ amount = 0n, keypair = new Keypair(), blinding = randomBN(), index = null } = {}) {
    this.amount = BigInt(amount)
    this.blinding = BigInt(blinding)
    this.keypair = keypair
    this.index = index
  }

  getCommitment() {
    if (this._commitment === undefined) {
      this._commitment = poseidonHash([this.amount, this.keypair.pubkey, this.blinding])
    }
    return this._commitment
  }

  getNullifier() {
    if (this._nullifier === undefined) {
      if (this.amount > 0n && (this.index === undefined || this.index === null || !this.keypair.privkey)) {
        throw new Error('Can not compute nullifier without utxo index or private key')
      }
      const signature = this.keypair.privkey ? this.keypair.sign(this.getCommitment(), this.index || 0) : 0n
      this._nullifier = poseidonHash([this.getCommitment(), this.index || 0, signature])
    }
    return this._nullifier
  }

  encrypt() {
    return this.keypair.encrypt(Buffer.concat([toBuffer(this.amount, 31), toBuffer(this.blinding, 31)]))
  }

  static decrypt(keypair, data, index) {
    const buf = keypair.decrypt(data)
    return new Utxo({
      amount: BigInt('0x' + buf.subarray(0, 31).toString('hex')),
      blinding: BigInt('0x' + buf.subarray(31, 62).toString('hex')),
      keypair,
      index,
    })
  }
}
