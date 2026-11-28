import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { checkNextEnv, findEnvViolations, isAllowedEnvName } from "../check-next-env"

const ROOT = join(import.meta.dir, "..", "..")

describe("isAllowedEnvName", () => {
  test("allows the four named variables and every NEXT_PUBLIC_*", () => {
    for (const name of ["CSP_MODE", "NODE_ENV", "NEXT_RUNTIME", "NEXT_DIST_DIR", "NEXT_PUBLIC_AGENT_PY_URL"]) {
      expect(isAllowedEnvName(name)).toBe(true)
    }
  })

  test("refuses server secrets and look-alikes", () => {
    for (const name of [
      "AI_GATEWAY_API_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "MCP_ENCRYPTION_KEY",
      "CODE_SANDBOX_BASE_URL",
      "NEXT_PUBLIC",
      "next_public_x",
      "CSP_MODE_X",
    ]) {
      expect(isAllowedEnvName(name)).toBe(false)
    }
  })
})

describe("findEnvViolations", () => {
  const source = [
    'const a = process.env.NEXT_PUBLIC_AGENT_PY_URL',
    'const b = process.env["CSP_MODE"]',
    "const c = process.env.AI_GATEWAY_API_KEY",
    "const d = process.env['SUPABASE_SERVICE_ROLE_KEY']",
    "const e = process.env?.MCP_ENCRYPTION_KEY",
    "const f = process.env[name]",
    "const { CRON_SECRET } = process.env",
    "// process.env.TAVILY_API_KEY in a comment is not a read",
    'const g = "process.env.ANTHROPIC_API_KEY in a string is not a read"',
    "const h = process.env.NODE_ENV === 'production'",
  ].join("\n")

  test("reports each forbidden, dynamic or whole-env read with its line, and nothing else", () => {
    expect(findEnvViolations(source, "x.ts")).toEqual([
      { file: "x.ts", line: 3, kind: "forbidden", name: "AI_GATEWAY_API_KEY" },
      { file: "x.ts", line: 4, kind: "forbidden", name: "SUPABASE_SERVICE_ROLE_KEY" },
      { file: "x.ts", line: 5, kind: "forbidden", name: "MCP_ENCRYPTION_KEY" },
      { file: "x.ts", line: 6, kind: "dynamic" },
      { file: "x.ts", line: 7, kind: "whole" },
    ])
  })

  test("parses TSX", () => {
    const tsx = "export const C = () => <div>{process.env.OPENROUTER_API_KEY}</div>"
    expect(findEnvViolations(tsx, "c.tsx")).toEqual([
      { file: "c.tsx", line: 1, kind: "forbidden", name: "OPENROUTER_API_KEY" },
    ])
  })

  test("a file with only allowed reads is clean", () => {
    expect(findEnvViolations("export const m = process.env.NEXT_DIST_DIR ?? '.next'", "n.ts")).toEqual([])
  })
})

describe("checkNextEnv over a tree", () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "check-next-env-"))
    mkdirSync(join(dir, "app", "api"), { recursive: true })
    mkdirSync(join(dir, "lib", "client"), { recursive: true })
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true })
    writeFileSync(join(dir, "app", "api", "route.ts"), "export const k = process.env.AI_GATEWAY_API_KEY\n")
    writeFileSync(join(dir, "lib", "client", "ok.ts"), "export const u = process.env.NEXT_PUBLIC_SUPABASE_URL\n")
    // Tests may read anything.
    writeFileSync(join(dir, "lib", "client", "ok.test.ts"), "process.env.SUPABASE_DB_URL\n")
    writeFileSync(join(dir, "proxy.ts"), "export const m = process.env.CSP_MODE\n")
    writeFileSync(join(dir, "next.config.ts"), "export const s = process.env.CRON_SECRET\n")
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "process.env.ANTHROPIC_API_KEY\n")
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("finds forbidden reads in app/, lib/, proxy.ts and next.config.ts, skipping tests", () => {
    expect(checkNextEnv(dir)).toEqual([
      { file: "app/api/route.ts", line: 1, kind: "forbidden", name: "AI_GATEWAY_API_KEY" },
      { file: "next.config.ts", line: 1, kind: "forbidden", name: "CRON_SECRET" },
    ])
  })
})

describe("this repo", () => {
  test("Next's code reads no process.env outside the allowed names", () => {
    expect(checkNextEnv(ROOT)).toEqual([])
  })
})
