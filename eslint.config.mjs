import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Folder-fence convention (see docs/PLAN-client-server-fences.md), under apps/web:
//   lib/client/**  browser-only  — must not import @/server/*
//   lib/server/**  node-only     — must not import @/client/*
//   lib/shared/**  isomorphic    — must not import @/client/* or @/server/*
// The `server-only` / `client-only` packages enforce the same boundary at
// build time; this rule catches mistakes earlier (in the editor / `bun lint`).
const restrictServerInClient = {
  patterns: [
    { group: ["@/server/*"], message: "Client code cannot import server-only modules. Move shared code to @/shared/* or call agent-py through the API client." },
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
  // The Next app lives in apps/web (wave 14); this one config also lints the
  // root's scripts/, e2e-live/ and packages/.
  { settings: { next: { rootDir: "apps/web/" } } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/next-env.d.ts",
    // Playwright e2e build (`NEXT_DIST_DIR`, playwright.config.ts) + outputs.
    "**/.next-e2e/**",
    "**/.next-e2e-wire/**",
    "**/test-results/**",
    // Agent worktrees (each has its own checkout, build and lint).
    ".claude/**",
    "**/playwright-report/**",
  ]),

  // ---------------------------------------------------------------------
  // Vendor code — shadcn-generated primitives under components/ui/* and
  // Plate.js example/wrapper code under components/editor/*. These files
  // are regenerable / upstream-derived; we don't want to maintain
  // hand-edits against the upstream sources. Turn off the noisy rules
  // for these paths only.
  // ---------------------------------------------------------------------
  {
    files: ["apps/web/components/ui/**/*.{ts,tsx}", "apps/web/components/editor/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "react/display-name": "off",
      "react/no-unescaped-entities": "off",
      // React Compiler ruleset is strict and over-flags vendor code that
      // upstream maintainers haven't (yet) reworked for compiler-friendly
      // patterns. Disable the strict family wholesale for vendor paths.
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/refs": "off",
      "react-hooks/use-memo": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/component-hook-factories": "off",
      "react-hooks/error-boundaries": "off",
      "react-hooks/unsupported-syntax": "off",
      "react-hooks/static-components": "off",
      "react-hooks/globals": "off",
      "react-hooks/immutability": "off",
      "react-hooks/incompatible-library": "off",
      "@next/next/no-img-element": "off",
    },
  },

  // ---------------------------------------------------------------------
  // The React Compiler `set-state-in-effect` rule is part of an
  // experimental ruleset and over-flags legitimate patterns React's own
  // docs endorse (subscribing to external systems like matchMedia,
  // initial "mounted" sentinels, etc.). The codebase has many such
  // cases; turning the rule off project-wide is the pragmatic call.
  // Revisit once the rule's heuristics improve.
  // ---------------------------------------------------------------------
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // Note: apps/web/app/**/page.tsx and app/**/layout.tsx are intentionally excluded —
  // they default to server components in Next.js App Router and are allowed
  // to import @/server/*. Mark a page "use client" only when needed.
  {
    files: ["apps/web/lib/client/**/*.{ts,tsx}", "apps/web/components/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", restrictServerInClient] },
  },
  {
    // What is left of Next's server (wave 13): the CSP builders, the
    // proxy that applies them and the sandbox frame shell route.
    files: ["apps/web/lib/server/**/*.{ts,tsx}", "apps/web/app/**/route.ts", "apps/web/proxy.ts"],
    rules: { "no-restricted-imports": ["error", restrictClientInServer] },
  },
  {
    files: ["apps/web/lib/shared/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", restrictBothInShared] },
  },
]);

export default eslintConfig;
