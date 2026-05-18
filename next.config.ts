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
};

export default nextConfig;
