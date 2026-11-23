/**
 * The backend the tasks e2e specs route `/api/tasks/**` to (run with bun,
 * started by `support/tasks.ts`). The e2e harness has no Supabase, so:
 *
 * - `stream` and `children` are the app's **real route handlers**, with the
 *   real store and codecs, over an in-memory stand-in for the Supabase
 *   query builder;
 * - `POST /api/tasks`, `cancel` and `respond` (the executor side) implement
 *   the interface the plan fixes: 400 `unknown_model`, an idempotent cancel
 *   that may leave no terminal event, 409 on a second answer;
 * - the rows are recorded from the real executor
 *   (`fixtures/task-logs.json`, see `record-task-logs.py`). A spec moves
 *   them along with `POST /__control`.
 */

import { plugin, serve } from "bun"

import logs from "../fixtures/task-logs.json"
import { backendAcceptsModel } from "../../lib/shared/backend-models"

type Row = Record<string, unknown>

const USER = "00000000-0000-4000-8000-000000000001"
/** PostgREST's `max_rows` (supabase/config.toml). */
const MAX_ROWS = 1000
const FINISHED = new Set(["done", "failed", "cancelled"])
const STAGES = logs.stages as Record<string, Row[]>

interface Fault {
  op: string
  status?: number
  body?: unknown
  delayMs?: number
  /** Further requests it applies to; absent = until reset. */
  times?: number
}

interface Sent {
  op: string
  id?: string
  body?: Record<string, unknown>
  cursor?: string
}

let signedIn = true
let startAs = "plain.queued"
let rows = new Map<string, Row>()
let events: Row[] = []
let schedules: Row[] = []
let answered = new Set<string>()
let faults: Fault[] = []
let sent: Sent[] = []
let streams = new AbortController()

function reset(): void {
  streams.abort()
  streams = new AbortController()
  signedIn = true
  startAs = "plain.queued"
  rows = new Map()
  events = []
  schedules = []
  answered = new Set()
  faults = []
  sent = []
}

/** Show a recorded stage: its rows, and their logs up to that point. */
function showStage(name: string): string {
  const stage = STAGES[name]
  if (!stage) throw new Error(`no recorded stage ${name}`)
  const now = new Date().toISOString()
  for (const { seq, ...row } of stage) {
    const id = row.id as string
    rows.set(id, { ...row, user_id: USER, mode: "background", created_at: now, started_at: now })
    events = [
      ...events.filter((e) => e.task_id !== id),
      ...logs.events
        .filter((e) => e.task_id === id && e.seq <= (seq as number))
        .map((e) => ({ ...e, user_id: USER })),
    ]
  }
  return stage[0].id as string
}

/** Just enough of the Supabase client for the two handlers and their store. */
class Query {
  private where: ((row: Row) => boolean)[] = []
  private sortKey?: string
  private ascending = true
  private max = MAX_ROWS
  private columns?: string[]
  constructor(private readonly table: string) {}
  select(columns = "*") {
    if (columns !== "*") this.columns = columns.split(",").map((c) => c.trim())
    return this
  }
  eq(column: string, value: unknown) {
    this.where.push((row) => row[column] === value)
    return this
  }
  in(column: string, values: unknown[]) {
    this.where.push((row) => values.includes(row[column]))
    return this
  }
  gt(column: string, value: number) {
    this.where.push((row) => (row[column] as number) > value)
    return this
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.sortKey = column
    this.ascending = options?.ascending ?? true
    return this
  }
  limit(n: number) {
    this.max = Math.min(this.max, n)
    return this
  }
  private run(): Row[] {
    const table = this.table === "tasks" ? [...rows.values()] : this.table === "task_events" ? events : []
    const found = table.filter((row) => this.where.every((test) => test(row)))
    const key = this.sortKey
    if (key) {
      const sign = this.ascending ? 1 : -1
      found.sort((a, b) => {
        const [x, y] = [a[key] as string | number, b[key] as string | number]
        return x === y ? 0 : x < y ? -sign : sign
      })
    }
    const columns = this.columns
    return found
      .slice(0, this.max)
      .map((row) => (columns ? Object.fromEntries(columns.map((c) => [c, row[c]])) : { ...row }))
  }
  async maybeSingle() {
    return { data: this.run()[0] ?? null, error: null }
  }
  then<T>(resolve: (value: { data: Row[]; error: null }) => T) {
    return Promise.resolve({ data: this.run(), error: null }).then(resolve)
  }
}

const db = {
  auth: {
    getUser: async () => ({ data: { user: signedIn ? { id: USER } : null }, error: null }),
  },
  from: (table: string) => new Query(table),
  rpc: async () => ({ data: true, error: null }),
}

plugin({
  name: "tasks-e2e-backend",
  setup(build) {
    build.module("server-only", () => ({ exports: {}, loader: "object" }))
    build.module("@/server/supabase/server", () => ({
      exports: { getSupabaseServerClient: async () => db },
      loader: "object",
    }))
  },
})

const { NextRequest } = await import("next/server")
const streamRoute = await import("../../app/api/tasks/[id]/stream/route")
const childrenRoute = await import("../../app/api/tasks/[id]/children/route")

const refuse = (status: number, code: string, message: string) =>
  Response.json({ code, message }, { status })

