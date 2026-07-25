import { blake2b } from '@noble/hashes/blake2b';

import { chatJson, type LlmConfig } from '@nebula/core';

import type { InvoiceAsset } from './assets';

/** A full underwriting report — the product sold behind the x402 paywall. */
export interface RiskReport {
  assetId: string;
  /** 0 (safest) ..= 100 (riskiest). */
  riskScore: number;
  recommendation: 'finance' | 'decline';
  rationale: string;
  factors: Array<{ factor: string; impact: 'positive' | 'negative'; detail: string }>;
  model: string;
  assessedAt: string;
}

/** blake2b-256 hex of the canonical report JSON — the on-chain `data_hash`. */
export function reportHash(report: RiskReport): string {
  const bytes = new TextEncoder().encode(JSON.stringify(report));
  return `blake2b:${Buffer.from(blake2b(bytes, { dkLen: 32 })).toString('hex')}`;
}

const RATING_RISK: Record<InvoiceAsset['debtorRating'], number> = {
  AAA: 5,
  AA: 10,
  A: 18,
  BBB: 32,
  BB: 48,
  B: 62,
  CCC: 80,
};

/**
 * Deterministic underwriting heuristic. Serves two purposes: the fallback
 * when no LLM is reachable, and the sanity bound that keeps an LLM score
 * from drifting into nonsense (final score is clamped to ±20 of it).
 */
export function heuristicRiskScore(asset: InvoiceAsset): number {
  let score = RATING_RISK[asset.debtorRating];

  const advanceRate = asset.advanceUsd / asset.faceValueUsd;
  if (advanceRate > 0.95) score += 12;
  else if (advanceRate > 0.85) score += 6;

  const history = asset.paymentHistory;
  const onTimeRate = history.total === 0 ? 0.5 : history.onTime / history.total;
  score += Math.round((1 - onTimeRate) * 25);

  const tenorDays =
    (new Date(asset.dueAt).getTime() - new Date(asset.issuedAt).getTime()) / 86_400_000;
  if (tenorDays > 75) score += 8;
  else if (tenorDays > 45) score += 4;

  return Math.max(0, Math.min(100, score));
}

const SYSTEM_PROMPT = `You are the underwriting engine of Nebula, an RWA financing protocol.
Assess the credit risk of financing the given invoice (factoring).
Respond with strict JSON:
{"riskScore": <0-100 integer, 0 safest>, "recommendation": "finance"|"decline",
 "rationale": "<2-3 sentences>",
 "factors": [{"factor": "...", "impact": "positive"|"negative", "detail": "..."}]}
Weigh: debtor credit rating, issuer payment history, advance rate vs face value,
invoice tenor, sector and concentration risk. Be conservative.`;

/**
 * Underwrite an asset: LLM assessment clamped by the deterministic model,
 * falling back to the heuristic entirely when the LLM is unavailable.
 */
export async function underwrite(
  asset: InvoiceAsset,
  llm: LlmConfig | undefined,
): Promise<RiskReport> {
  const baseline = heuristicRiskScore(asset);
  const assessedAt = new Date().toISOString();

  if (llm) {
    try {
      const raw = await chatJson<{
        riskScore: number;
        recommendation: 'finance' | 'decline';
        rationale: string;
        factors: RiskReport['factors'];
      }>(llm, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(asset, null, 2) },
      ]);
      const clamped = Math.max(baseline - 20, Math.min(baseline + 20, Math.round(raw.riskScore)));
      return {
        assetId: asset.assetId,
        riskScore: Math.max(0, Math.min(100, clamped)),
        recommendation: raw.recommendation,
        rationale: raw.rationale,
        factors: raw.factors ?? [],
        model: llm.model,
        assessedAt,
      };
    } catch (error) {
      console.warn(`LLM underwriting failed (${String(error)}); using heuristic model`);
    }
  }

  return {
    assetId: asset.assetId,
    riskScore: baseline,
    recommendation: baseline <= 60 ? 'finance' : 'decline',
    rationale:
      'Deterministic model: debtor rating, issuer payment history, advance rate, and tenor combined into a conservative score.',
    factors: [
      {
        factor: 'debtor-rating',
        impact: RATING_RISK[asset.debtorRating] <= 32 ? 'positive' : 'negative',
        detail: `Debtor rated ${asset.debtorRating}`,
      },
      {
        factor: 'payment-history',
        impact:
          asset.paymentHistory.onTime / Math.max(1, asset.paymentHistory.total) >= 0.8
            ? 'positive'
            : 'negative',
        detail: `${asset.paymentHistory.onTime}/${asset.paymentHistory.total} prior invoices repaid on time`,
      },
    ],
    model: 'heuristic-v1',
    assessedAt,
  };
}
