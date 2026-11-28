/**
 * Pinned CDN scripts for the live-artifact iframe shells. Listed in
 * one place so version bumps are a single-file PR and `iframe-shell.ts`
 * stays focused on the templating logic.
 *
 * Every entry is an exact version (no ranges, no "latest" redirects),
 * and carries an SRI hash whenever the host sends
 * `Access-Control-Allow-Origin` — the shells are opaque-origin frames,
 * so an `integrity` check needs a CORS response. To bump one: change
 * the URL, then recompute the hash from the exact bytes it serves:
 *
 *   curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A
 *
 * Lives in `shared/` because two policies consume `CDN_HOSTS`: the
 * `<meta>` CSP that `iframe-shell.ts` (client) writes into each shell,
 * and the response CSP of the `/sandbox/frame` shell document
 * (`lib/server/security/sandbox-frame.ts`).
 */

export interface CdnScript {
  src: string
  /** `sha384-…` SRI hash, or null when the host doesn't send CORS
   *  headers (an integrity check on a no-cors response always fails). */
  integrity: string | null
}

export const CDN_SCRIPTS = {
  /** React 18.3.1 UMD development build. React 19 stopped publishing
   *  UMD builds (`react@19/umd/*` is a 404), and the TSX shell needs
   *  `React` / `ReactDOM` as globals, so 18.3.1 — the last UMD
   *  release — it is. Development build is intentional: the dev
   *  warnings + better error messages are valuable when the model
   *  emits broken JSX. */
  react: {
    src: "https://unpkg.com/react@18.3.1/umd/react.development.js",
    integrity: "sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L",
  },
  reactDom: {
    src: "https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js",
    integrity: "sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm",
  },
  /** Babel standalone — compiles the TSX artifact in the browser
   *  (TypeScript + React presets, ES modules → CommonJS). ~3 MB
   *  uncompressed but browser-cached after first load, which makes the
   *  second preview in the same session feel instant. */
  babel: {
    src: "https://unpkg.com/@babel/standalone@7.25.6/babel.min.js",
    integrity: "sha384-EIcs2MbARRLcLs7Gv2wqqhhfMlcLeW9yuJsWki1r5iveN1F5gpzHOwAKycJqSQOI",
  },
  /** Tailwind v3 Play CDN — the JIT runtime, which generates only the
   *  classes the artifact uses. Pinned to the version path (the bare
   *  host is a redirect to whatever is current). No SRI: the host sends
   *  no CORS headers. */
  tailwind: {
    src: "https://cdn.tailwindcss.com/3.4.17",
    integrity: null,
  },
  /** Mermaid v10.x — pinned to a known-good minor to avoid the v11
   *  breaking changes. Bump deliberately after re-testing the diagrams
   *  the bundled examples render. */
  mermaid: {
    src: "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js",
    integrity: "sha384-WmdflGW9aGfoBdHc4rRyWzYuAjEmDwMdGdiPNacbwfGKxBW/SO6guzuQ76qjnSlr",
  },
} as const satisfies Record<string, CdnScript>

export type CdnScriptName = keyof typeof CDN_SCRIPTS

/** Hostnames the iframe's CSPs allow scripts / styles from — exactly
 *  the origins `CDN_SCRIPTS` loads from, no more (the shell-policy test
 *  checks both directions). Model-written full HTML documents may load
 *  from these same hosts. */
export const CDN_HOSTS = [
  "https://unpkg.com",
  "https://cdn.tailwindcss.com",
  "https://cdn.jsdelivr.net",
] as const
