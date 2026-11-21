/** Chat's answer cards on runs: interrupts as card questions, card answers
 *  as resume payloads, the submit through a (fake) bridge and its failures,
 *  over the recorded agent-py interrupts. */

import { afterEach, describe, expect, test } from "bun:test"

import { formatAnswerForChat } from "@/shared/generative-ui/schemas"

import {
  getChatRunBridge,
  registerChatRunBridge,
  type AnswerResult,
  type ChatRunBridge,
  type InterruptedTurn,
} from "./chat-bridge"
import { RunsError } from "./errors"
import { loadFixture } from "./fixtures"
import {
  answeredUiParts,
  answerErrorText,
  classifyAnswerFailure,
  describeDraft,
  interruptAnswerFor,
  isInterruptExpired,
  msUntilNextExpiry,
  questionFromInterrupt,
  recheckAnsweredRun,
  resumeAnswers,
  submitTurnAnswers,
  uiPartIdFor,
  uiPartIdsOwnedByTurn,
  type DraftAnswer,
} from "./interrupt-answers"
import {
  buildResume,
  toPendingInterrupt,
  type InterruptAnswer,
  type PendingInterrupt,
} from "./interrupts"
import type { Interrupt } from "./types"

function recordedInterrupts(name: string): PendingInterrupt[] {
  const closing = loadFixture(name).items.at(-1)!.event as unknown as {
    type: string
    runId: string
    outcome: { type: string; interrupts: Interrupt[] }
  }
  expect(closing.type).toBe("RUN_FINISHED")
  expect(closing.outcome.type).toBe("interrupt")
  return closing.outcome.interrupts.map(toPendingInterrupt)
}

const [approval] = recordedInterrupts("memory-interrupt-signed_in")
const [choice] = recordedInterrupts("memory-interrupt-choice")
const [uiPart] = recordedInterrupts("memory-interrupt-ui")

/** The recorded ui-part (`confirm` with `{ title }`) fails the confirm
 *  schema (it wants `prompt`); a valid twin for the cards. */
const confirmPart: PendingInterrupt = {
  ...uiPart,
  id: "c-confirm",
  toolCallId: "c-confirm",
  uiKind: "confirm",
  uiProps: { prompt: "Send it?", confirmLabel: "Send" },
}

function turnOf(interrupts: PendingInterrupt[], over: Partial<InterruptedTurn> = {}): InterruptedTurn {
  return {
    conversationId: "conv-1",
    messageId: "msg-1",
    runId: "11111111-1111-4111-8111-111111111111",
    threadId: "22222222-2222-4222-8222-222222222222",
    interrupts,
    anonymous: false,
    ...over,
  }
}

describe("questionFromInterrupt (recorded interrupts)", () => {
  test("approval: the gated tool and its args", () => {
    expect(questionFromInterrupt(approval)).toEqual({
      id: "c2",
      reason: "approval",
      tool: "send",
      args: { to: "bob" },
      prompt: undefined,
      options: undefined,
      multi: undefined,
      uiKind: undefined,
      uiProps: undefined,
    })
  })

  test("choice: prompt + options", () => {
    const q = questionFromInterrupt(choice)!
    expect(q.reason).toBe("choice")
    expect(q.prompt).toBe("Which one?")
    expect(q.options).toEqual([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ])
  })

  test("ui-part: the generative-UI kind + props", () => {
    const q = questionFromInterrupt(uiPart)!
    expect(q.reason).toBe("ui-part")
    expect(q.uiKind).toBe("confirm")
    expect(q.uiProps).toEqual({ prompt: "Sure?" })
  })

  test("an unknown reason has no card (dismiss only)", () => {
    expect(questionFromInterrupt({ ...approval, reason: "teleport" })).toBeNull()
  })
})

