import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse v2 wraps pdfjs-dist, which dynamically imports its worker
  // (`pdf.worker.mjs`) relative to its own package location at runtime.
  // Bundling those modules through Turbopack breaks the worker resolution
  // ("Setting up fake worker failed: Cannot find module …pdf.worker.mjs").
  // Marking them server-external makes Node resolve them from node_modules
  // directly, which lets the worker discovery succeed.
  //
  // `mammoth` also reaches for its own files at runtime; same fix.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "mammoth"],
  // Allow the dev server to be hit from LAN IPs (e.g. for testing on a
  // phone on the same Wi-Fi). Without this, Next.js 16+ warns about
  // cross-origin requests to `/_next/*` and will eventually block them.
  // Add specific IPs as needed; `*` is broad but fine for dev.
  allowedDevOrigins: ["*"],
};

export default nextConfig;
