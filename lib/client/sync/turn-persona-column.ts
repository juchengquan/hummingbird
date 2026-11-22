import "client-only"

/**
 * `messages.turn_persona` is migration 0044. Against a database without
 * it PostgREST refuses the whole upsert and the sync queue would drop the
 * message, so the writers send it again without the column: the message
 * syncs, the record stays on this device.
 */

export function isMissingTurnPersonaColumn(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  return error?.code === "PGRST204" && (error.message ?? "").includes("'turn_persona'")
}

export function withoutTurnPersona<R>(row: R): R {
  const copy = { ...row } as R & { turn_persona?: unknown }
  delete copy.turn_persona
  return copy
}
