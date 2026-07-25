import { PrivateKey, PublicKey } from 'casper-js-sdk';

import { fromHex, toHex, transferWithAuthorizationDigest, type Eip712Domain } from './digest';

export const X402_VERSION = 2;
export const X402_SCHEME = 'exact';
/** Header carrying the base64 payment payload (Casper x402 convention). */
export const PAYMENT_HEADER = 'PAYMENT-SIGNATURE';

/** x402 `PaymentRequirements` as served in the 402 response body. */
export interface PaymentRequirements {
  scheme: typeof X402_SCHEME;
  /** CAIP-2 network id, e.g. `casper:casper-test`. */
  network: string;
  /** Payee: `00`-prefixed account hash hex. */
  payTo: string;
  /** Atomic token amount (string). */
  amount: string;
  /** The CEP-18 token's 64-hex package hash. */
  asset: string;
  /** EIP-712 domain seed for the asset. */
  extra: { name: string; version: string; decimals: string };
  maxTimeoutSeconds: number;
}

/** x402 `PaymentPayload` submitted back in the payment header. */
export interface PaymentPayload {
  x402Version: number;
  scheme: typeof X402_SCHEME;
  network: string;
  payload: {
    /** 65-byte `[algo|sig]` hex. */
    signature: string;
    /** Algo-prefixed Casper public key hex. */
    publicKey: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

/** The 32-byte account hash of a Casper public key. */
export function accountHashBytes(publicKey: PublicKey): Uint8Array {
  return fromHex(
    publicKey
      .accountHash()
      .toPrefixedString()
      .replace(/^account-hash-/, ''),
  );
}

/** `00`-prefixed account-hash hex, the x402 address encoding for accounts. */
export function x402Address(publicKey: PublicKey): string {
  return `00${toHex(accountHashBytes(publicKey))}`;
}

/**
 * Sign a 32-byte digest with a Casper key. Returns `[algo_tag | 64-byte sig]`
 * (65 bytes) — casper-js-sdk `sign()` returns the bare signature, so the key's
 * algorithm prefix (0x01 ed25519, 0x02 secp256k1) is prepended to match what
 * the contract's `verify_signature` host call expects.
 */
export function signDigest(signer: PrivateKey, digest: Uint8Array): Uint8Array {
  const signature = signer.sign(digest);
  if (signature.length === 65) {
    return signature;
  }
  const tag = Number.parseInt(signer.publicKey.toHex().slice(0, 2), 16);
  const out = new Uint8Array(signature.length + 1);
  out[0] = tag;
  out.set(signature, 1);
  return out;
}

export interface SignedAuthorization {
  fromAccountHash: Uint8Array;
  toAccountHash: Uint8Array;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Uint8Array;
  signature: Uint8Array;
  payerPublicKey: PublicKey;
}

/**
 * Build and sign an EIP-3009 authorization from `payer` against the given
 * payment requirements. Pure off-chain work — the payer never submits a
 * transaction and pays no gas.
 */
export function createAuthorization(
  payer: PrivateKey,
  requirements: PaymentRequirements,
): SignedAuthorization {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = now - 600n;
  const validBefore = now + BigInt(requirements.maxTimeoutSeconds);

  const from = accountHashBytes(payer.publicKey);
  const to = fromHex(requirements.payTo.replace(/^00/, ''));
  const value = BigInt(requirements.amount);

  const domain: Eip712Domain = {
    name: requirements.extra.name,
    version: requirements.extra.version,
    chainName: requirements.network,
    packageHash: fromHex(requirements.asset),
  };
  const digest = transferWithAuthorizationDigest(domain, {
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
  });

  return {
    fromAccountHash: from,
    toAccountHash: to,
    value,
    validAfter,
    validBefore,
    nonce,
    signature: signDigest(payer, digest),
    payerPublicKey: payer.publicKey,
  };
}

/** Wrap a signed authorization in the x402 V2 wire payload. */
export function toPaymentPayload(
  authorization: SignedAuthorization,
  requirements: PaymentRequirements,
): PaymentPayload {
  return {
    x402Version: X402_VERSION,
    scheme: X402_SCHEME,
    network: requirements.network,
    payload: {
      signature: toHex(authorization.signature),
      publicKey: authorization.payerPublicKey.toHex(),
      authorization: {
        from: `00${toHex(authorization.fromAccountHash)}`,
        to: `00${toHex(authorization.toAccountHash)}`,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: toHex(authorization.nonce),
      },
    },
  };
}

export function encodePaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function decodePaymentHeader(header: string): PaymentPayload {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentPayload;
}
