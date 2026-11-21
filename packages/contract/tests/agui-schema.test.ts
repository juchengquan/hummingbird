/**
 * The vendored AG-UI 1.0 JSON Schema: unchanged since it was pinned
 * (see agui/SOURCE.md) and usable by the same validator the conformance
 * suite uses, so Phase 2's run endpoints can `$ref` it.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "bun:test"

import { createAjv } from "../conformance/harness"

const SCHEMA_PATH = fileURLToPath(new URL("../agui/1.0/schema.json", import.meta.url))
const PINNED_SHA256 = "4b5c93226838a0e72d88e6c5df20633c686c49fcb75d9be2815c6cbf9e48e71a"

const raw = readFileSync(SCHEMA_PATH)
const schema = JSON.parse(raw.toString("utf8")) as { $id: string; $defs: Record<string, unknown> }

describe("contract: vendored AG-UI 1.0 schema", () => {
  test("matches the pinned SHA-256 (do not edit vendored files)", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(PINNED_SHA256)
    expect(readFileSync(fileURLToPath(new URL("../agui/SOURCE.md", import.meta.url)), "utf8")).toContain(
      PINNED_SHA256,
    )
  })

  const ajv = createAjv()
  ajv.addSchema(schema)
  const event = ajv.getSchema(schema.$id)!
  const runInput = ajv.getSchema(`${schema.$id}#/$defs/RunAgentInput`)!

  test("compiles, and the run input + events used by the run contract resolve", () => {
    expect(schema.$id).toBe("https://ag-ui.com/spec/1.0/schema.json")
    expect(event).toBeDefined()
    expect(runInput).toBeDefined()
    for (const name of ["RunStartedEvent", "RunFinishedEvent", "CustomEvent", "MessagesSnapshotEvent", "ResumeEntry"]) {
      expect(ajv.getSchema(`${schema.$id}#/$defs/${name}`)).toBeDefined()
    }
  })

  test("accepts a minimal RunAgentInput and rejects one missing runId", () => {
    const input = { threadId: "t1", runId: "r1", messages: [{ id: "m1", role: "user", content: "hi" }] }
    expect(runInput(input)).toBe(true)
    expect(runInput({ threadId: input.threadId, messages: input.messages })).toBe(false)
  })

  test("validates events by their `type` discriminator", () => {
    expect(event({ type: "RUN_STARTED", threadId: "t1", runId: "r1" })).toBe(true)
    expect(event({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hel" })).toBe(true)
    expect(event({ type: "RUN_FINISHED", threadId: "t1", runId: "r1" })).toBe(true)
    expect(event({ type: "NOT_AN_EVENT" })).toBe(false)
    // Strict schema: unknown fields fail (runtime receivers must tolerate them instead).
    expect(event({ type: "RUN_STARTED", threadId: "t1", runId: "r1", bogus: 1 })).toBe(false)
  })
})
