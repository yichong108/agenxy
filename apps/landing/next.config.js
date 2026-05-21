/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  distDir: 'dist',
  webpack: (config) => {
    config.module.rules.push({
      test: /\.md$/,
      type: 'asset/source'
    })
    return config
  }
}

export default nextConfig
