/**
 * End-to-end testnet demo: the full Nebula lifecycle as real Casper
 * transactions, narrated into data/run.json for the dashboard.
 *
 *   bun run scripts/demo.ts
 *
 * Acts: fund actors → issue identities → seed nUSD → investor deposits →
 * oracle underwrites + attests + serves x402 reports → portfolio agent buys
 * reports (agent-pays-agent) → allocates through the vault's on-chain risk
 * gate → originator settles with premium → investor withdraws yield →
 * adjudicator resolves attestations into oracle reputation.
 */
import { join } from 'node:path';

import { llmConfigFromEnv, RunLog, type LlmConfig } from '@nebula/core';
import {
  accountKey,
  actorFromEnv,
  chainConfigFromEnv,
  contractHashesFromEnv,
  contractKey,
  createRpcClient,
  explorerTxUrl,
  getBalanceMotes,
  nativeTransfer,
  NebulaProtocol,
  signerFromEnv,
} from '@nebula/plugin-onchain';
import { ORIGINATION_BOOK } from '@nebula/plugin-oracle';

import { serveReports, underwriteAndAttest } from '../apps/oracle-agent/src/agent';
import {
  buyReports,
  decideAllocations,
  executeAllocations,
} from '../apps/portfolio-agent/src/agent';

const NUSD = 1_000_000_000n; // 9 decimals

const config = chainConfigFromEnv();
const hashes = contractHashesFromEnv();
const rpc = createRpcClient(config);
const protocol = new NebulaProtocol(rpc, config.chainName, hashes);
const runLog = new RunLog(join(new URL('..', import.meta.url).pathname, 'data', 'run.json'));

const admin = signerFromEnv();
const actors = {
  portfolioAgent: actorFromEnv('portfolioAgent'),
  oracleAgent: actorFromEnv('oracleAgent'),
  originator: actorFromEnv('originator'),
  investor: actorFromEnv('investor'),
};

function log(step: string) {
  console.log(`\n━━━ ${step}`);
}

async function recorded(
  actor: string,
  kind: string,
  summary: string,
  action: () => Promise<{ transactionHash: string }>,
  data?: Record<string, unknown>,
) {
  const result = await action();
  await runLog.append({
    actor,
    kind,
    summary,
    transactionHash: result.transactionHash,
    explorerUrl: explorerTxUrl(config.chainName, result.transactionHash),
    data,
  });
  console.log(`  ✓ ${summary}`);
  console.log(`    ${explorerTxUrl(config.chainName, result.transactionHash)}`);
  return result;
}

// ─── Act 0: gas funding ─────────────────────────────────────────────────────
log('Act 0 — funding actor accounts with gas');
for (const [name, key] of Object.entries(actors)) {
  const hex = key.publicKey.toHex();
  let balance = 0n;
  try {
    balance = await getBalanceMotes(rpc, hex);
  } catch {
    // Account not yet on chain — fund it below.
  }
  if (balance < 30n * NUSD) {
    await recorded('admin', 'fund', `Funded ${name} with 60 CSPR gas`, () =>
      nativeTransfer(rpc, config.chainName, admin, hex, 60n * NUSD),
    );
  } else {
    console.log(`  ${name} already funded (${Number(balance) / 1e9} CSPR)`);
  }
}

// ─── Act 1: identity issuance (ERC-3643 gate) ───────────────────────────────
log('Act 1 — issuing on-chain identities');
await recorded('admin', 'identity', 'KYC-verified the investor (country 360)', () =>
  protocol.registerIdentity(
    admin,
    accountKey(actors.investor.publicKey.toHex()),
    360,
    'nebula://kyc/investor',
  ),
);
await recorded('admin', 'identity', 'Verified the oracle agent identity', () =>
  protocol.registerIdentity(
    admin,
    accountKey(actors.oracleAgent.publicKey.toHex()),
    0,
    'nebula://agent-card/oracle',
  ),
);

// ─── Act 2: seed nUSD ───────────────────────────────────────────────────────
log('Act 2 — seeding nUSD balances');
const seedTargets: Array<[string, string, bigint]> = [
  ['investor', actors.investor.publicKey.toHex(), 5_000n * NUSD],
  ['originator', actors.originator.publicKey.toHex(), 5_000n * NUSD],
  ['portfolio agent (x402 budget)', actors.portfolioAgent.publicKey.toHex(), 100n * NUSD],
];
for (const [label, hex, amount] of seedTargets) {
  await recorded('admin', 'seed', `Sent ${Number(amount) / 1e9} nUSD to the ${label}`, () =>
    protocol.nusdTransfer(admin, hex, amount),
  );
}

// ─── Act 3: investor deposits ───────────────────────────────────────────────
log('Act 3 — investor deposits into the vault');
const DEPOSIT = 2_000n * NUSD;
await recorded('investor', 'approve', 'Approved the vault to pull 2,000 nUSD', () =>
  protocol.nusdApprove(actors.investor, contractKey(hashes.vault), DEPOSIT),
);
await recorded('investor', 'deposit', 'Deposited 2,000 nUSD → vault shares minted', () =>
  protocol.deposit(actors.investor, DEPOSIT),
);

