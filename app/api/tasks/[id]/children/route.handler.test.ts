/**
 * Route-handler tests for `GET /api/tasks/:id/children`: a paused child
 * carries its open question (Q59), folded from the executor's recorded
 * rows (`e2e/fixtures/task-logs.json`).
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

import {
  mocks,
  resetAgentMocks,
  signedIn,
  signedOut,
  supabaseClient,
} from "../../_test/mock-agent-store"

import logs from "../../../../../e2e/fixtures/task-logs.json"
import { TaskChildrenResponseSchema } from "@/shared/api-schemas"

const USER = "11111111-1111-1111-1111-111111111111"
const [parent, ...children] = logs.stages["children.asking"]
const params = Promise.resolve({ id: parent.id })

type Row = Record<string, unknown>

/** The recorded rows up to `seq`, as each child's log, behind the query the route makes. */
function serveEvents(rows: Row[]) {
  const reads: Row[] = []
  const from = (table: string) => {
    const filters: Row = { table }
    let found = rows
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters[column] = value
        found = found.filter((r) => r[column] === value)
        return query
      },
      in: (column: string, values: unknown[]) => {
        filters[column] = values
        found = found.filter((r) => values.includes(r[column]))
        return query
      },
      order: () => query,
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
        reads.push(filters)
        return Promise.resolve({ data: found, error: null }).then(resolve)
      },
    }
    return query
  }
  supabaseClient.value = { ...signedIn(USER), from } as typeof supabaseClient.value
  return reads
}

const upTo = (id: string, seq: number): Row[] =>
  logs.events.filter((e) => e.task_id === id && e.seq <= seq).map((e) => ({ ...e, user_id: USER }))

async function getChildren() {
  const { GET } = await import("./route")
  const res = await GET(new NextRequest(`http://localhost/api/tasks/${parent.id}/children`), { params })
  return { status: res.status, body: await res.json() }
}

beforeEach(resetAgentMocks)

describe("GET /api/tasks/:id/children", () => {
  for (const kind of ["approval", "choice", "input", "ui-part"] as const) {
    test(`a paused child carries its ${kind} question`, async () => {
      const child = children.find((c) => c.goal === `Check ${kind}`)!
      mocks.listTaskChildren.mockImplementation(async () => [child])
      const reads = serveEvents(upTo(child.id, child.seq))
      const { status, body } = await getChildren()
      expect(status).toBe(200)
      const [row] = TaskChildrenResponseSchema.parse(body).children
      expect(row.pendingInput).toMatchObject({ requestId: `toolu_child_${kind}`, kind })
      if (kind === "ui-part") {
        expect(row.pendingInput).toMatchObject({
          uiKind: "confirm",
          uiProps: { prompt: "Publish the draft now?" },
        })
      }
      // Scoped to the caller, and only the kinds a question folds from.
      expect(reads).toEqual([
        { table: "task_events", task_id: child.id, user_id: USER, kind: ["approval", "status"] },
      ])
    })
  }

  test("children that aren't paused carry no question, and their logs aren't read", async () => {
    mocks.listTaskChildren.mockImplementation(async () =>
      ["queued", "running", "done", "cancelled"].map((status, i) => ({ ...children[i], status }))
    )
    const reads = serveEvents(children.flatMap((c) => upTo(c.id, c.seq)))
    const { body } = await getChildren()
    expect(body.children).toHaveLength(4)
    for (const row of body.children) expect(row.pendingInput ?? null).toBeNull()
    expect(reads).toEqual([])
  })

  test("an answered question isn't asked again", async () => {
    const child = children[0]
    mocks.listTaskChildren.mockImplementation(async () => [child])
    serveEvents(upTo(child.id, Infinity))
    const { body } = await getChildren()
    expect(body.children[0].pendingInput ?? null).toBeNull()
  })

  test("a question a resume marker discarded isn't shown", async () => {
    const child = children[0]
    mocks.listTaskChildren.mockImplementation(async () => [child])
    serveEvents([
      ...upTo(child.id, child.seq),
      {
        task_id: child.id,
        user_id: USER,
        seq: 8,
        step: 1,
        kind: "status",
        payload: { status: "running", resumedFromSeq: 2 },
        created_at: new Date().toISOString(),
      },
    ])
    const { body } = await getChildren()
    expect(body.children[0].pendingInput ?? null).toBeNull()
  })

  test("401 signed out", async () => {
    supabaseClient.value = signedOut()
    expect((await getChildren()).status).toBe(401)
    expect(mocks.listTaskChildren).not.toHaveBeenCalled()
  })
})
