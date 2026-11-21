/**
 * Conformance harness: drives HTTP against any backend and checks each
 * response against packages/contract/openapi.yaml.
 *
 * Language-neutral by construction — it only speaks HTTP and reads the
 * spec, so agent-py, a future TypeScript backend, or anything else that
 * claims the contract runs the same cases (PLAN-frontend-backend-split
 * Q11). See ../README.md ("Conformance suite") for how to run it.
 *
 * Environment:
 *   CONTRACT_BASE_URL         backend origin, e.g. http://localhost:8765.
 *                             Unset → every conformance case is skipped.
 *   CONTRACT_AUTH_TOKEN       optional Supabase user JWT for cases that
 *                             need a signed-in caller (errors.test.ts).
 *   CONTRACT_SKIP_OPERATIONS  comma-separated operationIds to skip (an
 *                             operation the backend under test does not
 *                             implement yet).
 *
 * Operations the spec marks `x-planned` (specified, implemented in a
 * later wave) are skipped automatically — see `Operation.planned`. A
 * backend is "strictly" conformant when the suite passes with
 * CONTRACT_SKIP_OPERATIONS unset.
 *
 * Error bodies are always checked strictly: every 4xx/5xx JSON body must
 * validate against the operation's documented schema AND against
 * `ApiError` (`{ code, message }`). The transitional FastAPI `{ detail }`
 * envelope (and the `CONTRACT_STRICT_ERRORS` opt-in that used to reject
 * it) is gone.
 */
import { fileURLToPath } from "node:url"

import { bundle, loadConfig } from "@redocly/openapi-core"
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020"
import addFormats from "ajv-formats"

import { pathParams } from "./fixtures"

export const env = {
  baseUrl: process.env.CONTRACT_BASE_URL?.replace(/\/+$/, "") || null,
  authToken: process.env.CONTRACT_AUTH_TOKEN || null,
  skipOperations: new Set(
    (process.env.CONTRACT_SKIP_OPERATIONS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
}

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete"
const METHODS: readonly HttpMethod[] = ["get", "post", "put", "patch", "delete"]

type JsonSchema = Record<string, unknown>

interface ResponseObject {
  description?: string
  content?: Record<string, { schema?: JsonSchema }>
}

interface OperationObject {
  operationId: string
  /** Specified but not implemented yet; the value names the wave that
   *  implements it (e.g. `wave-3b`). Removed when it lands. */
  "x-planned"?: string
  security?: Record<string, string[]>[]
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> }
  responses: Record<string, ResponseObject>
}

export interface Operation {
  operationId: string
  method: HttpMethod
  path: string
  /** True when the operation requires a credential (every security
   *  requirement but an anonymous `{}` alternative counts). */
  secured: boolean
  /** The operation's `x-planned` marker, or null once it is implemented.
   *  Conformance cases skip planned operations. */
  planned: string | null
  raw: OperationObject
}

interface OpenApiDoc {
  security?: Record<string, string[]>[]
  paths: Record<string, Partial<Record<HttpMethod, OperationObject>>>
  components: { schemas: Record<string, JsonSchema> }
}

const SPEC_PATH = fileURLToPath(new URL("../openapi.yaml", import.meta.url))
const CONFIG_PATH = fileURLToPath(new URL("../redocly.yaml", import.meta.url))

/** The spec with every `$ref` inlined, so each schema stands alone. */
export async function loadSpec(): Promise<OpenApiDoc> {
  const config = await loadConfig({ configPath: CONFIG_PATH })
  const { bundle: doc, problems } = await bundle({ ref: SPEC_PATH, config, dereference: true })
  const errors = problems.filter((p) => p.severity === "error")
  if (errors.length > 0) {
    throw new Error(`openapi.yaml failed to bundle: ${errors.map((e) => e.message).join("; ")}`)
  }
  return stripAnchors(doc.parsed) as OpenApiDoc
}

/** Drops every `$anchor` from the dereferenced spec. Each AG-UI
 *  definition declares one (`"$anchor": "BaseMessage"`, …); once Redocly
 *  has inlined a definition at every place that references it, one
 *  schema can hold the same anchor several times, which Ajv rejects
 *  ("resolves to more than one schema"). Nothing refers to them any
 *  more — the contract references AG-UI by JSON pointer, and those refs
 *  are already resolved. Returns a copy; shared subtrees stay shared. */
function stripAnchors(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (Array.isArray(value)) {
    const hit = seen.get(value)
    if (hit) return hit
    const out: unknown[] = []
    seen.set(value, out)
    for (const item of value) out.push(stripAnchors(item, seen))
    return out
  }
  if (value && typeof value === "object") {
    const hit = seen.get(value)
    if (hit) return hit
    const out: Record<string, unknown> = {}
    seen.set(value, out)
    for (const [key, item] of Object.entries(value)) {
      if (key !== "$anchor") out[key] = stripAnchors(item, seen)
    }
    return out
  }
  return value
}

export function operations(spec: OpenApiDoc): Operation[] {
  const out: Operation[] = []
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method]
      if (!op) continue
      const security = op.security ?? spec.security ?? []
      out.push({
        operationId: op.operationId,
        method,
        path,
        secured: security.some((req) => Object.keys(req).length > 0),
        planned: op["x-planned"] ?? null,
        raw: op,
      })
    }
  }
  return out
}

