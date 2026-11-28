import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isAllowedEnvName } from "../../apps/web/scripts/check-next-env"
import { AGENT_ENV, EnvSplitError, parseEnvEntries, runEnvSplit, WEB_ENV, WEB_ENV_LOCAL } from "../env-split"

const REPO = join(import.meta.dir, "..", "..")

let dir = ""
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ""
})
function checkout(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "env-split-"))
  mkdirSync(join(dir, "apps", "web"), { recursive: true })
  mkdirSync(join(dir, "services", "agent-py"), { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8")

const ROOT_ENV = `# Frontend
NEXT_PUBLIC_AGENT_PY_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_ANON_KEY="anon key"
CSP_MODE=enforce

# agent-py
ANTHROPIC_API_KEY=sk-ant-secret
export SUPABASE_JWT_SECRET='jwt secret'
MCP_ENCRYPTION_KEY="line one
line two"
SUPABASE_URL=http://localhost:54321
`

describe("parseEnvEntries", () => {
  test("keeps each assignment's raw lines, drops comments and blanks", () => {
    const entries = parseEnvEntries(ROOT_ENV)
    expect(entries.map((e) => e.key)).toEqual([
      "NEXT_PUBLIC_AGENT_PY_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "CSP_MODE",
      "ANTHROPIC_API_KEY",
      "SUPABASE_JWT_SECRET",
      "MCP_ENCRYPTION_KEY",
      "SUPABASE_URL",
    ])
    expect(entries[4].lines).toEqual(["export SUPABASE_JWT_SECRET='jwt secret'"])
    expect(entries[5].lines).toEqual(['MCP_ENCRYPTION_KEY="line one', 'line two"'])
  })

  test("an escaped quote doesn't close a value", () => {
    const [e] = parseEnvEntries('A="x \\" y\nmore"\nB=1')
    expect(e.lines).toEqual(['A="x \\" y', 'more"'])
  })
})

describe("runEnvSplit", () => {
  test("web keys to apps/web/.env, the rest to services/agent-py/.env, verbatim", () => {
    const root = checkout({ ".env": ROOT_ENV })
    const report = runEnvSplit(root)
    expect(report.written).toEqual({
      [WEB_ENV]: ["NEXT_PUBLIC_AGENT_PY_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "CSP_MODE"],
      [AGENT_ENV]: ["ANTHROPIC_API_KEY", "SUPABASE_JWT_SECRET", "MCP_ENCRYPTION_KEY", "SUPABASE_URL"],
    })
    const web = read(root, WEB_ENV)
    expect(web).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY="anon key"\n')
    expect(web).not.toContain("sk-ant-secret")
    const agent = read(root, AGENT_ENV)
    expect(agent).toContain('MCP_ENCRYPTION_KEY="line one\nline two"\n')
    expect(agent).toContain("export SUPABASE_JWT_SECRET='jwt secret'\n")
    expect(agent).not.toContain("NEXT_PUBLIC_")
  })

  test("writes the files owner-only", () => {
    const root = checkout({ ".env": ROOT_ENV })
    runEnvSplit(root)
    expect(statSync(join(root, WEB_ENV)).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, AGENT_ENV)).mode & 0o777).toBe(0o600)
  })

  test("the report carries key names only, never a value", () => {
    const root = checkout({ ".env": ROOT_ENV })
    const text = JSON.stringify(runEnvSplit(root))
    for (const secret of ["sk-ant-secret", "jwt secret", "line one", "anon key", "localhost"]) {
      expect(text).not.toContain(secret)
    }
  })

  test(".env.local: web keys to apps/web/.env.local; agent keys skipped (agent-py never read it)", () => {
    const root = checkout({ ".env.local": "NEXT_PUBLIC_AGENT_PY_URL=/\nOPENROUTER_API_KEY=or-secret\n" })
    const report = runEnvSplit(root)
    expect(report.written).toEqual({ [WEB_ENV_LOCAL]: ["NEXT_PUBLIC_AGENT_PY_URL"] })
    expect(report.skipped).toEqual(["OPENROUTER_API_KEY"])
    expect(existsSync(join(root, AGENT_ENV))).toBe(false)
  })

  test("refuses to overwrite, and writes nothing", () => {
    const root = checkout({ ".env": ROOT_ENV, [AGENT_ENV]: "KEEP=me\n" })
    expect(() => runEnvSplit(root)).toThrow(EnvSplitError)
    expect(() => runEnvSplit(root)).toThrow(/services\/agent-py\/\.env/)
    expect(existsSync(join(root, WEB_ENV))).toBe(false)
    expect(read(root, AGENT_ENV)).toBe("KEEP=me\n")
  })

  test("leaves the root files in place", () => {
    const root = checkout({ ".env": ROOT_ENV })
    runEnvSplit(root)
    expect(read(root, ".env")).toBe(ROOT_ENV)
  })

  test("nothing to split → a clear error", () => {
    const root = checkout({})
    expect(() => runEnvSplit(root)).toThrow(/nothing to split/)
  })
})

describe("the two .env.example files split the same way (Q154)", () => {
  const keys = (path: string) => parseEnvEntries(readFileSync(join(REPO, path), "utf8")).map((e) => e.key)

  test("apps/web/.env.example holds only what Next may read", () => {
    const web = keys("apps/web/.env.example")
    expect(web.length).toBeGreaterThan(0)
    expect(web.filter((k) => !isAllowedEnvName(k))).toEqual([])
  })

  test("services/agent-py/.env.example holds none of it", () => {
    const agent = keys("services/agent-py/.env.example")
    expect(agent.length).toBeGreaterThan(0)
    expect(agent.filter((k) => isAllowedEnvName(k))).toEqual([])
  })

  test("no example is left at the root", () => {
    expect(existsSync(join(REPO, ".env.example"))).toBe(false)
  })
})
