/**
 * Model allowlist — `config/models.json`'s `anthropic/*` entries are the
 * only ids agent-ts accepts; each maps to its Anthropic API id. Covers
 * the mapping, the 400 `unknown_model` on `/v1/chat` + `/v1/summarize`,
 * a tampered run checkpoint failing the run, and the boot-time check of
 * `AGENT_DEFAULT_MODEL`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { SignJWT } from "jose"

import { createApp } from "../src/app"
import type { Sql } from "../src/db"
import { getEnv, resetEnvCacheForTest } from "../src/env"
import { executeStart } from "../src/executor"
import {
  UnknownModelError,
  defaultAnthropicApiModelId,
  resolveAnthropicApiModelId,
  resolveCheckpointModel,
} from "../src/models"
import type { RunStepFn } from "../src/runner"

const SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
const ORIGINAL_DEFAULT = process.env.AGENT_DEFAULT_MODEL

beforeAll(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET
  resetEnvCacheForTest()
})

afterAll(() => {
  delete process.env.SUPABASE_JWT_SECRET
  resetEnvCacheForTest()
})

afterEach(() => {
  if (ORIGINAL_DEFAULT === undefined) delete process.env.AGENT_DEFAULT_MODEL
  else process.env.AGENT_DEFAULT_MODEL = ORIGINAL_DEFAULT
  resetEnvCacheForTest()
})

async function makeJwt(): Promise<string> {
  return new SignJWT({
    sub: "00000000-0000-4000-8000-000000000123",
    role: "authenticated",
    aud: "authenticated",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET))
}

async function post(path: string, body: unknown): Promise<Response> {
  const token = await makeJwt()
  return createApp().request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  })
}

describe("resolveAnthropicApiModelId", () => {
  test("allowed catalog id → Anthropic API id", () => {
    expect(resolveAnthropicApiModelId("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-4-6")
    expect(resolveAnthropicApiModelId("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4-5")
  })

  test.each([
    "deepseek/deepseek-v4-flash", // in the catalog, but not anthropic/*
    "openrouter/anthropic/claude-sonnet-4.5",
    "claude-sonnet-4-6", // a raw API id is not a catalog id
    "anthropic/claude-opus-9",
    "",
  ])("%p → UnknownModelError", (id) => {
    expect(() => resolveAnthropicApiModelId(id)).toThrow(UnknownModelError)
  })
})

describe("AGENT_DEFAULT_MODEL", () => {
  test("defaults to Haiku 4.5", () => {
    delete process.env.AGENT_DEFAULT_MODEL
    resetEnvCacheForTest()
    expect(getEnv().AGENT_DEFAULT_MODEL).toBe("anthropic/claude-haiku-4.5")
    expect(defaultAnthropicApiModelId()).toBe("claude-haiku-4-5")
  })

  test("empty (as copied from .env.example) → the default", () => {
    process.env.AGENT_DEFAULT_MODEL = ""
    resetEnvCacheForTest()
    expect(getEnv().AGENT_DEFAULT_MODEL).toBe("anthropic/claude-haiku-4.5")
  })

  test("an allowed override is honoured", () => {
    process.env.AGENT_DEFAULT_MODEL = "anthropic/claude-sonnet-4.6"
    resetEnvCacheForTest()
    expect(defaultAnthropicApiModelId()).toBe("claude-sonnet-4-6")
  })

  test.each(["deepseek/deepseek-v4-flash", "claude-haiku-4-5"])(
    "a non-allowed default (%p) fails env validation at boot",
    (id) => {
      process.env.AGENT_DEFAULT_MODEL = id
      resetEnvCacheForTest()
      expect(() => getEnv()).toThrow(/AGENT_DEFAULT_MODEL/)
    },
  )
})

describe("route enforcement → 400 unknown_model", () => {
  test("/v1/chat rejects a non-allowlisted model", async () => {
    const res = await post("/v1/chat", {
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe("unknown_model")
    expect(body.message).toContain("deepseek/deepseek-v4-flash")
  })

  test("/v1/summarize rejects a non-allowlisted model", async () => {
    const res = await post("/v1/summarize", {
      mode: "file",
      text: "x",
      model: "claude-3-5-sonnet-20241022",
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("unknown_model")
  })
})

describe("executor checkpoint re-validation", () => {
  test("resolveCheckpointModel: absent → null, allowed → API id, tampered → throws", () => {
    expect(resolveCheckpointModel({})).toBeNull()
    expect(resolveCheckpointModel({ config: {} })).toBeNull()
    expect(resolveCheckpointModel({ config: { model: "anthropic/claude-sonnet-4.6" } })).toBe(
      "claude-sonnet-4-6",
    )
    expect(() => resolveCheckpointModel({ config: { model: "claude-opus-4-8" } })).toThrow(
      UnknownModelError,
    )
    expect(() => resolveCheckpointModel({ config: { model: 42 } })).toThrow(UnknownModelError)
  })

  test("a tampered checkpoint model fails the run before any step runs", async () => {
    const statements: { stmt: string; args: unknown[] }[] = []
    const fakeSql = {
      unsafe: async (stmt: string, args: unknown[]) => {
        statements.push({ stmt, args })
        if (stmt.includes("SELECT checkpoint")) {
          return [{ checkpoint: { config: { model: "claude-opus-4-8" }, messages: [] } }]
        }
        return []
      },
    } as unknown as Sql

    let stepFnBuilt = false
    const outcome = await executeStart(
      fakeSql,
      { runId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" },
      {
        makeStepFn: (): RunStepFn => {
          stepFnBuilt = true
          return async () => ({ done: true })
        },
      },
    )

    expect(stepFnBuilt).toBe(false)
    expect(outcome.settled).toBe(false)
    expect(outcome.error).toContain('Unknown model "claude-opus-4-8"')
    // Terminal `result: failed` event + task row settled failed.
    const failedEvent = statements.find(
      (s) => s.stmt.includes("task_events") && s.args.includes("result"),
    )
    expect(failedEvent).toBeDefined()
    const settle = statements.find((s) => s.stmt.startsWith("UPDATE public.tasks SET"))
    expect(settle?.args).toContain("failed")
  })
})
