import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  compress: true,
  outputFileTracingExcludes: {
    '/*': ['./next.config.ts'],
  },
};

export default nextConfig;
