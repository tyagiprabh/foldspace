/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This app lives inside a folder that has lockfiles above it; pin the root so
  // Next does not infer the home directory as the workspace.
  outputFileTracingRoot: import.meta.dirname,
  // The floating dev badge sits on top of the legend.
  devIndicators: false,
}

export default nextConfig
