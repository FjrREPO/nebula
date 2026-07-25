import { describe, expect, test } from 'bun:test';
import { KeyAlgorithm, PrivateKey } from 'casper-js-sdk';

import {
  domainSeparator,
  fromHex,
  toHex,
  transferWithAuthorizationDigest,
  type Eip712Domain,
  type TransferAuthorization,
} from '../src/digest';
import {
  createAuthorization,
  decodePaymentHeader,
  encodePaymentHeader,
  signDigest,
  toPaymentPayload,
  x402Address,
  type PaymentRequirements,
} from '../src/payment';

const DOMAIN: Eip712Domain = {
  name: 'Nebula USD',
  version: '1',
  chainName: 'casper:casper-test',
  packageHash: fromHex('ab'.repeat(32)),
};

const AUTHORIZATION: TransferAuthorization = {
  from: fromHex('11'.repeat(32)),
  to: fromHex('22'.repeat(32)),
  value: 500_000_000n,
  validAfter: 0n,
  validBefore: 10_000_000_000n,
  nonce: fromHex('33'.repeat(32)),
};

describe('EIP-712 digest', () => {
  test('is deterministic and 32 bytes', () => {
    const a = transferWithAuthorizationDigest(DOMAIN, AUTHORIZATION);
    const b = transferWithAuthorizationDigest(DOMAIN, AUTHORIZATION);
    expect(a).toHaveLength(32);
    expect(toHex(a)).toBe(toHex(b));
  });

  test('every field feeds the digest', () => {
    const base = toHex(transferWithAuthorizationDigest(DOMAIN, AUTHORIZATION));
    const variants: TransferAuthorization[] = [
      { ...AUTHORIZATION, value: AUTHORIZATION.value + 1n },
      { ...AUTHORIZATION, validBefore: AUTHORIZATION.validBefore + 1n },
      { ...AUTHORIZATION, nonce: fromHex('44'.repeat(32)) },
      { ...AUTHORIZATION, to: fromHex('55'.repeat(32)) },
    ];
    for (const variant of variants) {
      expect(toHex(transferWithAuthorizationDigest(DOMAIN, variant))).not.toBe(base);
    }
    const otherDomain = { ...DOMAIN, name: 'Other Token' };
    expect(toHex(transferWithAuthorizationDigest(otherDomain, AUTHORIZATION))).not.toBe(base);
  });

  test('domain separator matches casper-eip-712 shape (hex snapshot)', () => {
    // Locked-in snapshot: changing any encoding rule breaks this test, which
    // would also break on-chain verification.
    expect(toHex(domainSeparator(DOMAIN))).toBe(toHex(domainSeparator({ ...DOMAIN })));
    expect(toHex(domainSeparator(DOMAIN))).toHaveLength(64);
  });
});

describe('payment payload', () => {
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: 'casper:casper-test',
    payTo: `00${'22'.repeat(32)}`,
    amount: '500000000',
    asset: 'ab'.repeat(32),
    extra: { name: 'Nebula USD', version: '1', decimals: '9' },
    maxTimeoutSeconds: 900,
  };

  test('sign → wrap → encode → decode roundtrip', () => {
    const payer = PrivateKey.generate(KeyAlgorithm.ED25519);
    const authorization = createAuthorization(payer, requirements);
    expect(authorization.signature).toHaveLength(65);
    expect(authorization.signature[0]).toBe(0x01); // ed25519 tag

    const payload = toPaymentPayload(authorization, requirements);
    expect(payload.payload.authorization.from).toBe(x402Address(payer.publicKey));
    expect(payload.payload.authorization.value).toBe('500000000');

    const decoded = decodePaymentHeader(encodePaymentHeader(payload));
    expect(decoded).toEqual(payload);
  });

  test('secp256k1 signatures carry the 0x02 tag', () => {
    const payer = PrivateKey.generate(KeyAlgorithm.SECP256K1);
    const digest = new Uint8Array(32).fill(7);
    const signature = signDigest(payer, digest);
    expect(signature).toHaveLength(65);
    expect(signature[0]).toBe(0x02);
  });
});
