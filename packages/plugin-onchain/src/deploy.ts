import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  AccountIdentifier,
  Args,
  CLValue,
  PrivateKey,
  PublicKey,
  RpcClient,
  SessionBuilder,
} from 'casper-js-sdk';

import { waitForExecution } from './client';

const MOTES_PER_CSPR = 1_000_000_000n;

/**
 * Lower a wasm artifact to the MVP feature set Casper's VM accepts.
 * Rust nightly emits post-MVP opcodes (bulk-memory, sign-ext) even with the
 * crate-level rustflags, because the linked sysroot is prebuilt — wasm-opt's
 * lowering passes do the final conversion. Falls back to the raw artifact if
 * wasm-opt is unavailable.
 */
export function lowerWasmToMvp(wasmPath: string, outDir: string): string {
  const lowered = join(outDir, `${basename(wasmPath, '.wasm')}-mvp.wasm`);
  const result = Bun.spawnSync([
    'wasm-opt',
    wasmPath,
    '--enable-bulk-memory',
    '--enable-sign-ext',
    '--signext-lowering',
    '--llvm-memory-copy-fill-lowering',
    '--memory-packing',
    '-O2',
    '-o',
    lowered,
  ]);
  if (result.exitCode !== 0 || !existsSync(lowered)) {
    console.warn(`wasm-opt lowering failed for ${wasmPath}; deploying raw artifact`);
    return wasmPath;
  }
  return lowered;
}

export interface InstallOptions {
  rpc: RpcClient;
  signer: PrivateKey;
  chainName: string;
  wasmPath: string;
  /** Named key under which Odra stores the package hash, e.g. `nebula_vault`. */
  packageHashKeyName: string;
  /** Contract `init` args, merged with the `odra_cfg_*` install args. */
  initArgs?: Record<string, CLValue>;
  paymentCspr: bigint;
  upgrade?: boolean;
}

/** Install (or upgrade) an Odra contract and wait for execution. */
export async function installContract(options: InstallOptions): Promise<string> {
  const wasm = await Bun.file(options.wasmPath).bytes();
  const args = Args.fromMap({
    odra_cfg_package_hash_key_name: CLValue.newCLString(options.packageHashKeyName),
    odra_cfg_allow_key_override: CLValue.newCLValueBool(true),
    odra_cfg_is_upgradable: CLValue.newCLValueBool(true),
    odra_cfg_is_upgrade: CLValue.newCLValueBool(options.upgrade ?? false),
    ...options.initArgs,
  });

  const transaction = new SessionBuilder()
    .from(options.signer.publicKey)
    .chainName(options.chainName)
    .wasm(wasm)
    .installOrUpgrade()
    .runtimeArgs(args)
    .payment(Number(options.paymentCspr * MOTES_PER_CSPR))
    .build();
  transaction.sign(options.signer);

  await options.rpc.putTransaction(transaction);
  const hash = transaction.hash.toHex();
  await waitForExecution(options.rpc, hash);
  return hash;
}

/**
 * Read `hash-…` package hashes back from the deployer account's named keys,
 * filtered by prefix (e.g. `nebula_`).
 */
export async function readPackageHashes(
  rpc: RpcClient,
  publicKeyHex: string,
  prefix: string,
): Promise<Record<string, string>> {
  const identifier = new AccountIdentifier(undefined, PublicKey.fromHex(publicKeyHex));
  const account = await rpc.getAccountInfo(null, identifier);
  const hashes: Record<string, string> = {};
  const namedKeys = account?.account?.namedKeys ?? [];
  for (const namedKey of namedKeys) {
    const name: string = namedKey.name ?? '';
    if (!name.startsWith(prefix)) {
      continue;
    }
    const key = namedKey.key?.toString() ?? '';
    const match = key.match(/(?:hash-|contract-package-)([0-9a-f]{64})/);
    if (match) {
      hashes[name] = `hash-${match[1]}`;
    }
  }
  return hashes;
}