/** OpenAPI's schema dialect is JSON Schema 2020-12 plus a few
 *  annotation keywords Ajv does not know. `$anchor` is listed because Ajv
 *  resolves anchors but its strict mode still rejects the keyword when a
 *  `$defs` member that carries one (every AG-UI definition) is compiled
 *  on its own. */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true })
  addFormats(ajv)
  ajv.addVocabulary(["discriminator", "xml", "externalDocs", "example", "$anchor"])
  return ajv
}

export class ConformanceError extends Error {}

export interface Exchange {
  status: number
  contentType: string | null
  body: unknown
  text: string
}

export class Contract {
  private readonly ajv = createAjv()
  private readonly byId: Map<string, Operation>
  private readonly cache = new Map<string, ValidateFunction>()

  constructor(readonly spec: OpenApiDoc) {
    this.byId = new Map(operations(spec).map((op) => [op.operationId, op]))
  }

  static async load(): Promise<Contract> {
    return new Contract(await loadSpec())
  }

  operation(operationId: string): Operation {
    const op = this.byId.get(operationId)
    if (!op) throw new ConformanceError(`operationId ${operationId} is not in openapi.yaml`)
    return op
  }

  all(): Operation[] {
    return [...this.byId.values()]
  }

  schema(name: string): JsonSchema {
    const s = this.spec.components.schemas[name]
    if (!s) throw new ConformanceError(`components.schemas.${name} is not in openapi.yaml`)
    return s
  }

  private validator(key: string, schema: JsonSchema): ValidateFunction {
    let v = this.cache.get(key)
    if (!v) {
      v = this.ajv.compile(schema)
      this.cache.set(key, v)
    }
    return v
  }

  /** Throws unless `ex` is a response the operation documents: the status
   *  is listed and the JSON body validates against that status's schema. */
  assertConforms(operationId: string, ex: Exchange): void {
    const op = this.operation(operationId)
    const label = `${op.method.toUpperCase()} ${op.path} (${operationId}) → ${ex.status}`
    const response =
      op.raw.responses[String(ex.status)] ??
      op.raw.responses[`${String(ex.status)[0]}XX`] ??
      op.raw.responses.default
    if (!response) {
      const hint = ex.status === 404 ? " — is the operation implemented?" : ""
      throw new ConformanceError(`${label}: status not documented${hint}\n${ex.text.slice(0, 500)}`)
    }
    const media = response.content?.["application/json"]
    if (!media?.schema) return
    if (!ex.contentType?.includes("application/json")) {
      throw new ConformanceError(`${label}: expected application/json, got ${ex.contentType}`)
    }
    const checks: [string, JsonSchema, string][] = [
      [`${operationId}#${ex.status}`, media.schema, "the schema"],
    ]
    // Every error body is an `ApiError`, whatever the response documents.
    if (ex.status >= 400) checks.push(["#ApiError", this.schema("ApiError"), "ApiError"])
    for (const [key, schema, name] of checks) {
      const validate = this.validator(key, schema)
      if (!validate(ex.body)) {
        throw new ConformanceError(
          `${label}: body does not match ${name}\n` +
            `${this.ajv.errorsText(validate.errors, { separator: "\n" })}\n` +
            `body: ${ex.text.slice(0, 500)}`,
        )
      }
    }
  }
}

/** One HTTP exchange with the backend under test. */
export async function call(
  op: Pick<Operation, "method" | "path">,
  opts: {
    body?: unknown
    token?: string | null
    headers?: Record<string, string>
    /** Overrides for `fixtures.ts` `pathParams`. */
    pathParams?: Record<string, string>
  } = {},
): Promise<Exchange> {
  if (!env.baseUrl) throw new ConformanceError("CONTRACT_BASE_URL is not set")
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers }
  if (opts.body !== undefined) headers["content-type"] = "application/json"
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const path = op.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = opts.pathParams?.[name] ?? pathParams[name]
    if (value === undefined) throw new ConformanceError(`no value for path parameter {${name}}`)
    return encodeURIComponent(value)
  })
  const res = await fetch(`${env.baseUrl}${path}`, {
    method: op.method.toUpperCase(),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(10_000),
  })
  const text = await res.text()
  let body: unknown = undefined
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  return { status: res.status, contentType: res.headers.get("content-type"), body, text }
}
