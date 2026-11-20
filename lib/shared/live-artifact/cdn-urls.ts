/**
 * Pinned CDN versions for the live-artifact iframe shells. Listed in
 * one place so version bumps are a single-file PR and `iframe-shell.ts`
 * stays focused on the templating logic.
 *
 * Lives in `shared/` because two policies consume `CDN_HOSTS`: the
 * `<meta>` CSP that `iframe-shell.ts` (client) writes into each shell,
 * and the response CSP of the `/sandbox/frame` shell document
 * (`lib/server/security/sandbox-frame.ts`).
 */

export const CDN_URLS = {
  /** React 19 UMD development build. Development build is intentional —
   *  the dev warnings + better error messages are valuable when the
   *  model emits broken JSX. The user-visible cost is ~30 KB extra. */
  react: "https://unpkg.com/react@19/umd/react.development.js",
  reactDom: "https://unpkg.com/react-dom@19/umd/react-dom.development.js",
  /** Babel standalone — needed to transpile TSX in the browser. ~3 MB
   *  uncompressed but browser-cached after first load, which makes the
   *  second preview in the same session feel instant. */
  babel: "https://unpkg.com/@babel/standalone@7.25.6/babel.min.js",
  /** Tailwind via CDN — the JIT runtime. Generates only the classes
   *  used in the artifact, so the actual emitted CSS is small. */
  tailwind: "https://cdn.tailwindcss.com",
  /** Mermaid v10.x — pinned to a known-good minor to avoid the v11
   *  breaking changes. Bump deliberately after re-testing the diagrams
   *  the bundled examples render. */
  mermaid: "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js",
} as const

/** Hostnames the iframe's CSPs allow scripts / styles from. Every
 *  `CDN_URLS` entry must be served from one of these (the shell-policy
 *  test checks it). */
export const CDN_HOSTS = [
  "https://unpkg.com",
  "https://cdn.tailwindcss.com",
  "https://cdn.jsdelivr.net",
] as const
