// Port of tornado-nova src/keypair.js (eth-sig-util v3 -> @metamask/eth-sig-util, ethers -> node crypto).
import crypto from 'node:crypto'
import { encrypt, decrypt, getEncryptionPublicKey } from '@metamask/eth-sig-util'
import { poseidonHash, toFixedHex } from './utils.mjs'

export function packEncryptedMessage(encryptedMessage) {
  const nonceBuf = Buffer.from(encryptedMessage.nonce, 'base64')
  const ephemPublicKeyBuf = Buffer.from(encryptedMessage.ephemPublicKey, 'base64')
  const ciphertextBuf = Buffer.from(encryptedMessage.ciphertext, 'base64')
  const messageBuff = Buffer.concat([
    Buffer.alloc(24 - nonceBuf.length),
    nonceBuf,
    Buffer.alloc(32 - ephemPublicKeyBuf.length),
    ephemPublicKeyBuf,
    ciphertextBuf,
  ])
  return '0x' + messageBuff.toString('hex')
}

export function unpackEncryptedMessage(encryptedMessage) {
  const messageBuff = Buffer.from(encryptedMessage.replace(/^0x/, ''), 'hex')
  return {
    version: 'x25519-xsalsa20-poly1305',
    nonce: messageBuff.subarray(0, 24).toString('base64'),
    ephemPublicKey: messageBuff.subarray(24, 56).toString('base64'),
    ciphertext: messageBuff.subarray(56).toString('base64'),
  }
}

export class Keypair {
  /** @param {string} privkey 0x-prefixed 32-byte hex; random if omitted */
  constructor(privkey = '0x' + crypto.randomBytes(32).toString('hex')) {
    this.privkey = privkey
    this.pubkey = poseidonHash([this.privkey]) // circuit reduces privkey mod p, so does circomlibjs
    this.encryptionKey = getEncryptionPublicKey(privkey.slice(2))
  }

  /** "Shielded address": pubkey (32 bytes) || x25519 encryption key (32 bytes) */
  address() {
    return toFixedHex(this.pubkey) + Buffer.from(this.encryptionKey, 'base64').toString('hex')
  }

  static fromString(str) {
    str = str.replace(/^0x/, '')
    if (str.length !== 128) throw new Error('Invalid key length')
    return Object.assign(Object.create(Keypair.prototype), {
      privkey: null,
      pubkey: BigInt('0x' + str.slice(0, 64)),
      encryptionKey: Buffer.from(str.slice(64, 128), 'hex').toString('base64'),
    })
  }

  sign(commitment, merklePath) {
    return poseidonHash([this.privkey, commitment, merklePath])
  }

  encrypt(bytes) {
    return packEncryptedMessage(
      encrypt({ publicKey: this.encryptionKey, data: bytes.toString('base64'), version: 'x25519-xsalsa20-poly1305' }),
    )
  }

  decrypt(data) {
    return Buffer.from(decrypt({ encryptedData: unpackEncryptedMessage(data), privateKey: this.privkey.slice(2) }), 'base64')
  }
}
