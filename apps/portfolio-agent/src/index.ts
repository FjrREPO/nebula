/**
 * Standalone portfolio-agent runner: buy the oracle's reports over x402,
 * decide allocations, and execute them through the vault. Assumes the oracle
 * agent's report server is already up (X402_SERVER_URL, default :4021).
 *
 *   bun run apps/portfolio-agent/src/index.ts
 */
import { llmConfigFromEnv, RunLog } from '@nebula/core';
import {
  actorFromEnv,
  chainConfigFromEnv,
  contractHashesFromEnv,
  createRpcClient,
  NebulaProtocol,
} from '@nebula/plugin-onchain';
import { ORIGINATION_BOOK } from '@nebula/plugin-oracle';

import { buyReports, decideAllocations, executeAllocations } from './agent';

const config = chainConfigFromEnv();
const hashes = contractHashesFromEnv();
const rpc = createRpcClient(config);
const protocol = new NebulaProtocol(rpc, config.chainName, hashes);
const manager = actorFromEnv('portfolioAgent');
const originator = actorFromEnv('originator');
const runLog = new RunLog(new URL('../../../data/run.json', import.meta.url).pathname);

let llm;
try {
  llm = llmConfigFromEnv();
} catch {
  console.warn('No LLM configured; deciding allocations with the pro-rata fallback');
}

const reports = await buyReports({
  oracleBaseUrl: process.env.X402_SERVER_URL ?? 'http://localhost:4021',
  assetIds: ORIGINATION_BOOK.map((asset) => asset.assetId),
  payer: manager,
  runLog,
});

const availableAtomic = BigInt(process.env.NEBULA_AVAILABLE_ATOMIC ?? '2000000000000');
const decisions = await decideAllocations({
  reports,
  availableAtomic,
  riskLimit: 60,
  llm,
});
console.log(`Decided ${decisions.length} allocations`);

await executeAllocations({
  protocol,
  chainName: config.chainName,
  manager,
  decisions,
  originatorPublicKeyHex: originator.publicKey.toHex(),
  runLog,
});
console.log('Portfolio agent run complete');
