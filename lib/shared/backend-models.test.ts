import { describe, expect, test } from "bun:test"

import {
  autoAvailableForBackend,
  modelSwitchFor,
  resolveModelBackend,
  backendAcceptsModel,
  defaultModelForBackend,
  modelsForBackend,
  pickFallbackModel,
} from "./backend-models"
import {
  ANTHROPIC_SERVICE_MODELS,
  AUTO_MODEL_ID,
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  ROUTING_AVAILABLE,
} from "./models"

describe("backend models (Q40)", () => {
  test("the Next.js routes take every catalog model, and auto when routing is configured", () => {
    for (const m of CHAT_MODELS) expect(backendAcceptsModel("any", m.id)).toBe(true)
    expect(backendAcceptsModel("any", AUTO_MODEL_ID)).toBe(ROUTING_AVAILABLE)
    expect(backendAcceptsModel("any", "nope/unknown")).toBe(false)
    expect(modelsForBackend("any")).toEqual(CHAT_MODELS)
    expect(autoAvailableForBackend("any")).toBe(ROUTING_AVAILABLE)
    expect(defaultModelForBackend("any")).toBe(DEFAULT_CHAT_MODEL)
  })

  test("the agent services take exactly the anthropic allowlist, never auto", () => {
    const offered = modelsForBackend("agent-service").map((m) => m.id)
    expect(offered.length).toBeGreaterThan(0)
    expect(new Set(offered)).toEqual(new Set(ANTHROPIC_SERVICE_MODELS.keys()))
    for (const m of CHAT_MODELS) {
      expect(backendAcceptsModel("agent-service", m.id)).toBe(ANTHROPIC_SERVICE_MODELS.has(m.id))
    }
    expect(backendAcceptsModel("agent-service", AUTO_MODEL_ID)).toBe(false)
    expect(autoAvailableForBackend("agent-service")).toBe(false)
  })

  test("the agent-service default is accepted there", () => {
    const fallback = defaultModelForBackend("agent-service")
    expect(fallback).not.toBeNull()
    expect(backendAcceptsModel("agent-service", fallback!)).toBe(true)
    if (ANTHROPIC_SERVICE_MODELS.has(DEFAULT_CHAT_MODEL)) expect(fallback).toBe(DEFAULT_CHAT_MODEL)
    else expect(fallback).toBe(modelsForBackend("agent-service")[0]!.id)
  })
})

const both = { agentPy: true, agentTs: true }
const none = { agentPy: false, agentTs: false }

describe("resolveModelBackend (Q40)", () => {
  test("the runs option reaches agent-py signed in or out", () => {
    expect(resolveModelBackend("python-runs", false, both)).toEqual({ kind: "agent-service", name: "agent-py" })
    expect(resolveModelBackend("python-runs", true, both)).toEqual({ kind: "agent-service", name: "agent-py" })
  })

  test("python / ts-service reach their service only when signed in", () => {
    expect(resolveModelBackend("python", true, both)).toEqual({ kind: "agent-service", name: "agent-py" })
    expect(resolveModelBackend("python", false, both).kind).toBe("any")
    expect(resolveModelBackend("ts-service", true, both)).toEqual({ kind: "agent-service", name: "agent-ts" })
    expect(resolveModelBackend("ts-service", false, both).kind).toBe("any")
  })

  test("the Next.js route, or an unconfigured service, takes every model", () => {
    expect(resolveModelBackend("ts", true, both).kind).toBe("any")
    for (const b of ["python", "python-runs", "ts-service"] as const) {
      expect(resolveModelBackend(b, true, none).kind).toBe("any")
    }
  })
})

describe("modelSwitchFor (Q40)", () => {
  const agentPy = { kind: "agent-service", name: "agent-py" } as const
  const next = { kind: "any", name: null } as const
  const nonAnthropic = CHAT_MODELS.find((m) => !ANTHROPIC_SERVICE_MODELS.has(m.id))!
  const anthropic = CHAT_MODELS.find((m) => ANTHROPIC_SERVICE_MODELS.has(m.id))!

  test("a model the agent service rejects switches to one it accepts", () => {
    const to = modelSwitchFor(agentPy, nonAnthropic.id)
    expect(to).not.toBeNull()
    expect(ANTHROPIC_SERVICE_MODELS.has(to!)).toBe(true)
    expect(modelSwitchFor(agentPy, AUTO_MODEL_ID)).not.toBeNull()
  })

  test("an accepted model stays, and the Next.js routes never switch a catalog model", () => {
    expect(modelSwitchFor(agentPy, anthropic.id)).toBeNull()
    for (const m of CHAT_MODELS) expect(modelSwitchFor(next, m.id)).toBeNull()
  })
})

describe("pickFallbackModel (Q40)", () => {
  test("on the Next.js routes the catalog default comes first", () => {
    const other = CHAT_MODELS.find((m) => m.id !== DEFAULT_CHAT_MODEL)!
    expect(pickFallbackModel(other.id)?.id).toBe(DEFAULT_CHAT_MODEL)
    expect(pickFallbackModel(DEFAULT_CHAT_MODEL)?.id).not.toBe(DEFAULT_CHAT_MODEL)
  })

  test("on an agent service it only suggests models the service accepts", () => {
    for (const m of CHAT_MODELS) {
      const pick = pickFallbackModel(m.id, "agent-service")
      if (pick) {
        expect(ANTHROPIC_SERVICE_MODELS.has(pick.id)).toBe(true)
        expect(pick.id).not.toBe(m.id)
      }
    }
    expect(pickFallbackModel(undefined, "agent-service")).not.toBeNull()
  })
})
