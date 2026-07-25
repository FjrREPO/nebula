import {
  Args,
  CLTypeUInt8,
  CLValue,
  ContractCallBuilder,
  Key,
  PrivateKey,
  PublicKey,
  RpcClient,
} from 'casper-js-sdk';

import { waitForExecution, type ExecutionResult } from './client';
import type { ContractHashes } from './config';

const MOTES_PER_CSPR = 1_000_000_000n;

/** Default gas for simple entry points. */
const GAS_CALL = 5n * MOTES_PER_CSPR;
/** Gas for vault entry points that fan out into cross-contract calls. */
const GAS_VAULT = 15n * MOTES_PER_CSPR;

export interface CallRequest {
  packageHash: string;
  entryPoint: string;
  args: Args;
  signer: PrivateKey;
  paymentMotes?: bigint;
}

/** Key CLValue for an account, from its public key hex. */
export function accountKey(publicKeyHex: string): CLValue {
  const accountHash = PublicKey.fromHex(publicKeyHex).accountHash().toPrefixedString();
  return CLValue.newCLKey(Key.newKey(accountHash));
}

/** Key CLValue for a contract, from its `hash-…` package hash. */
export function contractKey(packageHash: string): CLValue {
  const normalized = packageHash.startsWith('hash-') ? packageHash : `hash-${packageHash}`;
  return CLValue.newCLKey(Key.newKey(normalized));
}

/**
 * Thin, typed surface over the deployed protocol. Every method submits a
 * transaction by package hash (so calls always track the latest contract
 * version) and waits for on-chain execution before returning.
 */
export class NebulaProtocol {
  constructor(
    private readonly rpc: RpcClient,
    private readonly chainName: string,
    readonly hashes: ContractHashes,
  ) {}

  async call(request: CallRequest): Promise<ExecutionResult> {
    const transaction = new ContractCallBuilder()
      .from(request.signer.publicKey)
      .chainName(this.chainName)
      .byPackageHash(request.packageHash.replace(/^hash-/, ''))
      .entryPoint(request.entryPoint)
      .runtimeArgs(request.args)
      .payment(Number(request.paymentMotes ?? GAS_CALL))
      .build();
    transaction.sign(request.signer);
    await this.rpc.putTransaction(transaction);
    return waitForExecution(this.rpc, transaction.hash.toHex());
  }

  // --- nUSD -----------------------------------------------------------

  nusdMint(signer: PrivateKey, toPublicKeyHex: string, amount: bigint): Promise<ExecutionResult> {
    return this.call({
      packageHash: this.hashes.nusd,
      entryPoint: 'mint',
      signer,
      args: Args.fromMap({
        to: accountKey(toPublicKeyHex),
        amount: CLValue.newCLUInt256(amount.toString()),
      }),
    });
  }

  nusdApprove(signer: PrivateKey, spender: CLValue, amount: bigint): Promise<ExecutionResult> {
    return this.call({
      packageHash: this.hashes.nusd,
      entryPoint: 'approve',
      signer,
      args: Args.fromMap({
        spender,
        amount: CLValue.newCLUInt256(amount.toString()),
      }),
    });
  }

  nusdTransfer(
    signer: PrivateKey,
    recipientPublicKeyHex: string,
    amount: bigint,
  ): Promise<ExecutionResult> {
    return this.call({
      packageHash: this.hashes.nusd,
      entryPoint: 'transfer',
      signer,
      args: Args.fromMap({
        recipient: accountKey(recipientPublicKeyHex),
        amount: CLValue.newCLUInt256(amount.toString()),
      }),
    });
  }

  /**
   * EIP-3009 settlement: submit a payer's off-chain-signed authorization.
   * The caller acts as facilitator and pays the gas; funds move payer → payee.
   */
  transferWithAuthorization(
    facilitator: PrivateKey,
    authorization: {
      fromAccountHash: string;
      toAccountHash: string;
      amount: bigint;
      validAfter: bigint;
      validBefore: bigint;
      nonce: Uint8Array;
      payerPublicKeyHex: string;
      signature: Uint8Array;
    },
  ): Promise<ExecutionResult> {
    const byteList = (bytes: Uint8Array) =>
      CLValue.newCLList(
        CLTypeUInt8,
        Array.from(bytes, (byte) => CLValue.newCLUint8(byte)),
      );
    return this.call({
      packageHash: this.hashes.nusd,
      entryPoint: 'transfer_with_authorization',
      signer: facilitator,
      paymentMotes: GAS_VAULT,
      args: Args.fromMap({
        from: CLValue.newCLKey(Key.newKey(`account-hash-${authorization.fromAccountHash}`)),
        to: CLValue.newCLKey(Key.newKey(`account-hash-${authorization.toAccountHash}`)),
        amount: CLValue.newCLUInt256(authorization.amount.toString()),
        valid_after: CLValue.newCLUint64(authorization.validAfter.toString()),
        valid_before: CLValue.newCLUint64(authorization.validBefore.toString()),
        nonce: byteList(authorization.nonce),
        public_key: CLValue.newCLPublicKey(PublicKey.fromHex(authorization.payerPublicKeyHex)),
        signature: byteList(authorization.signature),
      }),
    });
  }

