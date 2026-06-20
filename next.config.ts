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
  //
  // `microsandbox` ships a native NAPI binding (native/index.cjs) that
  // Turbopack can't place in an ESM chunk ("asset is not placeable in
  // ESM chunks"). Server-external makes Node require it from node_modules
  // at runtime. It's only reached behind the env-gated runCode skill.
  //
  // `pdf-to-img` renders PDF pages to PNG for the vision extraction path
  // (`@/server/extraction/vision`). It depends on `@napi-rs/canvas`, a
  // native NAPI binding Turbopack can't place in an ESM chunk — same
  // class of issue as `microsandbox`. Server-external makes Node require
  // it from node_modules at runtime. Only reached behind the
  // vision-capable-model gate.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "mammoth", "microsandbox", "pdf-to-img"],
  // Allow the dev server to be hit from LAN IPs (e.g. for testing on a
  // phone on the same Wi-Fi). Without this, Next.js 16+ warns about
  // cross-origin requests to `/_next/*` and will eventually block them.
  // Add specific IPs as needed; `*` is broad but fine for dev.
  allowedDevOrigins: ["*"],
};

export default nextConfig;
