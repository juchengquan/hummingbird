import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Folder-fence convention (see docs/PLAN-client-server-fences.md):
//   lib/client/**  browser-only  — must not import @/server/*
//   lib/server/**  node-only     — must not import @/client/*
//   lib/shared/**  isomorphic    — must not import @/client/* or @/server/*
// The `server-only` / `client-only` packages enforce the same boundary at
// build time; this rule catches mistakes earlier (in the editor / `bun lint`).
const restrictServerInClient = {
  patterns: [
    { group: ["@/server/*"], message: "Client code cannot import server-only modules. Move shared code to @/shared/* or call it via an API route." },
  ],
};

const restrictClientInServer = {
  patterns: [
    { group: ["@/client/*"], message: "Server code cannot import client-only modules. Move shared code to @/shared/*." },
  ],
};

const restrictBothInShared = {
  patterns: [
    { group: ["@/client/*"], message: "Shared code must stay isomorphic — no @/client/* imports." },
    { group: ["@/server/*"], message: "Shared code must stay isomorphic — no @/server/* imports." },
  ],
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Note: app/**/page.tsx and app/**/layout.tsx are intentionally excluded —
  // they default to server components in Next.js App Router and are allowed
  // to import @/server/*. Mark a page "use client" only when needed.
  {
    files: ["lib/client/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", restrictServerInClient] },
  },
  {
    files: ["lib/server/**/*.{ts,tsx}", "app/api/**/*.{ts,tsx}", "app/auth/**/route.ts"],
    rules: { "no-restricted-imports": ["error", restrictClientInServer] },
  },
  {
    files: ["lib/shared/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", restrictBothInShared] },
  },
]);

export default eslintConfig;
