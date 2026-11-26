/**
 * Wave 10 (Q119): on agent-py the model rules follow its `GET /v1/models`
 * (the models it has a provider for), not the built-in Anthropic list —
 * until the list arrives, and if it can't be read, they keep the built-in
 * one. agent-ts stays Anthropic-only (frozen).
 */
import { afterEach, describe, expect, test } from "bun:test"

import {
  autoAvailableForBackend,
  backendAcceptsModel,
  defaultModelForBackend,
  modelSwitchFor,
  modelsForBackend,
  resolveModelBackend,
  TASK_MODEL_BACKEND,
  taskModelFor,
} from "./backend-models"
import { ANTHROPIC_SERVICE_MODELS, AUTO_MODEL_ID } from "./models"
import { parseServedModels, servedModels, setServedModels, subscribeServedModels } from "./served-models"

const MINIMAX_DEPLOY = {
  models: [
    { id: "minimax/minimax-m2.7", tasks: true },
    { id: "minimax/minimax-m3.1-flash", tasks: true },
    { id: "minimax/minimax-m3", tasks: false },
  ],
  defaultModel: "minimax/minimax-m3.1-flash",
  auto: false,
}

afterEach(() => setServedModels(null))

describe("parseServedModels", () => {
  test("reads /v1/models", () => {
    const s = parseServedModels(MINIMAX_DEPLOY)!
    expect([...s.ids]).toEqual(["minimax/minimax-m2.7", "minimax/minimax-m3.1-flash", "minimax/minimax-m3"])
    expect([...s.tasks]).toEqual(["minimax/minimax-m2.7", "minimax/minimax-m3.1-flash"])
    expect(s.defaultModel).toBe("minimax/minimax-m3.1-flash")
    expect(s.auto).toBe(false)
  })

  test("anything else is unreadable", () => {
    for (const bad of [null, {}, { models: "x" }, { models: [{ id: 1 }], defaultModel: "a", auto: false }]) {
      expect(parseServedModels(bad)).toBeNull()
    }
  })

  test("subscribers hear a change", () => {
    let heard = 0
    const off = subscribeServedModels(() => heard++)
    setServedModels(parseServedModels(MINIMAX_DEPLOY))
    off()
    setServedModels(null)
    expect(heard).toBe(1)
  })
})

describe("the rules on agent-py follow its list", () => {
  test("before the list arrives: the built-in Anthropic list", () => {
    expect(servedModels()).toBeNull()
    for (const kind of ["agent-service", "agent-runs"] as const) {
      expect(modelsForBackend(kind).map((m) => m.id)).toEqual([...ANTHROPIC_SERVICE_MODELS.keys()])
    }
  })

  test("chat on agent-py offers what it serves", () => {
    setServedModels(parseServedModels(MINIMAX_DEPLOY))
    for (const kind of ["agent-service", "agent-runs"] as const) {
      expect(modelsForBackend(kind).map((m) => m.id)).toEqual([
        "minimax/minimax-m2.7",
        "minimax/minimax-m3.1-flash",
        "minimax/minimax-m3",
      ])
      expect(backendAcceptsModel(kind, "anthropic/claude-haiku-4.5")).toBe(false)
    }
    // The catalog default isn't served: the switch goes to agent-py's own.
    expect(defaultModelForBackend("agent-runs")).toBe("minimax/minimax-m3.1-flash")
    expect(modelSwitchFor({ kind: "agent-runs", name: "agent-py" }, "anthropic/claude-haiku-4.5")).toBe(
      "minimax/minimax-m3.1-flash",
    )
    expect(autoAvailableForBackend("agent-runs")).toBe(false)
    expect(backendAcceptsModel("agent-runs", AUTO_MODEL_ID)).toBe(false)
  })

  test("auto follows the list", () => {
    setServedModels(parseServedModels({ ...MINIMAX_DEPLOY, auto: true }))
    expect(autoAvailableForBackend("agent-runs")).toBe(true)
    expect(autoAvailableForBackend("agent-service")).toBe(false) // /v1/chat never routed auto
  })

  test("tasks take only the models tasks run on", () => {
    setServedModels(parseServedModels(MINIMAX_DEPLOY))
    expect(modelsForBackend(TASK_MODEL_BACKEND.kind).map((m) => m.id)).toEqual([
      "minimax/minimax-m2.7",
      "minimax/minimax-m3.1-flash",
    ])
    expect(taskModelFor("minimax/minimax-m3")).toEqual({
      model: "minimax/minimax-m3.1-flash",
      switchedFrom: "minimax/minimax-m3",
    })
    expect(taskModelFor("minimax/minimax-m2.7")).toEqual({ model: "minimax/minimax-m2.7", switchedFrom: null })
  })

  test("agent-ts stays on the Anthropic list", () => {
    setServedModels(parseServedModels(MINIMAX_DEPLOY))
    const agentTs = resolveModelBackend("ts-service", true, { agentPy: true, agentTs: true })
    expect(agentTs).toEqual({ kind: "agent-ts", name: "agent-ts" })
    expect(modelsForBackend(agentTs.kind).map((m) => m.id)).toEqual([...ANTHROPIC_SERVICE_MODELS.keys()])
  })
})
