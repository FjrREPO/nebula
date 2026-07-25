import type { PrivateKey } from 'casper-js-sdk';

import { chatJson, RunLog, type LlmConfig } from '@nebula/core';
import { accountKey, explorerTxUrl, NebulaProtocol } from '@nebula/plugin-onchain';
import type { RiskReport } from '@nebula/plugin-oracle';
import {
  createAuthorization,
  encodePaymentHeader,
  fetchWithPayment,
  toPaymentPayload,
} from '@nebula/plugin-x402';

export interface PurchasedReport {
  assetId: string;
  report: RiskReport;
  attestationTx?: string;
  paymentTx?: string;
}

/**
 * Buy each asset's underwriting report from the oracle over x402: request →
 * HTTP 402 → sign an nUSD authorization → replay → report. One agent paying
 * another agent per API call, settled on Casper.
 */
export async function buyReports(options: {
  oracleBaseUrl: string;
  assetIds: string[];
  payer: PrivateKey;
  runLog: RunLog;
}): Promise<PurchasedReport[]> {
  const purchased: PurchasedReport[] = [];
  for (const assetId of options.assetIds) {
    const { response, paid } = await fetchWithPayment(
      `${options.oracleBaseUrl}/reports/${assetId}`,
      (requirements) =>
        encodePaymentHeader(
          toPaymentPayload(createAuthorization(options.payer, requirements), requirements),
        ),
    );
    if (!response.ok) {
      throw new Error(`Buying report for ${assetId} failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      report: RiskReport;
      attestationTx?: string;
      paidVia?: string;
    };
    await options.runLog.append({
      actor: 'portfolio-agent',
      kind: 'x402-purchase',
      summary: paid
        ? `Bought risk report ${assetId} from the oracle via x402`
        : `Fetched risk report ${assetId}`,
      transactionHash: body.paidVia,
      data: { assetId, riskScore: body.report.riskScore },
    });
    purchased.push({
      assetId,
      report: body.report,
      attestationTx: body.attestationTx,
      paymentTx: body.paidVia,
    });
  }
  return purchased;
}

export interface AllocationDecision {
  assetId: string;
  amountAtomic: bigint;
  reasoning: string;
}

const DECISION_PROMPT = `You are the portfolio manager of Nebula, an RWA yield vault on Casper.
You bought underwriting reports for candidate invoice assets. Decide allocations.
Hard constraints you must respect (the chain enforces them anyway):
- Never allocate to an asset with riskScore > {riskLimit}.
- Total allocations must not exceed {available} atomic nUSD.
- Prefer diversification across acceptable assets; keep a liquidity buffer of at least 10%.
Respond with strict JSON:
{"allocations": [{"assetId": "...", "amountAtomic": "<integer string>", "reasoning": "<1 sentence>"}]}`;

/**
 * Decide allocations from the purchased reports. The LLM proposes; a
 * deterministic guard then drops anything over the risk limit and rescales
 * to the cash constraint — and the vault contract re-verifies all of it
 * on-chain regardless.
 */
export async function decideAllocations(options: {
  reports: PurchasedReport[];
  availableAtomic: bigint;
  riskLimit: number;
  llm?: LlmConfig;
}): Promise<AllocationDecision[]> {
  const eligible = options.reports.filter((entry) => entry.report.riskScore <= options.riskLimit);
  if (eligible.length === 0) {
    return [];
  }
  const budget = (options.availableAtomic * 90n) / 100n;

  if (options.llm) {
    try {
      const raw = await chatJson<{
        allocations: Array<{ assetId: string; amountAtomic: string; reasoning: string }>;
      }>(options.llm, [
        {
          role: 'system',
          content: DECISION_PROMPT.replace('{riskLimit}', String(options.riskLimit)).replace(
            '{available}',
            options.availableAtomic.toString(),
          ),
        },
        {
          role: 'user',
          content: JSON.stringify(
            options.reports.map((entry) => entry.report),
            null,
            2,
          ),
        },
      ]);
      const eligibleIds = new Set(eligible.map((entry) => entry.assetId));
      let decisions = raw.allocations
        .filter((allocation) => eligibleIds.has(allocation.assetId))
        .map((allocation) => ({
          assetId: allocation.assetId,
          amountAtomic: BigInt(allocation.amountAtomic),
          reasoning: allocation.reasoning,
        }))
        .filter((allocation) => allocation.amountAtomic > 0n);
      const total = decisions.reduce((sum, decision) => sum + decision.amountAtomic, 0n);
      if (total > budget && total > 0n) {
        decisions = decisions.map((decision) => ({
          ...decision,
          amountAtomic: (decision.amountAtomic * budget) / total,
        }));
      }
      if (decisions.length > 0) {
        return decisions;
      }
    } catch (error) {
      console.warn(`LLM allocation failed (${String(error)}); using pro-rata fallback`);
    }
  }

  // Deterministic fallback: pro-rata across eligible assets, weighted by
  // inverse risk (safer assets get more).
  const weights = eligible.map((entry) => BigInt(101 - entry.report.riskScore));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0n);
  return eligible.map((entry, index) => ({
    assetId: entry.assetId,
    amountAtomic: (budget * weights[index]!) / weightSum,
    reasoning: `Inverse-risk pro-rata weight for score ${entry.report.riskScore}`,
  }));
}

/** Execute allocation decisions on-chain through the vault. */
export async function executeAllocations(options: {
  protocol: NebulaProtocol;
  chainName: string;
  manager: PrivateKey;
  decisions: AllocationDecision[];
  originatorPublicKeyHex: string;
  runLog: RunLog;
}): Promise<void> {
  for (const decision of options.decisions) {
    const result = await options.protocol.allocate(
      options.manager,
      decision.assetId,
      decision.amountAtomic,
      accountKey(options.originatorPublicKeyHex),
    );
    await options.runLog.append({
      actor: 'portfolio-agent',
      kind: 'allocate',
      summary: `Allocated ${Number(decision.amountAtomic) / 1e9} nUSD to ${decision.assetId}`,
      transactionHash: result.transactionHash,
      explorerUrl: explorerTxUrl(options.chainName, result.transactionHash),
      data: { ...decision, amountAtomic: decision.amountAtomic.toString() },
    });
  }
}
