/**
 * Deploy the Nebula protocol to Casper Testnet.
 *
 *   bun run scripts/deploy.ts [ContractName ...]
 *
 * Contracts install in dependency order (NebulaUsd, IdentityRegistry,
 * OracleHub, ComplianceEngine, NebulaVault); pass names to (re)deploy a
 * subset. Package hashes are read back from the deployer's named keys and
 * written to deployments/testnet.json.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { CLValue } from 'casper-js-sdk';

import {
  accountKey,
  actorFromEnv,
  chainConfigFromEnv,
  contractKey,
  createRpcClient,
  explorerTxUrl,
  getBalanceMotes,
  installContract,
  lowerWasmToMvp,
  readPackageHashes,
  signerFromEnv,
} from '@nebula/plugin-onchain';

const ROOT = new URL('..', import.meta.url).pathname;
const WASM_DIR = join(ROOT, 'contracts', 'wasm');
const OUT_DIR = join(ROOT, 'deployments');
/** Named-key prefix for every Nebula contract package. */
const PREFIX = 'nebula_';

interface ContractPlan {
  name: string;
  keyName: string;
  paymentCspr: bigint;
  initArgs?: (hashes: Record<string, string>) => Record<string, CLValue>;
}

const PLAN: ContractPlan[] = [
  { name: 'NebulaUsd', keyName: 'nebula_nusd', paymentCspr: 500n },
  { name: 'IdentityRegistry', keyName: 'nebula_identity', paymentCspr: 500n },
  {
    name: 'OracleHub',
    keyName: 'nebula_oracle_hub',
    paymentCspr: 500n,
    initArgs: (hashes) => ({
      identity_registry: contractKey(required(hashes, 'nebula_identity')),
    }),
  },
  {
    name: 'ComplianceEngine',
    keyName: 'nebula_compliance',
    paymentCspr: 500n,
    initArgs: (hashes) => ({
      identity_registry: contractKey(required(hashes, 'nebula_identity')),
    }),
  },
  {
    name: 'NebulaVault',
    keyName: 'nebula_vault',
    paymentCspr: 550n,
    initArgs: (hashes) => ({
      nusd: contractKey(required(hashes, 'nebula_nusd')),
      compliance: contractKey(required(hashes, 'nebula_compliance')),
      oracle_hub: contractKey(required(hashes, 'nebula_oracle_hub')),
      manager: accountKey(managerPublicKeyHex()),
      risk_limit: CLValue.newCLUint8(60),
      // 24h freshness window so demo attestations stay valid all day.
      max_attestation_age_ms: CLValue.newCLUint64(86_400_000n),
    }),
  },
];

function required(hashes: Record<string, string>, key: string): string {
  const hash = hashes[key];
  if (!hash) {
    throw new Error(`Package hash for ${key} not found — deploy its contract first`);
  }
  return hash;
}

function managerPublicKeyHex(): string {
  return actorFromEnv('portfolioAgent').publicKey.toHex();
}

async function main() {
  const config = chainConfigFromEnv();
  const rpc = createRpcClient(config);
  const signer = signerFromEnv();
  const deployerHex = signer.publicKey.toHex();

  const balance = await getBalanceMotes(rpc, deployerHex);
  console.log(`Deployer ${deployerHex}`);
  console.log(`Balance  ${Number(balance) / 1e9} CSPR`);

  const only = process.argv.slice(2);
  const selected = only.length > 0 ? PLAN.filter((p) => only.includes(p.name)) : PLAN;
  if (selected.length === 0) {
    throw new Error(`No contracts matched ${only.join(', ')}`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const transactions: Record<string, string> = {};

  for (const plan of selected) {
    const hashes = await readPackageHashes(rpc, deployerHex, PREFIX);
    const wasmPath = lowerWasmToMvp(join(WASM_DIR, `${plan.name}.wasm`), OUT_DIR);
    console.log(`\nInstalling ${plan.name} (${plan.paymentCspr} CSPR)...`);
    const txHash = await installContract({
      rpc,
      signer,
      chainName: config.chainName,
      wasmPath,
      packageHashKeyName: plan.keyName,
      initArgs: plan.initArgs?.(hashes),
      paymentCspr: plan.paymentCspr,
    });
    transactions[plan.name] = txHash;
    console.log(`  ${explorerTxUrl(config.chainName, txHash)}`);
  }

  const allHashes = await readPackageHashes(rpc, deployerHex, PREFIX);
  const ourKeys = new Set(PLAN.map((plan) => plan.keyName));
  const hashes = Object.fromEntries(
    Object.entries(allHashes).filter(([name]) => ourKeys.has(name)),
  );
  const record = {
    network: config.chainName,
    deployer: deployerHex,
    updatedAt: new Date().toISOString(),
    packages: hashes,
    installTransactions: transactions,
  };
  await Bun.write(join(OUT_DIR, 'testnet.json'), `${JSON.stringify(record, null, 2)}\n`);

  console.log('\nPackage hashes:');
  for (const [name, hash] of Object.entries(hashes)) {
    console.log(`  ${name}: ${hash}`);
  }
  console.log(`\nWritten to deployments/testnet.json`);
}

await main();
