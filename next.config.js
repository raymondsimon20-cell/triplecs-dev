/** @type {import('next').NextConfig} */
const nextConfig = {
  // Netlify handles routing, no need for standalone output
  output: undefined,
  experimental: {
    serverComponentsExternalPackages: ['@netlify/blobs'],
  },
};

module.exports = nextConfig;
