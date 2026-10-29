import path from "node:path";


/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow overriding the build output directory via env so production
  // builds inside sandboxes (where the default .next may be locked) work.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  outputFileTracingIncludes: {
    "/api/**/*": ["./app-data/**/*"],
  },
  turbopack: {
    root: path.resolve(process.cwd()),
  },
};


export default nextConfig;
