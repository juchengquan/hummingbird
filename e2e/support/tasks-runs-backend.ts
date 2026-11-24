/**
 * A fake agent-py `/v1/runs` and a fake Supabase (GoTrue + PostgREST), on
 * one origin, for the wire specs of the runs task UI (`tasks-wire.spec.ts`,
 * config `e2e/tasks-wire.config.ts`). Run with bun:
 * `bun e2e/support/tasks-runs-backend.ts <port>`.
 *
 * - `/auth/v1/**`: one signed-in user (the browser's session is seeded as
 *   a cookie by the spec, `sessionCookie`); `/user` and a refresh answer.
 * - `/rest/v1/**`: sync — reads are empty, writes are accepted and
 *   recorded (with their time), so a spec can check a conversation was
 *   pushed before the run that names it (bug 5).
 * - `/v1/runs/**`: the contract's runs API (0.5.0) over rows a spec sets
 *   (`Run` JSON) and streams served from agent-py's recorded background
 *   fixtures (`lib/client/runs/fixtures/agent-py/background/`), mapped
 *   per run id. Every request is recorded (`sent`).
 * - `POST /__control`: `reset`, `runs` (rows), `streams` (run id →
 *   fixture path), `startAs` (the row a start creates, `{ status, … }`),
 *   `fault` (`{ op, status, body }` once), `sent`.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { serve } from "bun"

import { USER_ID, session } from "./tasks-session"

const FIXTURES = join(import.meta.dir, "..", "..", "lib", "client", "runs", "fixtures", "agent-py")
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
  "access-control-expose-headers": "*",
}

type Row = Record<string, unknown>
interface Sent {
  op: string
  method: string
  path: string
  query: string
  body?: unknown
  at: number
}

let runs = new Map<string, Row>()
let streams = new Map<string, string>()
let startAs: Row = {}
let faults: { op: string; status: number; body?: unknown }[] = []
let sent: Sent[] = []

function reset() {
  runs = new Map()
  streams = new Map()
  startAs = {}
  faults = []
  sent = []
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } })
const refuse = (status: number, code: string, message: string) => json({ code, message }, status)

/** A contract `Run` with every required field, from a partial row. */
function run(patch: Row): Row {
  const now = new Date().toISOString()
  const id = (patch.id as string) ?? crypto.randomUUID()
  return {
    id,
    threadId: crypto.randomUUID(),
    mode: "background",
    status: "queued",
    parentRunId: null,
    previousRunId: null,
    openInterrupts: [],
    result: null,
    error: null,
    lastSeq: 0,
    goal: "Write the report",
    maxSteps: 25,
    step: 0,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    rootRunId: id,
    currentRunId: null,
    research: false,
    delivered: false,
    childrenAsking: 0,
    answerPending: false,
    ...patch,
  }
}

function listRuns(url: URL): Row[] {
  const q = url.searchParams
  return [...runs.values()].filter((r) => {
    if (q.get("mode") && r.mode !== q.get("mode")) return false
    if (q.get("topLevel") === "true" && r.parentRunId !== null) return false
    if (q.get("current") === "true" && r.currentRunId !== null) return false
    if (q.get("parentRunId") && r.parentRunId !== q.get("parentRunId")) return false
    if (q.get("rootRunId") && r.rootRunId !== q.get("rootRunId")) return false
    if (q.get("threadId") && r.threadId !== q.get("threadId")) return false
    const statuses = q.getAll("status")
    if (statuses.length && !statuses.includes(r.status as string)) return false
    return true
  })
}

function events(id: string): Response {
  const path = streams.get(id)
  if (!path) return refuse(404, "not_found", `no stream for ${id}`)
  const body = readFileSync(join(FIXTURES, path), "utf8")
  return new Response(body, { status: 200, headers: { ...CORS, "content-type": "text/event-stream" } })
}

