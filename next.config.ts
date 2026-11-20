import type { NextConfig } from "next";

const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing in the app uses these; embedded players get no access either.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  // Clickjacking guard. CSP `frame-ancestors 'none'` is ignored while
  // the policy is Report-Only, so this legacy header does the enforcing
  // (no page — share links included — is meant to be embedded).
  { key: "X-Frame-Options", value: "DENY" },
  // HSTS only in production builds. Browsers ignore it on plain-http
  // responses (RFC 6797 §8.1), so `bun run start` on http://localhost is
  // unaffected; it takes effect once the deploy is served over https.
  // No `includeSubDomains`/`preload`: sibling subdomains may not be https.
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
    : []),
];

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
  // The app never renders `next/image` (plain `<img>` everywhere), so the
  // `/_next/image` optimizer endpoint is dead weight. Disabling it is
  // defense-in-depth against Image Optimization advisories (SSRF, AVIF/SVG
  // RCE) — there's no reason to expose that attack surface.
  images: { unoptimized: true },
  // Allow the dev server to be hit from LAN IPs (e.g. for testing on a
  // phone on the same Wi-Fi). Without this, Next.js 16+ warns about
  // cross-origin requests to `/_next/*` and will eventually block them.
  // Add specific IPs as needed; `*` is broad but fine for dev.
  allowedDevOrigins: ["*"],
  // Static security headers for every response (pages, API, assets).
  // The per-request Content-Security-Policy (needs a nonce) is set in
  // `proxy.ts`; see docs/SECURITY.md.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
      // The sandbox frame shell is framed by app pages (live artifacts,
      // MCP apps), so it can't be DENY; a later entry overrides the
      // same key. Its CSP `frame-ancestors 'self'` is the real guard —
      // see `app/sandbox/frame/route.ts`.
      {
        source: "/sandbox/frame",
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
    ];
  },
};

export default nextConfig;
