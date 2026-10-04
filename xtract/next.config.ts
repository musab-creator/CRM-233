import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The sample report embeds this aerial at request time; make sure
  // serverless bundles (e.g. Vercel) ship it alongside every route.
  outputFileTracingIncludes: {
    "/**": ["./public/sample-aerial.jpg"],
  },
};

export default nextConfig;
