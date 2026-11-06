import type { NextConfig } from 'next';
// /api is forwarded at request time by app/api/[...path]/route.ts. This also
// works when Render supplies the private API hostname only at runtime.
const nextConfig:NextConfig={output:'standalone',reactStrictMode:true,poweredByHeader:false};
export default nextConfig;