describe("interruptAnswerFor", () => {
  test("approval / choice / input answers pass through", () => {
    expect(interruptAnswerFor({ approved: true })).toEqual({ approved: true })
    expect(interruptAnswerFor({ selection: ["a"] })).toEqual({ selection: ["a"] })
    expect(interruptAnswerFor({ value: "hi" })).toEqual({ value: "hi" })
    expect(interruptAnswerFor({ cancelled: true })).toEqual({ cancelled: true })
  })

  test("a generative-UI answer is { uiAnswer } + the answer as text, no requestId", () => {
    const part = { kind: "confirm" as const, props: confirmPart.uiProps }
    const uiAnswer = { kind: "confirm" as const, confirmed: true }
    const payload = interruptAnswerFor({ uiAnswer, part })
    expect(payload).toEqual({ uiAnswer, value: "Send" })
    expect("requestId" in payload).toBe(false)
    expect((payload as { value: string }).value).toBe(formatAnswerForChat(part, uiAnswer))
  })

  test("a generative-UI choice also carries its selection", () => {
    const part = {
      kind: "choice" as const,
      props: { prompt: "Pick", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
    }
    expect(interruptAnswerFor({ uiAnswer: { kind: "choice", selectedIds: ["y"] }, part })).toEqual({
      uiAnswer: { kind: "choice", selectedIds: ["y"] },
      selection: ["y"],
      value: "Y",
    })
  })

  test("each answer fits its interrupt for buildResume", () => {
    const drafts: Record<string, DraftAnswer> = {
      c2: { approved: false },
      "c-ask": { selection: ["b"] },
      "c-confirm": {
        uiAnswer: { kind: "confirm", confirmed: false },
        part: { kind: "confirm", props: confirmPart.uiProps },
      },
    }
    const interrupts = [approval, choice, confirmPart]
    const answers = resumeAnswers(interrupts, drafts)!
    expect(buildResume(interrupts, answers)).toEqual([
      { interruptId: "c2", status: "resolved", payload: { approved: false } },
      { interruptId: "c-ask", status: "resolved", payload: { selection: ["b"] } },
      {
        interruptId: "c-confirm",
        status: "resolved",
        payload: { uiAnswer: { kind: "confirm", confirmed: false }, value: "Cancel" },
      },
    ])
  })
})

describe("resumeAnswers", () => {
  test("null until every open interrupt has an answer", () => {
    expect(resumeAnswers([approval, choice], { c2: { approved: true } })).toBeNull()
    expect(resumeAnswers([approval, choice], { c2: { approved: true }, "c-ask": { cancelled: true } })).toEqual({
      c2: { approved: true },
      "c-ask": { cancelled: true },
    })
  })
})

describe("expiry", () => {
  const at = Date.parse("2026-11-21T12:00:00Z")
  const expiring = { ...approval, expiresAt: "2026-11-21T12:00:00Z" }

  test("expired at and after expiresAt; never without one", () => {
    expect(isInterruptExpired(expiring, at - 1)).toBe(false)
    expect(isInterruptExpired(expiring, at)).toBe(true)
    expect(isInterruptExpired(approval, at)).toBe(false)
    expect(isInterruptExpired({ expiresAt: "not a date" }, at)).toBe(false)
  })

  test("msUntilNextExpiry: the soonest future expiry", () => {
    const later = { ...choice, expiresAt: "2026-11-21T12:05:00Z" }
    expect(msUntilNextExpiry([expiring, later], at - 1000)).toBe(1000)
    expect(msUntilNextExpiry([expiring, later], at)).toBe(5 * 60_000)
    expect(msUntilNextExpiry([approval], at)).toBeNull()
  })

  test("an expired interrupt is answered by dismissing it", () => {
    expect(buildResume([expiring], resumeAnswers([expiring], { c2: { cancelled: true } })!)).toEqual([
      { interruptId: "c2", status: "cancelled" },
    ])
  })
})

describe("describeDraft", () => {
  test("what an answered card shows", () => {
    expect(describeDraft(questionFromInterrupt(approval), { approved: true })).toBe("Approved")
    expect(describeDraft(questionFromInterrupt(approval), { approved: false })).toBe("Rejected")
    expect(describeDraft(questionFromInterrupt(choice), { selection: ["b", "a"] })).toBe("B, A")
    expect(describeDraft(null, { cancelled: true })).toBe("Dismissed")
  })
})

describe("classifyAnswerFailure", () => {
  const err = (code: string, extra: Partial<Extract<AnswerResult, { ok: false }>> = {}) =>
    ({ ok: false, error: { code: "unknown" }, code, ...extra }) as Extract<AnswerResult, { ok: false }>

  test("run_already_resumed → answered elsewhere", () => {
    expect(classifyAnswerFailure(err("run_already_resumed"))).toEqual({ kind: "answered-elsewhere" })
  })
  test("invalid_state → expired (offer to resend)", () => {
    expect(classifyAnswerFailure(err("invalid_state"))).toEqual({ kind: "expired" })
  })
  test("anything else → an inline error", () => {
    expect(
      classifyAnswerFailure({ ok: false, error: { code: "rate_limit" }, code: "rate_limit" }),
    ).toEqual({ kind: "error", message: "Rate limited — wait a moment and try again." })
    expect(classifyAnswerFailure({ ok: false, error: { code: "network" } })).toEqual({
      kind: "error",
      message: "Network error — check your connection.",
    })
  })
  test("answerErrorText adds an unknown error's detail", () => {
    expect(answerErrorText({ code: "unknown", detail: "boom" })).toBe("Something went wrong. boom")
    expect(answerErrorText({ code: "provider", detail: "upstream 502" })).toBe(
      "The model provider returned an error.",
    )
  })
})

describe("answered generative-UI parts", () => {
  test("a resolved ui-part becomes an answered Message.uiParts entry", () => {
    const uiAnswer = { kind: "confirm" as const, confirmed: true }
    const parts = answeredUiParts(
      turnOf([approval, confirmPart]),
      {
        c2: { approved: true },
        "c-confirm": { uiAnswer, part: { kind: "confirm", props: confirmPart.uiProps } },
      },
      "2026-11-21T12:00:00.000Z",
    )
    expect(parts).toEqual([
      {
        id: "c-confirm",
        kind: "confirm",
        props: { prompt: "Send it?", confirmLabel: "Send" },
        answeredAt: "2026-11-21T12:00:00.000Z",
        answer: uiAnswer,
      },
    ])
  })

  test("dismissed or invalid parts are skipped", () => {
    expect(answeredUiParts(turnOf([confirmPart]), { "c-confirm": { cancelled: true } }, "t")).toEqual([])
    expect(
      answeredUiParts(
        turnOf([uiPart]),
        { "c-ui": { uiAnswer: { kind: "confirm", confirmed: true }, part: { kind: "confirm", props: { title: "Sure?" } } } },
        "t",
      ),
    ).toEqual([])
  })

  test("the turn owns its ui-part interrupts' parts (hidden from the message's list)", () => {
    expect(uiPartIdFor(uiPart)).toBe("c-ui")
    expect(uiPartIdFor({ id: "x" })).toBe("x")
    expect([...uiPartIdsOwnedByTurn(turnOf([approval, uiPart, confirmPart]))]).toEqual(["c-ui", "c-confirm"])
    expect(uiPartIdsOwnedByTurn(undefined).size).toBe(0)
  })
})

describe("submitTurnAnswers (fake bridge)", () => {
  let unregister: (() => void) | null = null
  afterEach(() => {
    unregister?.()
    unregister = null
  })

  function fakeBridge(result: AnswerResult | Error) {
    const calls: Array<{ turn: InterruptedTurn; answers: Record<string, InterruptAnswer> }> = []
    const bridge: ChatRunBridge = {
      async answerInterrupts(turn, answers) {
        calls.push({ turn, answers })
        if (result instanceof Error) throw result
        return result
      },
    }
    unregister = registerChatRunBridge(bridge)
    return { bridge, calls }
  }

  test("incomplete answers are never sent", async () => {
    const { calls } = fakeBridge({ ok: true })
    const outcome = await submitTurnAnswers(turnOf([approval, choice]), { c2: { approved: true } }, getChatRunBridge())
    expect(outcome).toEqual({ type: "incomplete" })
    expect(calls).toHaveLength(0)
  })

  test("no bridge (chat not mounted) → nothing sent, no throw", async () => {
    expect(getChatRunBridge()).toBeNull()
    expect(await submitTurnAnswers(turnOf([approval]), { c2: { approved: true } }, getChatRunBridge())).toEqual({
      type: "no-bridge",
    })
  })

  test("answers reach the bridge keyed by interrupt id; parts come back answered", async () => {
    const { calls } = fakeBridge({ ok: true })
    const turn = turnOf([approval, confirmPart])
    const uiAnswer = { kind: "confirm" as const, confirmed: true }
    const outcome = await submitTurnAnswers(
      turn,
      { c2: { approved: true }, "c-confirm": { uiAnswer, part: { kind: "confirm", props: confirmPart.uiProps } } },
      getChatRunBridge(),
      new Date("2026-11-21T12:00:00Z"),
    )
    expect(calls).toEqual([
      { turn, answers: { c2: { approved: true }, "c-confirm": { uiAnswer, value: "Send" } } },
    ])
    expect(outcome.type).toBe("answered")
    expect(outcome.type === "answered" && outcome.uiParts.map((p) => p.id)).toEqual(["c-confirm"])
  })

  test("failures are classified; a throwing bridge is an unknown error", async () => {
    fakeBridge({ ok: false, error: { code: "unknown" }, code: "run_already_resumed" })
    expect(await submitTurnAnswers(turnOf([approval]), { c2: { approved: true } }, getChatRunBridge())).toEqual({
      type: "failed",
      failure: { kind: "answered-elsewhere" },
    })
    unregister?.()
    fakeBridge(new Error("kaput"))
    expect(await submitTurnAnswers(turnOf([approval]), { c2: { approved: true } }, getChatRunBridge())).toEqual({
      type: "failed",
      failure: { kind: "error", message: "Something went wrong. kaput" },
    })
  })
})

describe("recheckAnsweredRun", () => {
  const interrupted = { status: "interrupted" as const, openInterrupts: [approval.raw] }
  test("still interrupted → waiting; moved on or 404 → gone; else unknown", async () => {
    expect(await recheckAnsweredRun("r", async () => interrupted)).toBe("waiting")
    expect(await recheckAnsweredRun("r", async () => ({ status: "succeeded", openInterrupts: [] }))).toBe("gone")
    expect(
      await recheckAnsweredRun("r", async () => {
        throw new RunsError("http", "not_found", "gone", 404)
      }),
    ).toBe("gone")
    expect(
      await recheckAnsweredRun("r", async () => {
        throw new RunsError("network", "network", "offline")
      }),
    ).toBe("unknown")
  })
})
