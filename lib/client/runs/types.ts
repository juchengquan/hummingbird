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

import type { components } from "@/shared/contract/openapi.generated"

type Schemas = components["schemas"]

/** Where a run request goes — `resolveRunsTarget()` in
 *  `lib/client/api/backend-resolver.ts`. */
export interface RunsTarget {
  /** agent-py's base URL (`""` = same origin, Q21). */
  baseUrl: string
  /** The Supabase session JWT (`Authorization: Bearer`), or `null` for an
   *  anonymous run, addressed by its `X-Run-Token` (Q20/Q34). */
  authToken: string | null
}

/** `POST /v1/runs` body — an AG-UI `RunAgentInput` (`build-input.ts`). */
export type StartRunRequest = Schemas["StartRunRequest"]
/** Hummingbird's options in `RunAgentInput.forwardedProps`. */
export type RunForwardedProps = Schemas["RunForwardedProps"]
/** The run resource (`GET /v1/runs/{id}`, `POST …/cancel`). */
export type Run = Schemas["Run"]
export type RunStatus = Schemas["RunStatus"]
/** `RUN_FINISHED.result` of a succeeded run (`text`, `memoryTainted`). */
export type RunResult = Schemas["RunResult"]
export type SkillConfig = Schemas["SkillConfig"]
/** A replay cursor: an SSE `id` (`<seq>` or `<seq>.<k>`), `"0"` = start. */
export type RunCursor = Schemas["RunCursor"]

export type { BaseEvent as AgUiEvent, Interrupt, Message as AgUiMessage, ResumeEntry }
