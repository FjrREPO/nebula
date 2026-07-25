import { HttpHandler, PublicKey, PurseIdentifier, RpcClient } from 'casper-js-sdk';

import type { ChainConfig } from './config';

/** Result of a finalized on-chain execution. */
export interface ExecutionResult {
  transactionHash: string;
  costMotes: bigint;
}

/** RPC client against the CSPR.cloud node proxy (raw token auth). */
export function createRpcClient(config: ChainConfig): RpcClient {
  const handler = new HttpHandler(config.nodeRpc);
  handler.setCustomHeaders({ Authorization: config.cloudApiKey });
  return new RpcClient(handler);
}

/**
 * Poll until a transaction has executed, then verify it actually succeeded.
 * A failed execution still burns gas, so a missing error message — not the
 * mere presence of the transaction — is the success signal.
 */
export async function waitForExecution(
  rpc: RpcClient,
  transactionHash: string,
  { tries = 48, intervalMs = 5_000 }: { tries?: number; intervalMs?: number } = {},
): Promise<ExecutionResult> {
  for (let attempt = 0; attempt < tries; attempt++) {
    await Bun.sleep(intervalMs);
    let info: Awaited<ReturnType<RpcClient['getTransactionByTransactionHash']>>;
    try {
      info = await rpc.getTransactionByTransactionHash(transactionHash);
    } catch {
      continue; // Not yet known to the node.
    }
    const result = info?.executionInfo?.executionResult;
    if (!result) {
      continue; // Known but not yet executed.
    }
    const errorMessage = result.errorMessage ?? '';
    if (errorMessage !== '') {
      throw new Error(`Transaction ${transactionHash} failed on-chain: ${errorMessage}`);
    }
    return {
      transactionHash,
      costMotes: BigInt(result.cost?.toString() ?? '0'),
    };
  }
  throw new Error(`Transaction ${transactionHash} not executed after ${tries} polls`);
}

/** Liquid balance of an account's main purse, in motes. */
export async function getBalanceMotes(rpc: RpcClient, publicKeyHex: string): Promise<bigint> {
  const publicKey = PublicKey.fromHex(publicKeyHex);
  const balance = await rpc.queryLatestBalance(PurseIdentifier.fromPublicKey(publicKey));
  return BigInt(balance.balance.toString());
}

/** Explorer URL for a transaction on the configured network. */
export function explorerTxUrl(chainName: string, transactionHash: string): string {
  const host = chainName === 'casper' ? 'cspr.live' : 'testnet.cspr.live';
  return `https://${host}/transaction/${transactionHash}`;
}
