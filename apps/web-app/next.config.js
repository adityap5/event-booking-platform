/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@event-booking/shared",
    "@event-booking/trpc",
  ],
};

export default nextConfig;
