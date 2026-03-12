import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: false,
  // Resolve workspace root for monorepo (silences lockfile warning)
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // In dev only: proxy /api to backend (rewrites don't apply to static export)
  async rewrites() {
    return [
      { source: '/api/:path*', destination: 'http://localhost:3848/api/:path*' },
    ];
  },
};

export default nextConfig;
