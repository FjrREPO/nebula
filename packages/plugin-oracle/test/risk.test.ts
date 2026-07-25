import { describe, expect, test } from 'bun:test';

import { assetById, heuristicRiskScore, ORIGINATION_BOOK, reportHash, underwrite } from '../src';

describe('origination book', () => {
  test('assets resolve by id', () => {
    expect(assetById('INV-2026-0007').debtor).toContain('Unilever');
    expect(() => assetById('INV-9999-0000')).toThrow();
  });
});

describe('heuristic risk model', () => {
  test('orders the book by credit quality', () => {
    const scores = ORIGINATION_BOOK.map(heuristicRiskScore);
    // AA blue-chip < BBB mid-market < CCC venture-stage.
    expect(scores[0]!).toBeLessThan(scores[1]!);
    expect(scores[1]!).toBeLessThan(scores[2]!);
  });

  test('scores stay within 0..100', () => {
    for (const asset of ORIGINATION_BOOK) {
      const score = heuristicRiskScore(asset);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  test('the risky asset breaches the vault risk limit of 60', () => {
    expect(heuristicRiskScore(assetById('INV-2026-0019'))).toBeGreaterThan(60);
    expect(heuristicRiskScore(assetById('INV-2026-0007'))).toBeLessThanOrEqual(60);
  });
});

describe('underwriting without an LLM', () => {
  test('falls back to the deterministic model', async () => {
    const report = await underwrite(assetById('INV-2026-0007'), undefined);
    expect(report.model).toBe('heuristic-v1');
    expect(report.recommendation).toBe('finance');
    expect(reportHash(report)).toMatch(/^blake2b:[0-9a-f]{64}$/);
  });

  test('report hash is content-addressed', async () => {
    const a = await underwrite(assetById('INV-2026-0007'), undefined);
    const b = { ...a, riskScore: a.riskScore + 1 };
    expect(reportHash(a)).not.toBe(reportHash(b));
  });
});
