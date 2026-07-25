import { PrivateKey } from 'casper-js-sdk';

import { explorerTxUrl, NebulaProtocol } from '@nebula/plugin-onchain';

import { fromHex } from './digest';
import { decodePaymentHeader, type PaymentPayload, type PaymentRequirements } from './payment';

export interface SettlementResult {
  success: boolean;
  transactionHash?: string;
  explorerUrl?: string;
  payer?: string;
  errorReason?: string;
}

export interface FacilitatorOptions {
  /** e.g. `https://x402-facilitator.cspr.cloud`. */
  url: string;
  /** CSPR.cloud access token — raw value in the Authorization header. */
  apiKey: string;
}

async function facilitatorPost(
  options: FacilitatorOptions,
  path: '/verify' | '/settle',
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${options.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: options.apiKey,
    },
    body: JSON.stringify({
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements,
    }),
  });
  if (!response.ok) {
    throw new Error(`Facilitator ${path} returned HTTP ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

/** Settle through Casper's hosted x402 facilitator (it pays the gas). */
export async function settleViaFacilitator(
  options: FacilitatorOptions,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<SettlementResult> {
  const result = await facilitatorPost(options, '/settle', paymentPayload, paymentRequirements);
  const success = result.success === true;
  return {
    success,
    transactionHash: typeof result.transaction === 'string' ? result.transaction : undefined,
    payer: typeof result.payer === 'string' ? result.payer : undefined,
    errorReason: typeof result.errorReason === 'string' ? result.errorReason : undefined,
  };
}

/**
 * Self-settle: the seller submits `transfer_with_authorization` on the nUSD
 * contract itself, acting as its own facilitator (and paying the gas). Keeps
 * the demo independent of hosted-facilitator quotas; the on-chain settlement
 * semantics are identical.
 */
export async function settleSelf(
  protocol: NebulaProtocol,
  chainName: string,
  facilitatorSigner: PrivateKey,
  paymentPayload: PaymentPayload,
): Promise<SettlementResult> {
  const { authorization, publicKey, signature } = paymentPayload.payload;
  try {
    const result = await protocol.transferWithAuthorization(facilitatorSigner, {
      fromAccountHash: authorization.from.replace(/^00/, ''),
      toAccountHash: authorization.to.replace(/^00/, ''),
      amount: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: fromHex(authorization.nonce),
      payerPublicKeyHex: publicKey,
      signature: fromHex(signature),
    });
    return {
      success: true,
      transactionHash: result.transactionHash,
      explorerUrl: explorerTxUrl(chainName, result.transactionHash),
      payer: authorization.from,
    };
  } catch (error) {
    return { success: false, errorReason: error instanceof Error ? error.message : String(error) };
  }
}

export interface SettleContext {
  facilitator?: FacilitatorOptions;
  selfSettle: {
    protocol: NebulaProtocol;
    chainName: string;
    signer: PrivateKey;
  };
}

/**
 * Settle a payment header: hosted facilitator first (when configured), with
 * transparent fallback to self-settlement.
 */
export async function settlePaymentHeader(
  context: SettleContext,
  header: string,
  requirements: PaymentRequirements,
): Promise<SettlementResult> {
  const payload = decodePaymentHeader(header);
  if (context.facilitator) {
    try {
      const result = await settleViaFacilitator(context.facilitator, payload, requirements);
      if (result.success) {
        return {
          ...result,
          explorerUrl: result.transactionHash
            ? explorerTxUrl(context.selfSettle.chainName, result.transactionHash)
            : undefined,
        };
      }
      console.warn(`Facilitator settle rejected (${result.errorReason}); self-settling`);
    } catch (error) {
      console.warn(`Facilitator unreachable (${String(error)}); self-settling`);
    }
  }
  return settleSelf(
    context.selfSettle.protocol,
    context.selfSettle.chainName,
    context.selfSettle.signer,
    payload,
  );
}