async function control(req: Request): Promise<Response> {
  const { action, ...args } = await req.json()
  if (action === "reset") reset()
  else if (action === "runs") {
    for (const r of args.runs as Row[]) runs.set(r.id as string, run(r))
  } else if (action === "streams") streams = new Map(Object.entries(args.streams as Record<string, string>))
  else if (action === "startAs") startAs = args.row
  else if (action === "fault") faults.push(args)
  else if (action === "sent") return json(sent)
  else return refuse(400, "unknown_action", String(action))
  return json({ ok: true })
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  const url = new URL(req.url)
  if (url.pathname === "/__control") return control(req)
  let body: unknown
  if (req.method !== "GET" && req.method !== "HEAD") {
    const text = await req.text()
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
  }
  const record = (op: string) =>
    sent.push({ op, method: req.method, path: url.pathname, query: url.search, body, at: Date.now() })

  // --- Supabase ---
  if (url.pathname.startsWith("/auth/v1")) {
    record("auth")
    const user = { id: USER_ID, aud: "authenticated", role: "authenticated", email: "e2e@example.test", app_metadata: {}, user_metadata: {} }
    // Only a session's own token is a user (the anon key isn't).
    if (url.pathname.endsWith("/user")) {
      return bearerIsUser(req) ? json(user) : refuse(401, "no_authorization", "No user.")
    }
    if (url.pathname.endsWith("/token")) return json(session())
    if (url.pathname.endsWith("/logout")) return new Response(null, { status: 204, headers: CORS })
    return json({})
  }
  if (url.pathname.startsWith("/rest/v1")) {
    record(`rest:${url.pathname.slice("/rest/v1/".length)}`)
    // `.single()` asks for one object: there is none (PGRST116).
    if ((req.headers.get("accept") ?? "").includes("vnd.pgrst.object")) {
      return json({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, 406)
    }
    if (req.method === "GET" || req.method === "HEAD") return json([])
    if (url.pathname.includes("/rpc/")) return json(null)
    return json([], 201)
  }

  // --- /v1/runs ---
  const m = url.pathname.match(/^\/v1\/runs(?:\/([^/]+)(?:\/([a-z]+))?)?$/)
  if (!m) return refuse(404, "not_found", url.pathname)
  const [, id, action] = m
  const op = id ? (action ?? "get") : req.method === "POST" ? "start" : "list"
  record(op)
  const fault = faults.find((f) => f.op === op)
  if (fault) {
    faults = faults.filter((f) => f !== fault)
    return json(fault.body ?? { code: "provider", message: "e2e failure" }, fault.status)
  }
  if (op === "list") return json({ runs: listRuns(url), nextPageToken: null })
  if (op === "start") {
    const input = body as { runId: string; threadId: string; forwardedProps?: Row }
    const created = run({
      id: input.runId,
      threadId: input.threadId,
      goal: "Write the report",
      research: !!input.forwardedProps?.research,
      ...startAs,
    })
    runs.set(created.id as string, created)
    return json(created, 202)
  }
  const row = runs.get(id!)
  if (!row) return refuse(404, "not_found", "Run not found.")
  if (op === "get") return json(row)
  if (op === "events") return events(id!)
  if (op === "cancel") {
    for (const r of runs.values()) {
      const inTask = r.id === id || r.parentRunId === id || (row.parentRunId === null && r.rootRunId === id)
      if (inTask && !["succeeded", "failed", "cancelled"].includes(r.status as string)) r.status = "cancelled"
    }
    return json(runs.get(id!))
  }
  if (op === "answers") {
    if (row.parentRunId === null) return refuse(409, "invalid_state", "Not a sub-agent run.")
    if (row.answerPending) return refuse(409, "run_already_answered", "Already answered.")
    row.answerPending = true
    return json(row, 202)
  }
  if (op === "delivered") {
    for (const r of runs.values()) if (r.rootRunId === id) r.delivered = true
    return new Response(null, { status: 204, headers: CORS })
  }
  return refuse(404, "not_found", url.pathname)
}

function bearerIsUser(req: Request): boolean {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "")
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()).sub === USER_ID
  } catch {
    return false
  }
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 0)
  const server = serve({ port, hostname: "127.0.0.1", idleTimeout: 0, fetch: handle })
  console.log(`tasks-runs-backend ${server.url.origin}`)
}
