/** @type {import('next').NextConfig} */
const nextConfig = {
  // TypeScript 7 validation is an explicit, required workspace task.
  // `pnpm typecheck` remains the required, authoritative TS7 validation.
  typescript: {
    ignoreBuildErrors: true,
  },
};

module.exports = nextConfig;
