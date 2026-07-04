/** @type {import('next').NextConfig} */
const buildId = process.env.NEXT_PUBLIC_BUILD_ID || `qhduan-${Date.now()}`;

const nextConfig = {
  allowedDevOrigins: ['192.168.71.33'],
  generateBuildId: async () => buildId,
  async rewrites() {
    return [
      {
        source: '/pb/:path*',
        destination: 'http://127.0.0.1:8090/:path*',
      },
    ];
  },
};

module.exports = nextConfig;
