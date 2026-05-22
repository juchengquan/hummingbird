/**
 * Pinned CDN versions for the live-artifact iframe shells. Listed in
 * one place so version bumps are a single-file PR and `iframe-shell.ts`
 * stays focused on the templating logic.
 *
 * The hosts here also have to appear in the CSP `script-src` and
 * `style-src` directives in `iframe-shell.ts`. Keep them in sync.
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

/** Hostnames the iframe's CSP allows scripts / styles from. Derived
 *  from `CDN_URLS` so the CSP and the actual `<script src>` tags can't
 *  drift. */
export const CDN_HOSTS = [
  "https://unpkg.com",
  "https://cdn.tailwindcss.com",
  "https://cdn.jsdelivr.net",
] as const
