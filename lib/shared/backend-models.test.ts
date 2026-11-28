import { describe, expect, test } from "bun:test"

import {
  autoAvailableForBackend,
  CHAT_MODEL_BACKEND,
  modelSwitchFor,
  backendAcceptsModel,
  defaultModelForBackend,
  modelsForBackend,
  pickFallbackModel,
  RUNS_ROUTING_AVAILABLE,
  TASK_FALLBACK_MODEL,
  taskModelFor,
} from "./backend-models"
import {
  ANTHROPIC_SERVICE_MODELS,
  AUTO_MODEL_ID,
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  ROUTING_CONFIG,
} from "./models"

describe("backend models (Q40)", () => {
  test("chat on agent-py takes exactly the anthropic allowlist until its list arrives", () => {
    const offered = modelsForBackend("agent-runs").map((m) => m.id)
    expect(offered.length).toBeGreaterThan(0)
    expect(new Set(offered)).toEqual(new Set(ANTHROPIC_SERVICE_MODELS.keys()))
  })

  test("agent-py's runs take those models, plus auto when the routing pair is anthropic/*", () => {
    for (const m of CHAT_MODELS) {
      expect(backendAcceptsModel("agent-runs", m.id)).toBe(ANTHROPIC_SERVICE_MODELS.has(m.id))
    }
    const expected =
      ROUTING_CONFIG !== null &&
      ANTHROPIC_SERVICE_MODELS.has(ROUTING_CONFIG.strong) &&
      ANTHROPIC_SERVICE_MODELS.has(ROUTING_CONFIG.weak)
    expect(RUNS_ROUTING_AVAILABLE).toBe(expected)
    expect(autoAvailableForBackend("agent-runs")).toBe(expected)
    expect(backendAcceptsModel("agent-runs", AUTO_MODEL_ID)).toBe(expected)
    // The repo catalog routes between two Anthropic models.
    expect(RUNS_ROUTING_AVAILABLE).toBe(true)
  })

  test("the default is accepted there", () => {
    const fallback = defaultModelForBackend("agent-runs")
    expect(fallback).not.toBeNull()
    expect(backendAcceptsModel("agent-runs", fallback!)).toBe(true)
    if (ANTHROPIC_SERVICE_MODELS.has(DEFAULT_CHAT_MODEL)) expect(fallback).toBe(DEFAULT_CHAT_MODEL)
    else expect(fallback).toBe(modelsForBackend("agent-runs")[0]!.id)
  })

  test("chat is agent-py's runs (wave 13: the only backend)", () => {
    expect(CHAT_MODEL_BACKEND).toEqual({ kind: "agent-runs", name: "agent-py" })
  })
})

describe("modelSwitchFor (Q40)", () => {
  const runs = CHAT_MODEL_BACKEND
  const nonAnthropic = CHAT_MODELS.find((m) => !ANTHROPIC_SERVICE_MODELS.has(m.id))!
  const anthropic = CHAT_MODELS.find((m) => ANTHROPIC_SERVICE_MODELS.has(m.id))!

  test("a model agent-py rejects switches to one it accepts", () => {
    const to = modelSwitchFor(runs, nonAnthropic.id)
    expect(to).not.toBeNull()
    expect(ANTHROPIC_SERVICE_MODELS.has(to!)).toBe(true)
  })

  test("auto stays on agent-py's runs (it routes it), not in tasks", () => {
    expect(modelSwitchFor(runs, AUTO_MODEL_ID)).toBeNull()
    expect(modelSwitchFor({ kind: "agent-tasks", name: "tasks" }, AUTO_MODEL_ID)).not.toBeNull()
  })

  test("an accepted model stays", () => {
    expect(modelSwitchFor(runs, anthropic.id)).toBeNull()
  })
})

describe("pickFallbackModel (Q40)", () => {
  test("it only suggests models agent-py accepts, never the failed one", () => {
    for (const m of CHAT_MODELS) {
      const pick = pickFallbackModel(m.id)
      if (pick) {
        expect(ANTHROPIC_SERVICE_MODELS.has(pick.id)).toBe(true)
        expect(pick.id).not.toBe(m.id)
      }
    }
    expect(pickFallbackModel(undefined)).not.toBeNull()
  })
})

describe("taskModelFor (Q55)", () => {
  test("falls back to Haiku, agent-py's own default (Q67)", () => {
    expect(taskModelFor("deepseek/deepseek-v4-flash")).toEqual({
      model: "anthropic/claude-haiku-4.5",
      switchedFrom: "deepseek/deepseek-v4-flash",
    })
  })

  test("keeps exactly the models the task worker runs", () => {
    for (const { id } of CHAT_MODELS) {
      const { model, switchedFrom } = taskModelFor(id)
      expect(backendAcceptsModel("agent-tasks", model!)).toBe(true)
      if (ANTHROPIC_SERVICE_MODELS.has(id)) {
        expect({ model, switchedFrom }).toEqual({ model: id, switchedFrom: null })
      } else {
        expect(switchedFrom).toBe(id)
      }
    }
  })

  test("auto, an unknown id and no model at all are switched", () => {
    const fallback = TASK_FALLBACK_MODEL
    expect(taskModelFor(AUTO_MODEL_ID)).toEqual({ model: fallback, switchedFrom: AUTO_MODEL_ID })
    expect(taskModelFor("claude-sonnet-4-6")).toEqual({
      model: fallback,
      switchedFrom: "claude-sonnet-4-6",
    })
    // Absent reads as the route's default, which the worker can't run.
    for (const absent of [undefined, null, ""]) expect(taskModelFor(absent).model).toBe(fallback)
  })
})
