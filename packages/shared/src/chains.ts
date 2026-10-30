import { defineChain, type Chain } from 'viem';

/**
 * Robinhood Chain network parameters as published at the time of writing
 * (an Arbitrum Orbit L2, ETH gas). Every value is overridable by environment
 * variables and MUST be re-checked against the official Robinhood Chain
 * documentation before a deployment — never rely on these defaults blindly.
 */
export const ROBINHOOD_MAINNET_ID = 4663;
export const ROBINHOOD_TESTNET_ID = 46630;

export const robinhoodChain = defineChain({
  id: ROBINHOOD_MAINNET_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export const robinhoodChainTestnet = defineChain({
  id: ROBINHOOD_TESTNET_ID,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
});

export const localAnvil = defineChain({
  id: 31337,
  name: 'Local Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
  testnet: true,
});

/** Build the chain object from explicit parameters (env), falling back to the known defaults for its id. */
export function resolveChain(params: { id: number; name?: string; rpcUrl?: string; explorerUrl?: string }): Chain {
  const known = [robinhoodChain, robinhoodChainTestnet, localAnvil].find((c) => c.id === params.id);
  const rpc = params.rpcUrl || known?.rpcUrls.default.http[0];
  if (!rpc) throw new Error(`No RPC URL configured for chain ${params.id}`);
  const explorer = params.explorerUrl || known?.blockExplorers?.default.url;
  return defineChain({
    id: params.id,
    name: params.name || known?.name || `Chain ${params.id}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    ...(explorer ? { blockExplorers: { default: { name: 'Explorer', url: explorer } } } : {}),
    testnet: params.id !== ROBINHOOD_MAINNET_ID,
  });
}
