/**
 * EIP-712 `transfer_with_authorization` digest for the x402 "exact" scheme on
 * Casper. Reproduces `NebulaUsd`'s on-chain digest (EIP-3009 / casper-eip-712
 * Casper-native domain) byte-for-byte, so a payer can sign off-chain and any
 * facilitator can settle on-chain:
 *
 *   digest = keccak256(0x19 || 0x01 || domainSeparator || structHash)
 */
import { keccak_256 } from '@noble/hashes/sha3';

const utf8 = new TextEncoder();

function keccak(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** EIP-712 `uint256`: 32-byte big-endian. */
function uint256(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** EIP-712 `encodeAddress` for a Casper key: keccak256(0x00 || account_hash). */
function encodeAddress(accountHash: Uint8Array): Uint8Array {
  return keccak(concat(new Uint8Array([0x00]), accountHash));
}

export interface Eip712Domain {
  name: string;
  version: string;
  /** CAIP-2 chain name, e.g. `casper:casper-test`. */
  chainName: string;
  /** The token's 32-byte contract package hash. */
  packageHash: Uint8Array;
}

export interface TransferAuthorization {
  /** Payer 32-byte account hash. */
  from: Uint8Array;
  /** Payee 32-byte account hash. */
  to: Uint8Array;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  /** 32-byte single-use nonce. */
  nonce: Uint8Array;
}

export function domainSeparator(domain: Eip712Domain): Uint8Array {
  const typeHash = keccak(
    utf8.encode(
      'EIP712Domain(string name,string version,string chain_name,bytes32 contract_package_hash)',
    ),
  );
  return keccak(
    concat(
      typeHash,
      keccak(utf8.encode(domain.name)),
      keccak(utf8.encode(domain.version)),
      keccak(utf8.encode(domain.chainName)),
      domain.packageHash,
    ),
  );
}

export function structHash(authorization: TransferAuthorization): Uint8Array {
  const typeHash = keccak(
    utf8.encode(
      'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)',
    ),
  );
  return keccak(
    concat(
      typeHash,
      encodeAddress(authorization.from),
      encodeAddress(authorization.to),
      uint256(authorization.value),
      uint256(authorization.validAfter),
      uint256(authorization.validBefore),
      authorization.nonce,
    ),
  );
}

/** The full EIP-712 digest the payer signs and the contract verifies. */
export function transferWithAuthorizationDigest(
  domain: Eip712Domain,
  authorization: TransferAuthorization,
): Uint8Array {
  return keccak(
    concat(new Uint8Array([0x19, 0x01]), domainSeparator(domain), structHash(authorization)),
  );
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const normalized = hex.replace(/^0x/, '').replace(/^hash-/, '');
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
