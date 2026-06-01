/**
 * Health + readyz smoke tests. Mirror agent-py's `test_health.py`.
 */

import { describe, test, expect, beforeEach } from "bun:test"

import { createApp } from "../src/app"
import { resetEnvCacheForTest } from "../src/env"

describe("health routes", () => {
  beforeEach(() => {
    resetEnvCacheForTest()
  })

  test("/healthz returns 200 with service identity", async () => {
    const app = createApp()
    const res = await app.request("/healthz")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; service: string; version: string }
    expect(body.status).toBe("ok")
    expect(body.service).toBe("agent-ts")
    expect(typeof body.version).toBe("string")
  })

  test("/readyz reports configured-deps checks", async () => {
    const app = createApp()
    const res = await app.request("/readyz")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; checks: Record<string, boolean> }
    expect(body.status).toBe("ok")
    expect(body.checks).toMatchObject({
      supabase_url_configured: expect.any(Boolean),
      supabase_db_configured: expect.any(Boolean),
      jwt_secret_configured: expect.any(Boolean),
      db_pool_open: false,
    })
  })

  test("/readyz reflects env presence", async () => {
    const prev = process.env.SUPABASE_URL
    try {
      process.env.SUPABASE_URL = "https://proj.supabase.test"
      resetEnvCacheForTest()
      const app = createApp()
      const res = await app.request("/readyz")
      const body = (await res.json()) as { checks: { supabase_url_configured: boolean } }
      expect(body.checks.supabase_url_configured).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.SUPABASE_URL
      else process.env.SUPABASE_URL = prev
      resetEnvCacheForTest()
    }
  })
})
