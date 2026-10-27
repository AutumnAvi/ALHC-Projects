import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Profile pictures are uploaded through a Server Action (uploadMyAvatar): 2 MB plus room for the
      // multipart overhead. Everything else stays well under the 1 MB default.
      bodySizeLimit: "3mb",
    },
  },
  // Oct 27 notes (batch 5): review check emails draw thumbnails on the server (src/lib/review-thumbnails.ts)
  // with @napi-rs/canvas (a native module) and pdf.js's Node build. Both are loaded with Node's own require /
  // import instead of being bundled, and pdf.js's built-in font data (PDFs that don't embed Helvetica and
  // friends) ships with every server function.
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  outputFileTracingIncludes: {
    "/*": ["node_modules/pdfjs-dist/standard_fonts/**/*"],
  },
};

export default nextConfig;
