/**
 * The RWA origination book: invoices submitted for financing. In production
 * this is fed by originator uploads; for the testnet demo it is a realistic
 * fixture set spanning the risk spectrum, so the oracle's scores — and the
 * vault's on-chain risk gate — visibly diverge per asset.
 */

export interface InvoiceAsset {
  /** Protocol-level asset id, referenced on-chain. */
  assetId: string;
  issuer: string;
  issuerCountry: string;
  debtor: string;
  debtorRating: 'AAA' | 'AA' | 'A' | 'BBB' | 'BB' | 'B' | 'CCC';
  sector: string;
  faceValueUsd: number;
  /** Requested advance against face value. */
  advanceUsd: number;
  issuedAt: string;
  dueAt: string;
  /** Prior invoices from this issuer that repaid on time / total. */
  paymentHistory: { onTime: number; total: number };
  notes: string;
}

export const ORIGINATION_BOOK: InvoiceAsset[] = [
  {
    assetId: 'INV-2026-0007',
    issuer: 'Mitra Logistik Nusantara',
    issuerCountry: 'ID',
    debtor: 'Unilever Indonesia',
    debtorRating: 'AA',
    sector: 'FMCG distribution',
    faceValueUsd: 42_000,
    advanceUsd: 38_000,
    issuedAt: '2026-07-01',
    dueAt: '2026-08-30',
    paymentHistory: { onTime: 11, total: 12 },
    notes: 'Recurring quarterly distribution invoice; debtor is a listed blue-chip subsidiary.',
  },
  {
    assetId: 'INV-2026-0012',
    issuer: 'Baltik Component Works',
    issuerCountry: 'EE',
    debtor: 'Scandi Marine AS',
    debtorRating: 'BBB',
    sector: 'Marine equipment',
    faceValueUsd: 18_500,
    advanceUsd: 16_000,
    issuedAt: '2026-07-10',
    dueAt: '2026-09-08',
    paymentHistory: { onTime: 4, total: 5 },
    notes: 'Mid-size supplier, one 9-day late payment in history; debtor order book is healthy.',
  },
  {
    assetId: 'INV-2026-0019',
    issuer: 'Quickline Media Buying',
    issuerCountry: 'US',
    debtor: 'Fresh D2C Brands LLC',
    debtorRating: 'CCC',
    sector: 'Digital advertising',
    faceValueUsd: 25_000,
    advanceUsd: 24_000,
    issuedAt: '2026-07-20',
    dueAt: '2026-10-18',
    paymentHistory: { onTime: 1, total: 3 },
    notes:
      'Two of three prior invoices repaid late; debtor is a venture-stage D2C aggregator with concentrated revenue.',
  },
];

export function assetById(assetId: string): InvoiceAsset {
  const asset = ORIGINATION_BOOK.find((entry) => entry.assetId === assetId);
  if (!asset) {
    throw new Error(`Unknown asset ${assetId}`);
  }
  return asset;
}
