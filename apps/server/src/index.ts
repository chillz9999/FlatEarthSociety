import { existsSync } from 'node:fs';
import { loadConfig } from './config';
import { createServer, createServices, startJobs } from './container';
import { ViemChainGateway } from './chain/viem-gateway';

async function main() {
  // Load .env if present (real environment variables take precedence).
  if (existsSync('.env')) process.loadEnvFile('.env');
  const cfg = loadConfig();
  const services = await createServices(cfg);
  if (services.chain instanceof ViemChainGateway) await services.chain.assertChain();
  const app = await createServer(cfg, services);
  const stopJobs = startJobs(cfg, services, (msg, err) => app.log.error({ err }, msg));
  const shutdown = async () => {
    stopJobs();
    await app.close();
    await services.db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  app.log.info(
    `The Society is open on :${cfg.PORT} — chain ${services.chain.enabled ? `${services.chain.chainId} (entry ${services.chain.entryContract})` : 'disabled'}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
