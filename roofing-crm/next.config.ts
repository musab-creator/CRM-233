import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Shingle color renders used by /visualizer. Run `npm run fetch:roof-images`
    // to vendor them into public/roof-colors and this entry becomes unnecessary.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "d8j0ntlcm91z4.cloudfront.net",
        pathname: "/user_3HPXNchsr6yo6j5Wl0pyjFwASXk/**",
      },
    ],
  },
};

export default nextConfig;