// ─── Act 4: oracle underwrites, attests, opens shop ─────────────────────────
log('Act 4 — oracle agent underwrites and attests on-chain');
try {
  await recorded('oracle-agent', 'register', 'Registered oracle identity on the hub', () =>
    protocol.registerOracle(actors.oracleAgent, 'nebula://agent-card/oracle'),
  );
} catch (error) {
  console.log(`  (oracle already registered: ${String(error).slice(0, 80)})`);
}

let llm: LlmConfig | undefined;
try {
  llm = llmConfigFromEnv();
} catch {
  console.warn('  No LLM configured; using the deterministic underwriting model');
}

const port = Number(process.env.X402_PORT ?? '4021');
const attested = await underwriteAndAttest({
  protocol,
  chainName: config.chainName,
  oracleSigner: actors.oracleAgent,
  llm,
  reportBaseUrl: `http://localhost:${port}`,
  runLog,
});

const server = serveReports({
  port,
  attested,
  oracleSigner: actors.oracleAgent,
  priceAtomic: BigInt(process.env.X402_PRICE_ATOMIC ?? '500000000'),
  network: `casper:${config.chainName}`,
  nusdPackageHash: hashes.nusd,
  settleContext: {
    facilitator: process.env.X402_FACILITATOR_URL
      ? { url: process.env.X402_FACILITATOR_URL, apiKey: config.cloudApiKey }
      : undefined,
    selfSettle: { protocol, chainName: config.chainName, signer: actors.oracleAgent },
  },
  runLog,
});
console.log(`  Oracle report shop live on :${server.port}`);

// ─── Act 5: portfolio agent buys reports and allocates ──────────────────────
log('Act 5 — portfolio agent buys reports via x402 (agent pays agent)');
const reports = await buyReports({
  oracleBaseUrl: `http://localhost:${port}`,
  assetIds: ORIGINATION_BOOK.map((asset) => asset.assetId),
  payer: actors.portfolioAgent,
  runLog,
});

log('Act 5b — allocations through the on-chain risk gate');
const decisions = await decideAllocations({
  reports,
  availableAtomic: DEPOSIT,
  riskLimit: 60,
  llm,
});
for (const decision of decisions) {
  console.log(`  plan: ${decision.assetId} ← ${Number(decision.amountAtomic) / 1e9} nUSD`);
}
await executeAllocations({
  protocol,
  chainName: config.chainName,
  manager: actors.portfolioAgent,
  decisions,
  originatorPublicKeyHex: actors.originator.publicKey.toHex(),
  runLog,
});

// ─── Act 6: settlement with premium (yield lands) ───────────────────────────
log('Act 6 — originator settles allocations with a 5% premium');
let totalRepay = 0n;
for (let index = 0; index < decisions.length; index++) {
  const decision = decisions[index]!;
  const repay = (decision.amountAtomic * 105n) / 100n;
  totalRepay += repay;
  const allocationId = BigInt(index + 1);
  await recorded('originator', 'approve', `Approved repayment of ${Number(repay) / 1e9} nUSD`, () =>
    protocol.nusdApprove(actors.originator, contractKey(hashes.vault), repay),
  );
  await recorded(
    'originator',
    'settle',
    `Settled ${decision.assetId}: repaid ${Number(repay) / 1e9} nUSD (+5%)`,
    () => protocol.settle(actors.originator, allocationId, repay),
    { allocationId: allocationId.toString() },
  );
}

// ─── Act 7: investor withdraws yield ────────────────────────────────────────
log('Act 7 — investor withdraws half their shares (with yield)');
await recorded('investor', 'withdraw', 'Withdrew 1,000 shares at the appreciated price', () =>
  protocol.withdraw(actors.investor, 1_000n * NUSD),
);

// ─── Act 8: reputation resolution ───────────────────────────────────────────
log('Act 8 — adjudicator resolves attestations into oracle reputation');
for (let index = 0; index < attested.length; index++) {
  const entry = attested[index]!;
  await recorded(
    'admin',
    'resolve',
    `Resolved attestation for ${entry.asset.assetId} as accurate`,
    () => protocol.resolveAttestation(admin, BigInt(index + 1), true),
  );
}

await Bun.write(
  join(new URL('..', import.meta.url).pathname, 'data', 'summary.json'),
  `${JSON.stringify(
    {
      network: config.chainName,
      completedAt: new Date().toISOString(),
      packages: hashes,
      deposit: DEPOSIT.toString(),
      allocations: decisions.map((decision) => ({
        ...decision,
        amountAtomic: decision.amountAtomic.toString(),
      })),
      totalRepaid: totalRepay.toString(),
      reportsSold: reports.length,
    },
    null,
    2,
  )}\n`,
);

console.log('\nDemo complete — full run recorded in data/run.json');
server.stop();
process.exit(0);
