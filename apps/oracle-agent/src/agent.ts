import type { PrivateKey } from 'casper-js-sdk';

import { RunLog, type LlmConfig } from '@nebula/core';
import { explorerTxUrl, NebulaProtocol } from '@nebula/plugin-onchain';
import {
  ORIGINATION_BOOK,
  reportHash,
  underwrite,
  type InvoiceAsset,
  type RiskReport,
} from '@nebula/plugin-oracle';
import {
  servePaywalled,
  x402Address,
  type PaymentRequirements,
  type SettleContext,
} from '@nebula/plugin-x402';

export interface AttestedReport {
  asset: InvoiceAsset;
  report: RiskReport;
  dataHash: string;
  attestTx: string;
  reportPath: string;
}

/**
 * Underwrite every asset in the origination book and anchor each assessment
 * on-chain: risk score + report hash + the x402 URI where the full report is
 * sold. The oracle's registered identity signs every attestation.
 */
export async function underwriteAndAttest(options: {
  protocol: NebulaProtocol;
  chainName: string;
  oracleSigner: PrivateKey;
  llm?: LlmConfig;
  reportBaseUrl: string;
  runLog: RunLog;
}): Promise<AttestedReport[]> {
  const attested: AttestedReport[] = [];
  for (const asset of ORIGINATION_BOOK) {
    const report = await underwrite(asset, options.llm);
    const dataHash = reportHash(report);
    const reportPath = `/reports/${asset.assetId}`;
    const result = await options.protocol.attest(
      options.oracleSigner,
      asset.assetId,
      report.riskScore,
      dataHash,
      `${options.reportBaseUrl}${reportPath}`,
    );
    await options.runLog.append({
      actor: 'oracle-agent',
      kind: 'attest',
      summary: `Attested ${asset.assetId} at risk ${report.riskScore} (${report.recommendation})`,
      transactionHash: result.transactionHash,
      explorerUrl: explorerTxUrl(options.chainName, result.transactionHash),
      data: { assetId: asset.assetId, riskScore: report.riskScore, dataHash, model: report.model },
    });
    attested.push({
      asset,
      report,
      dataHash,
      attestTx: result.transactionHash,
      reportPath,
    });
  }
  return attested;
}

/**
 * Serve the underwriting reports behind the x402 paywall. Buyers get an HTTP
 * 402 with payment requirements; a signed nUSD authorization settles on-chain
 * (facilitator or self-settle) before the report is released.
 */
export function serveReports(options: {
  port: number;
  attested: AttestedReport[];
  oracleSigner: PrivateKey;
  priceAtomic: bigint;
  network: string;
  nusdPackageHash: string;
  settleContext: SettleContext;
  runLog: RunLog;
}) {
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: options.network,
    payTo: x402Address(options.oracleSigner.publicKey),
    amount: options.priceAtomic.toString(),
    asset: options.nusdPackageHash.replace(/^hash-/, ''),
    extra: { name: 'Nebula USD', version: '1', decimals: '9' },
    maxTimeoutSeconds: 900,
  };

  return servePaywalled({
    port: options.port,
    requirements,
    settleContext: options.settleContext,
    resources: options.attested.map((entry) => ({
      path: entry.reportPath,
      description: `Underwriting report for ${entry.asset.assetId}`,
      handler: (_request, settlement) => ({
        report: entry.report,
        dataHash: entry.dataHash,
        attestationTx: entry.attestTx,
        paidVia: settlement.transactionHash,
      }),
    })),
    onSale: (resourcePath, settlement) => {
      void options.runLog.append({
        actor: 'oracle-agent',
        kind: 'x402-sale',
        summary: `Sold ${resourcePath} for ${Number(options.priceAtomic) / 1e9} nUSD via x402`,
        transactionHash: settlement.transactionHash,
        explorerUrl: settlement.explorerUrl,
        data: { resourcePath, payer: settlement.payer },
      });
    },
  });
}
