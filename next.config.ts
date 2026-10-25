import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Profile pictures are uploaded through a Server Action (uploadMyAvatar): 2 MB plus room for the
      // multipart overhead. Everything else stays well under the 1 MB default.
      bodySizeLimit: "3mb",
    },
  },
};

export default nextConfig;
