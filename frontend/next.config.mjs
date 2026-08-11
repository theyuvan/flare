/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // snarkjs and its deps are CommonJS — keep them out of the server bundle so
  // the dynamic imports in lib/prove-browser.ts resolve in the browser only.
  serverExternalPackages: ['snarkjs', 'circomlibjs', 'ffjavascript'],
}

export default nextConfig
