import type { NextConfig } from "next";

// Where Roof Measure (public/tools/roof-measure) is published. Its permit
// index (~42 MB of JSON, refreshed by the harvest in the desktop app) is read
// from there instead of being copied into this repo, so one upload keeps both
// copies current.
const ROOF_MEASURE_SITE =
  process.env.ROOF_MEASURE_SITE || "https://musab-creator.github.io/roof-measure";

const nextConfig: NextConfig = {
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [
        {
          source: "/tools/roof-measure/permits/:path*",
          destination: `${ROOF_MEASURE_SITE}/permits/:path*`,
        },
        {
          source: "/roof-measure-data/permits/:path*",
          destination: `${ROOF_MEASURE_SITE}/permits/:path*`,
        },
      ],
    };
  },
};

export default nextConfig;
