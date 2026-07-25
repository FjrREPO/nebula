import { readFileSync } from 'node:fs';

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { KeyAlgorithm, PrivateKey } from 'casper-js-sdk';

/**
 * Casper Wallet's BIP-44 derivation path (coin type 506, secp256k1).
 * Account index is the last path segment.
 */
const CASPER_DERIVATION_PATH = "m/44'/506'/0'/0";

/** Derive the secp256k1 key a Casper Wallet mnemonic controls. */
export function privateKeyFromMnemonic(mnemonic: string, accountIndex = 0): PrivateKey {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const node = HDKey.fromMasterSeed(seed).derive(`${CASPER_DERIVATION_PATH}/${accountIndex}`);
  if (!node.privateKey) {
    throw new Error('BIP-32 derivation produced no private key');
  }
  return PrivateKey.fromHex(Buffer.from(node.privateKey).toString('hex'), KeyAlgorithm.SECP256K1);
}

export interface SignerOptions {
  /** PEM file path; wins over the mnemonic when both are provided. */
  pemPath?: string;
  pemAlgorithm?: KeyAlgorithm;
  mnemonic?: string;
  /** BIP-44 account index for the mnemonic (default 0). */
  mnemonicIndex?: number;
  /** When set, the loaded key's public hex must match (sanity check). */
  expectedPublicKeyHex?: string;
}

/** Load the operator signer from a PEM file or a mnemonic. */
export function loadSigner(options: SignerOptions): PrivateKey {
  let signer: PrivateKey;
  if (options.pemPath) {
    signer = PrivateKey.fromPem(
      readFileSync(options.pemPath, 'utf8'),
      options.pemAlgorithm ?? KeyAlgorithm.SECP256K1,
    );
  } else if (options.mnemonic) {
    signer = privateKeyFromMnemonic(options.mnemonic, options.mnemonicIndex ?? 0);
  } else {
    throw new Error('No signer configured: set CASPER_SECRET_KEY_PATH or CASPER_MNEMONIC');
  }

  const publicHex = signer.publicKey.toHex().toLowerCase();
  const expected = options.expectedPublicKeyHex?.toLowerCase();
  if (expected && publicHex !== expected) {
    throw new Error(
      `Loaded signer public key ${publicHex} does not match CASPER_PUBLIC_KEY_HEX ${expected}`,
    );
  }
  return signer;
}

/** Load the signer straight from the process environment. */
export function signerFromEnv(): PrivateKey {
  return loadSigner({
    pemPath: process.env.CASPER_SECRET_KEY_PATH?.trim() || undefined,
    mnemonic: process.env.CASPER_MNEMONIC?.trim() || undefined,
    mnemonicIndex: Number(process.env.CASPER_MNEMONIC_INDEX ?? '0'),
    expectedPublicKeyHex: process.env.CASPER_PUBLIC_KEY_HEX?.trim() || undefined,
  });
}

/**
 * Well-known mnemonic account indexes for the protocol's actors. All derive
 * from the same operator mnemonic; each is an independent Casper account.
 */
export const ACTOR_INDEX = {
  admin: 1,
  portfolioAgent: 2,
  oracleAgent: 3,
  originator: 4,
  investor: 5,
} as const;

export type ActorName = keyof typeof ACTOR_INDEX;

/** Derive one of the protocol actors from the operator mnemonic. */
export function actorFromEnv(actor: ActorName): PrivateKey {
  const mnemonic = process.env.CASPER_MNEMONIC?.trim();
  if (!mnemonic) {
    throw new Error('CASPER_MNEMONIC required to derive actor accounts');
  }
  return privateKeyFromMnemonic(mnemonic, ACTOR_INDEX[actor]);
}
