/**
 * Standalone oracle-agent runner: underwrite the origination book, attest
 * every asset on-chain, then serve the paywalled reports until interrupted.
 *
 *   bun run apps/oracle-agent/src/index.ts
 */
import { llmConfigFromEnv, RunLog } from '@nebula/core';
import {
  actorFromEnv,
  chainConfigFromEnv,
  contractHashesFromEnv,
  createRpcClient,
  NebulaProtocol,
} from '@nebula/plugin-onchain';

import { serveReports, underwriteAndAttest } from './agent';

const config = chainConfigFromEnv();
const hashes = contractHashesFromEnv();
const rpc = createRpcClient(config);
const protocol = new NebulaProtocol(rpc, config.chainName, hashes);
const oracleSigner = actorFromEnv('oracleAgent');
const runLog = new RunLog(new URL('../../../data/run.json', import.meta.url).pathname);

const port = Number(process.env.X402_PORT ?? '4021');
let llm;
try {
  llm = llmConfigFromEnv();
} catch {
  console.warn('No LLM configured; underwriting with the deterministic model');
}

const attested = await underwriteAndAttest({
  protocol,
  chainName: config.chainName,
  oracleSigner,
  llm,
  reportBaseUrl: `http://localhost:${port}`,
  runLog,
});

const server = serveReports({
  port,
  attested,
  oracleSigner,
  priceAtomic: BigInt(process.env.X402_PRICE_ATOMIC ?? '500000000'),
  network: `casper:${config.chainName}`,
  nusdPackageHash: hashes.nusd,
  settleContext: {
    facilitator: process.env.X402_FACILITATOR_URL
      ? { url: process.env.X402_FACILITATOR_URL, apiKey: config.cloudApiKey }
      : undefined,
    selfSettle: { protocol, chainName: config.chainName, signer: oracleSigner },
  },
  runLog,
});

console.log(`Oracle agent serving ${attested.length} paywalled reports on :${server.port}`);
