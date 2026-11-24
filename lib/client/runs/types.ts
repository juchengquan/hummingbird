import "client-only"

/**
 * Shared types of the runs client (`lib/client/runs/`). Type-only, so
 * `backend-resolver.ts` and `api-client.ts` can name them without pulling
 * the runs transport (or `@ag-ui/client`'s rxjs) into their bundles.
 *
 * Wire shapes come from the contract (`packages/contract/openapi.yaml`,
 * generated into `lib/shared/contract/openapi.generated.ts`) and from
 * AG-UI 1.0 (`@ag-ui/core`, the same version the contract pins).
 */

import type { BaseEvent, Interrupt, Message, ResumeEntry } from "@ag-ui/core"

import type { components, operations } from "@/shared/contract/openapi.generated"

type Schemas = components["schemas"]

/** Where a run request goes — `resolveRunsTarget()` in
 *  `lib/client/api/backend-resolver.ts`. */
export interface RunsTarget {
  /** agent-py's base URL (`""` = same origin, Q21). */
  baseUrl: string
  /** The Supabase session JWT (`Authorization: Bearer`), or `null` for an
   *  anonymous run, addressed by its `X-Run-Token` (Q20/Q34). */
  authToken: string | null
  /** The signed-in session's current JWT, read again for every request
   *  (a long watch outlives the token it started with — survey bug 19);
   *  `refresh: true` after a `401`, to force a new one. Absent: `authToken`
   *  is used as is. Never consulted for an anonymous target
   *  (`authToken: null`). */
  getAuthToken?: (refresh?: boolean) => Promise<string | null>
}

/** `POST /v1/runs` body — an AG-UI `RunAgentInput` (`build-input.ts`). */
export type StartRunRequest = Schemas["StartRunRequest"]
/** Hummingbird's options in `RunAgentInput.forwardedProps`. */
export type RunForwardedProps = Schemas["RunForwardedProps"]
/** The run resource (`GET /v1/runs/{id}`, `POST …/cancel`). Contract
 *  0.5.0 adds the task fields: `rootRunId`, `currentRunId`, `research`,
 *  `delivered`, `childrenAsking`, `answerPending` (RUN_EVENTS.md § 4.5). */
export type Run = Schemas["Run"]
/** One page of `GET /v1/runs`. */
export type RunList = Schemas["RunList"]
/** `GET /v1/runs` query: `threadId`, `status[]`, `parentRunId`, `mode`, the
 *  0.5.0 task filters `topLevel` / `current` / `rootRunId` / `delivered`
 *  (absent: no filter; `false`: the opposite set), `pageSize`, `pageToken`. */
export type ListRunsQuery = NonNullable<operations["listRuns"]["parameters"]["query"]>
/** `POST /v1/runs/{id}/answers` body — a sub-agent run's question answered
 *  in place (`answerRun`, Q59, RUN_EVENTS.md § 4.4). */
export type AnswerRunRequest = Schemas["AnswerRunRequest"]
export type RunStatus = Schemas["RunStatus"]
/** `RUN_FINISHED.result` of a succeeded run (`text`, `memoryTainted`). */
export type RunResult = Schemas["RunResult"]
export type SkillConfig = Schemas["SkillConfig"]
/** One source attached to a turn (`forwardedProps.attachments`, Q44). */
export type RunAttachment = Schemas["RunAttachment"]
/** The I2I reference of a turn (`forwardedProps.referenceImage`). */
export type RunReferenceImage = Schemas["RunReferenceImage"]
/** A local-mode MCP server, without its credential (`forwardedProps.localMcpServers`). */
export type LocalMcpServer = Schemas["LocalMcpServer"]
/** One local MCP server's credential. */
export type LocalMcpCredential = Schemas["LocalMcpCredential"]
/** `state["hummingbird.localMcp"]`: server id → credential (Q45). */
export type LocalMcpCredentials = Schemas["LocalMcpCredentials"]
/** A replay cursor: an SSE `id` (`<seq>` or `<seq>.<k>`), `"0"` = start. */
export type RunCursor = Schemas["RunCursor"]

export type { BaseEvent as AgUiEvent, Interrupt, Message as AgUiMessage, ResumeEntry }
