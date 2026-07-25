/** Chain + service endpoints, resolved once from the environment. */
export interface ChainConfig {
  /** e.g. `casper-test`. */
  chainName: string;
  /** JSON-RPC endpoint (CSPR.cloud node proxy by default). */
  nodeRpc: string;
  /** CSPR.cloud access token, sent raw in the `Authorization` header. */
  cloudApiKey: string;
  /** CSPR.cloud REST API base URL. */
  restUrl: string;
}

/** Deployed contract package hashes (64-hex, no `hash-` prefix). */
export interface ContractHashes {
  nusd: string;
  identity: string;
  oracleHub: string;
  compliance: string;
  vault: string;
}

const DEFAULTS = {
  chainName: 'casper-test',
  nodeRpc: 'https://node.testnet.cspr.cloud/rpc',
  restUrl: 'https://api.testnet.cspr.cloud',
} as const;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === '' ? undefined : value;
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function chainConfigFromEnv(): ChainConfig {
  return {
    chainName: env('CASPER_CHAIN_NAME') ?? DEFAULTS.chainName,
    nodeRpc: env('CASPER_NODE_RPC') ?? DEFAULTS.nodeRpc,
    cloudApiKey: requireEnv('CSPR_CLOUD_API_KEY'),
    restUrl: env('CSPR_CLOUD_REST_URL') ?? DEFAULTS.restUrl,
  };
}

/** Strip an optional `hash-` prefix down to the raw 64-hex package hash. */
export function normalizePackageHash(hash: string): string {
  return hash.replace(/^hash-/, '');
}

export function contractHashesFromEnv(): ContractHashes {
  return {
    nusd: normalizePackageHash(requireEnv('NEBULA_NUSD_PACKAGE_HASH')),
    identity: normalizePackageHash(requireEnv('NEBULA_IDENTITY_PACKAGE_HASH')),
    oracleHub: normalizePackageHash(requireEnv('NEBULA_ORACLE_HUB_PACKAGE_HASH')),
    compliance: normalizePackageHash(requireEnv('NEBULA_COMPLIANCE_PACKAGE_HASH')),
    vault: normalizePackageHash(requireEnv('NEBULA_VAULT_PACKAGE_HASH')),
  };
}