async function control(req: Request): Promise<Response> {
  const { action, ...args } = await req.json()
  if (action === "reset") reset()
  else if (action === "stage") return Response.json({ id: showStage(args.name) })
  else if (action === "startAs") startAs = args.name
  else if (action === "row") {
    if (args.patch === null) rows.delete(args.id)
    else rows.set(args.id, { ...rows.get(args.id), ...args.patch })
  } else if (action === "events") {
    events.push(...(args.events as Row[]).map((e) => ({ ...e, user_id: USER })))
  } else if (action === "schedules") schedules = args.schedules
  else if (action === "signedIn") signedIn = args.value
  else if (action === "fault") faults.push(args)
  else if (action === "clearFaults") faults = []
  else if (action === "forgetAnswers") answered.clear()
  else if (action === "drop") {
    streams.abort()
    streams = new AbortController()
  } else if (action === "sent") return Response.json(sent)
  else return refuse(400, "unknown_action", action)
  return Response.json({ ok: true })
}

/** The schedules routes as agent-py / Next answer them since Q73 / Q80:
 *  a schedule saved without a model, or re-enabled without one, gets the
 *  default task model (Haiku). */
const DEFAULT_TASK_MODEL = "anthropic/claude-haiku-4.5"
function scheduleRoute(method: string, id: string | undefined, body: Record<string, unknown> | undefined): Response {
  const now = new Date().toISOString()
  if (method === "GET") return Response.json({ schedules })
  if (method === "POST") {
    const created = {
      id: crypto.randomUUID(),
      timezone: "UTC",
      enabled: true,
      systemPrompt: null,
      skills: undefined,
      maxSteps: null,
      lastRunAt: null,
      lastRunTaskId: null,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
      ...body,
      model: (body?.model as string | null | undefined) ?? DEFAULT_TASK_MODEL,
    }
    schedules = [...schedules, created]
    return Response.json(created, { status: 201 })
  }
  const found = schedules.find((s) => s.id === id)
  if (!found) return refuse(404, "not_found", "Schedule not found.")
  if (method === "DELETE") {
    schedules = schedules.filter((s) => s !== found)
    return new Response(null, { status: 204 })
  }
  const next: Row = { ...found, ...body, updatedAt: now }
  if (next.enabled && !next.model) next.model = DEFAULT_TASK_MODEL
  schedules = schedules.map((s) => (s === found ? next : s))
  return Response.json(next)
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname === "/__control") return control(req)

  const [, id, action] = url.pathname.match(/^\/api\/tasks(?:\/([^/]+)(?:\/([^/]+))?)?$/) ?? []
  const op = id === "schedules" ? "schedules" : (action ?? "start")
  let body: Record<string, unknown> | undefined
  if (req.method !== "GET") {
    const text = await req.text()
    if (text) body = JSON.parse(text)
  }
  sent.push({ op, id, body, cursor: req.headers.get("last-event-id") ?? undefined })

  const fault = faults.find((f) => f.op === op && f.times !== 0)
  if (fault) {
    if (fault.times !== undefined) fault.times -= 1
    if (fault.status) {
      if (fault.delayMs) await Bun.sleep(fault.delayMs)
      return Response.json(fault.body ?? { code: "provider", message: "e2e failure" }, {
        status: fault.status,
      })
    }
  }
  // A delayed success holds its answer back: it was read before the delay.
  const late = async (response: Response) => {
    if (fault?.delayMs) await Bun.sleep(fault.delayMs)
    return response
  }

  if (op === "schedules") return late(scheduleRoute(req.method, action, body))
  if (!signedIn) return refuse(401, "auth", "Unauthorized.")

  if (op === "start") {
    const model = body?.model
    if (typeof model !== "string" || !backendAcceptsModel("agent-service", model)) {
      return late(refuse(400, "unknown_model", `Tasks can't run ${String(model)}.`))
    }
    return late(Response.json({ runId: showStage(startAs) }, { status: 202 }))
  }

  if (op === "stream" || op === "children") {
    const request = new NextRequest(req.url, {
      headers: req.headers,
      signal: AbortSignal.any([req.signal, streams.signal]),
    })
    const route = op === "stream" ? streamRoute : childrenRoute
    return late(await route.GET(request, { params: Promise.resolve({ id }) }))
  }

  const row = rows.get(id)
  if (!row) return late(refuse(404, "not_found", "Run not found."))

  if (op === "cancel") {
    const targets = [row, ...[...rows.values()].filter((r) => r.parent_task_id === id)]
    for (const target of targets) if (!FINISHED.has(target.status as string)) target.status = "cancelled"
    return late(Response.json({ ok: true }))
  }

  if (op === "respond") {
    const key = `${id}:${String(body?.requestId)}`
    if (answered.has(key)) return late(refuse(409, "already_answered", "Already answered."))
    if (row.status !== "paused") return late(refuse(409, "invalid_state", "Run is not paused."))
    answered.add(key)
    return late(Response.json({ ok: true }, { status: 202 }))
  }

  return refuse(404, "not_found", url.pathname)
}

// idleTimeout 0: a paused task's stream is silent for minutes.
const server = serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: handle })
console.log(`tasks-backend ${server.url.origin}`)
