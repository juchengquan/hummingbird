#!/usr/bin/env bun
/**
 * Next's code reads no server secret (PLAN-frontend-backend-split Q133 /
 * Q143): every `process.env` read in the Next app names `CSP_MODE`,
 * `NODE_ENV`, `NEXT_RUNTIME`, `NEXT_DIST_DIR` or a `NEXT_PUBLIC_*`
 * variable. Everything else (model keys, the service-role key,
 * `MCP_ENCRYPTION_KEY`, `CODE_SANDBOX_*`, …) belongs to agent-py.
 *
 * Scans `app/`, `lib/`, `components/`, `proxy.ts`, `next.config.ts` and
 * the `instrumentation*` files, test files (`*.test.*`) excluded. Reads
 * are found on the syntax tree, so comments and strings never count. A
 * read the check can't name fails too: `process.env[expr]` (dynamic) and
 * `process.env` taken whole (passed along, destructured) — spell each
 * variable out instead.
 *
 *   bun scripts/check-next-env.ts     # exit 1 on any violation
 *
 * Wired into `bun run audit:bundle` (CI), and its unit test checks this
 * repo in `bun run test`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

import ts from "typescript"

export const ALLOWED_ENV_NAMES: readonly string[] = ["CSP_MODE", "NODE_ENV", "NEXT_RUNTIME", "NEXT_DIST_DIR"]

/** Next's own code: what `next build` compiles into the server or the client. */
export const NEXT_TARGETS: readonly string[] = [
  "app",
  "lib",
  "components",
  "proxy.ts",
  "next.config.ts",
  "instrumentation.ts",
  "instrumentation-client.ts",
]

const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/
const SKIP_DIRS = new Set(["node_modules", ".next"])

export function isAllowedEnvName(name: string): boolean {
  return ALLOWED_ENV_NAMES.includes(name) || /^NEXT_PUBLIC_[A-Z0-9_]+$/.test(name)
}

export type EnvViolation =
  | { file: string; line: number; kind: "forbidden"; name: string }
  | { file: string; line: number; kind: "dynamic" }
  | { file: string; line: number; kind: "whole" }

/** `process.env` itself (also `process?.env`). */
function isProcessEnv(node: ts.Node): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process"
  )
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** Every `process.env` read in `source` whose name isn't allowed. */
export function findEnvViolations(source: string, file: string): EnvViolation[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file))
  const out: EnvViolation[] = []
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

  const visit = (node: ts.Node) => {
    if (isProcessEnv(node)) {
      const parent = node.parent
      const line = lineOf(node)
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        const name = parent.name.text
        if (!isAllowedEnvName(name)) out.push({ file, line, kind: "forbidden", name })
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const arg = parent.argumentExpression
        if (ts.isStringLiteralLike(arg)) {
          if (!isAllowedEnvName(arg.text)) out.push({ file, line, kind: "forbidden", name: arg.text })
        } else {
          out.push({ file, line, kind: "dynamic" })
        }
      } else {
        out.push({ file, line, kind: "whole" })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function collectFiles(path: string, out: string[]): void {
  const st = statSync(path)
  if (st.isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      if (SKIP_DIRS.has(entry)) continue
      collectFiles(join(path, entry), out)
    }
  } else if (SOURCE_EXT.test(path) && !TEST_FILE.test(path) && !path.endsWith(".d.ts")) {
    out.push(path)
  }
}

/** Violations under `root`'s Next targets, paths relative to `root` (posix). */
export function checkNextEnv(root: string, targets: readonly string[] = NEXT_TARGETS): EnvViolation[] {
  const files: string[] = []
  for (const target of targets) {
    const path = join(root, target)
    if (existsSync(path)) collectFiles(path, files)
  }
  return files
    .sort()
    .flatMap((abs) => findEnvViolations(readFileSync(abs, "utf8"), relative(root, abs).split(sep).join("/")))
}

function describe(v: EnvViolation): string {
  if (v.kind === "forbidden") return `reads process.env.${v.name}`
  if (v.kind === "dynamic") return "reads process.env[<expression>] (name the variable)"
  return "takes process.env whole (name each variable)"
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..")
  const violations = checkNextEnv(root)
  if (violations.length > 0) {
    console.error("Next's code may only read CSP_MODE, NODE_ENV, NEXT_RUNTIME, NEXT_DIST_DIR and NEXT_PUBLIC_*:")
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${describe(v)}`)
    process.exit(1)
  }
  console.log("ok: Next's code reads only allowed environment variables")
}
