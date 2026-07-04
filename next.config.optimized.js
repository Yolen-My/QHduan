/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['192.168.71.33'],
  
  // 生产环境优化
  compress: true,
  
  // 图片优化
  images: {
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  },
  
  // 启用 SWC 压缩
  swcMinify: true,
  
  // 实验性功能
  experimental: {
    optimizeCss: true,
  },
  
  // 输出配置
  output: 'standalone',
  
  // 环境变量
  env: {
    // 根据环境动态设置轮询间隔
    NEXT_PUBLIC_POLLING_INTERVAL: process.env.NODE_ENV === 'production' ? '2000' : '500',
  },
};

module.exports = nextConfig;