  // --- identity registry ----------------------------------------------

  registerIdentity(
    signer: PrivateKey,
    subject: CLValue,
    country: number,
    claimUri: string,
  ): Promise<ExecutionResult> {
    return this.call({
      packageHash: this.hashes.identity,
      entryPoint: 'register_identity',
      signer,
      args: Args.fromMap({
        subject,
        country: CLValue.newCLUInt32(country),
        claim_uri: CLValue.newCLString(claimUri),
      }),
    });
  }

  // --- oracle hub ------------------------------------------------------

  registerOracle(signer: PrivateKey, metadataUri: string): Promise<ExecutionResult> {
    return this.call({
      packageHash: this.hashes.oracleHub,
      entryPoint: 'register_oracle',
      signer,
      args: Args.fromMap({
        metadata_uri: CLValue.newCLString(metadataUri),
      }),
    });
  }

  attest(
    signer: PrivateKey,
    assetId: string,
    riskScore: number,
    dataHash: string,
    reportUri: string,
  ): Promise<ExecutionResult> {
    return this.call({
      packageHash: this.hashes.oracleHub,
      entryPoint: 'attest',
      signer,
      args: Args.fromMap({
        asset_id: CLValue.newCLString(assetId),
        risk_score: CLValue.newCLUint8(riskScore),
        data_hash: CLValue.newCLString(dataHash),
        report_uri: CLValue.newCLString(reportUri),
      }),
    });
  }

  resolveAttestation(
    signer: PrivateKey,
    attestationId: bigint,
    accurate: boolean,
  ): Promise<ExecutionResult> {
    return this.call({
      packageHash: this.hashes.oracleHub,
      entryPoint: 'resolve',
      signer,
      args: Args.fromMap({
        attestation_id: CLValue.newCLUint64(attestationId),
        accurate: CLValue.newCLValueBool(accurate),
      }),
    });
  }

  // --- compliance engine -----------------------------------------------

  setComplianceRules(
    signer: PrivateKey,
    paused: boolean,
    requireVerified: boolean,
    maxTransfer: bigint,
  ): Promise<ExecutionResult> {
    return this.call({
      packageHash: this.hashes.compliance,
      entryPoint: 'set_rules',
      signer,
      args: Args.fromMap({
        paused: CLValue.newCLValueBool(paused),
        require_verified: CLValue.newCLValueBool(requireVerified),
        max_transfer: CLValue.newCLUInt256(maxTransfer.toString()),
      }),
    });
  }

  // --- vault -----------------------------------------------------------

  deposit(signer: PrivateKey, amount: bigint): Promise<ExecutionResult> {
    return this.call({
      packageHash: this.hashes.vault,
      entryPoint: 'deposit',
      signer,
      paymentMotes: GAS_VAULT,
      args: Args.fromMap({
        amount: CLValue.newCLUInt256(amount.toString()),
      }),
    });
  }

  withdraw(signer: PrivateKey, shareAmount: bigint): Promise<ExecutionResult> {
    return this.call({
      packageHash: this.hashes.vault,
      entryPoint: 'withdraw',
      signer,
      paymentMotes: GAS_VAULT,
      args: Args.fromMap({
        share_amount: CLValue.newCLUInt256(shareAmount.toString()),
      }),
    });
  }

  allocate(
    signer: PrivateKey,
    assetId: string,
    amount: bigint,
    recipient: CLValue,
  ): Promise<ExecutionResult> {
    return this.call({
      packageHash: this.hashes.vault,
      entryPoint: 'allocate',
      signer,
      paymentMotes: GAS_VAULT,
      args: Args.fromMap({
        asset_id: CLValue.newCLString(assetId),
        amount: CLValue.newCLUInt256(amount.toString()),
        recipient,
      }),
    });
  }

  settle(signer: PrivateKey, allocationId: bigint, repayAmount: bigint): Promise<ExecutionResult> {
    return this.call({
      packageHash: this.hashes.vault,
      entryPoint: 'settle',
      signer,
      paymentMotes: GAS_VAULT,
      args: Args.fromMap({
        allocation_id: CLValue.newCLUint64(allocationId),
        repay_amount: CLValue.newCLUInt256(repayAmount.toString()),
      }),
    });
  }
}
