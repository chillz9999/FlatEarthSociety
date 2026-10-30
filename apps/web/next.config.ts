import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@fes/game-core', '@fes/shared'],
  poweredByHeader: false,
  // Do not generate AGENTS.md in the app directory.
  agentRules: false,
  devIndicators: false,
  // The game is the home page; older addresses lead to where their content lives now.
  async redirects() {
    return [
      { source: '/test', destination: '/', permanent: false },
      { source: '/prizes', destination: '/leaderboard', permanent: false },
      { source: '/treasury', destination: '/leaderboard', permanent: false },
      { source: '/hall', destination: '/leaderboard', permanent: false },
    ];
  },
};

export default nextConfig;
