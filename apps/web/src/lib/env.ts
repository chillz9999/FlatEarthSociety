import { resolveChain } from '@fes/shared';

/** Public build-time configuration. Contract addresses come from the API (/api/config), not from here. */
export const ENV = {
  apiUrl: (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, ''),
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID || 46630),
  chainName: process.env.NEXT_PUBLIC_CHAIN_NAME || undefined,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || undefined,
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL || undefined,
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || undefined,
};

export const CHAIN = resolveChain({ id: ENV.chainId, name: ENV.chainName, rpcUrl: ENV.rpcUrl, explorerUrl: ENV.explorerUrl });
export const EXPLORER_URL = CHAIN.blockExplorers?.default.url;
