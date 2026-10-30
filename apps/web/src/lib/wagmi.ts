import { createConfig, http } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';
import { CHAIN, ENV } from './env';

export const wagmiConfig = createConfig({
  chains: [CHAIN],
  // EIP-6963 discovery surfaces every installed browser wallet; `injected` is the generic fallback.
  multiInjectedProviderDiscovery: true,
  connectors: [
    injected(),
    ...(ENV.walletConnectProjectId
      ? [walletConnect({ projectId: ENV.walletConnectProjectId, showQrModal: true, metadata: { name: 'The Flat Earth Society', description: 'The Society Test', url: 'https://flatearth.society', icons: [] } })]
      : []),
  ],
  transports: { [CHAIN.id]: http(CHAIN.rpcUrls.default.http[0]) },
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
