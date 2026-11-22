"use client"
import "client-only"

/**
 * A task's sub-agents as the server has them: status, and the open
 * question of one that waits on the user (Q59). Polled — a child's pause
 * writes nothing to its parent's log.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { apiClient } from "@/client/api-client"
import { isTerminalStatus, type RunStatus } from "@/shared/agent/events"
import type { TaskChild } from "@/shared/api-schemas"

const POLL_MS = 2000

export interface ChildRuns {
  rows: TaskChild[]
  /** The children waiting on the user, each with its question. */
  asking: TaskChild[]
  /** Some child hasn't ended: the parent waits for it. */
  waiting: boolean
  /** The last read failed; `rows` are the ones before it. */
  stale: boolean
  skipping: ReadonlySet<string>
  /** Cancel one child: the parent carries on with the others (Q60). */
  skip: (childId: string) => Promise<void>
  refresh: () => void
}

const NONE: TaskChild[] = []

export function useChildRuns(
  parentId: string | null,
  live: boolean,
  spawned: number
): ChildRuns {
  const [read, setRead] = useState<{ parentId: string; rows: TaskChild[]; stale: boolean } | null>(
    null
  )
  const [skipping, setSkipping] = useState<ReadonlySet<string>>(new Set())
  // Reads can finish out of order: one older than what's shown is dropped.
  const issuedRef = useRef(0)
  const shownRef = useRef(0)

  const load = useCallback(async (id: string) => {
    const issued = ++issuedRef.current
    const rows = await apiClient.tasks.listTaskChildren(id)
    if (issued < shownRef.current) return
    shownRef.current = issued
    setRead((prev) => {
      const kept = prev?.parentId === id ? prev.rows : NONE
      return { parentId: id, rows: rows ?? kept, stale: rows === null }
    })
  }, [])

  const watched = live && spawned > 0 ? parentId : null
  useEffect(() => {
    if (!watched) return
    void load(watched)
    const timer = setInterval(() => void load(watched), POLL_MS)
    return () => {
      clearInterval(timer)
      // What's in flight is for a watch that's over.
      shownRef.current = issuedRef.current + 1
      issuedRef.current += 1
    }
  }, [watched, spawned, load])

  const refresh = useCallback(() => {
    if (watched) void load(watched)
  }, [watched, load])

  const skip = useCallback(
    async (childId: string) => {
      setSkipping((prev) => new Set(prev).add(childId))
      let failure: string | null = null
      try {
        const res = await apiClient.tasks.cancel(childId)
        if (!res.ok) failure = res.error?.message ?? `HTTP ${res.status}.`
      } catch {
        failure = "Couldn't reach the server."
      }
      if (failure) {
        toast.error(`Couldn't skip the sub-agent: ${failure}`)
      } else {
        // Reads issued before this would show it still waiting.
        shownRef.current = ++issuedRef.current
        setRead((prev) =>
          prev && {
            ...prev,
            rows: prev.rows.map((row) =>
              row.id === childId && !isTerminalStatus(row.status as RunStatus)
                ? { ...row, status: "cancelled", pendingInput: null }
                : row
            ),
          }
        )
      }
      setSkipping((prev) => {
        const next = new Set(prev)
        next.delete(childId)
        return next
      })
      refresh()
    },
    [refresh]
  )

  const shown = read && read.parentId === watched ? read : null
  return useMemo(() => {
    const rows = shown?.rows ?? NONE
    return {
      rows,
      asking: rows.filter((row) => row.status === "paused" && row.pendingInput),
      waiting: rows.some((row) => !isTerminalStatus(row.status as RunStatus)),
      stale: shown?.stale ?? false,
      skipping,
      skip,
      refresh,
    }
  }, [shown, skipping, skip, refresh])
}
