import type { NextConfig } from "next";

// OSMSEA's UI is a client-rendered dashboard behind Supabase Auth: pages render only after the
// browser session loads and read data through RLS. Cache Components / Partial Prefetching add
// nothing here, so they stay off.
const nextConfig: NextConfig = {
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
