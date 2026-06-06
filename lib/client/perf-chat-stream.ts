import "client-only"

/**
 * Cheap, opt-in instrumentation for the chat-stream hot path.
 *
 * Off by default. Enable with `NEXT_PUBLIC_PERF_CHAT_STREAM=1` in
 * `.env.local`, or by setting `window.__hummPerf = true` in DevTools.
 * When enabled, the helper exposes:
 *
 *  - `mark(name)` / `measure(name, start, end)` — pass-throughs that
 *    skip themselves when disabled, so call sites stay one line.
 *  - `count(label, n)` — `console.count(label)`-style counter; prints
 *    the running total every 64 calls.
 *  - A PerformanceObserver that, on a 1 s cadence, prints a one-line
 *    summary of the last second's worth of streaming-related
 *    measures: p50, p95, max, count, total ms. Single line, easy to
 *    diff while you tweak.
 *
 * Marks/measure names used in the codebase:
 *  - `humm/chat/append-message`     — entire `appendToMessage` slice updater
 *  - `humm/chat/append-reasoning`   — `appendToMessageReasoning` slice updater
 *  - `humm/chat/persist-debounce-flush` — actual `localStorage.setItem` after coalesce
 *  - `humm/chat/render-message`     — entry to `ChatMessageImpl`
 *  - `humm/chat/markdown-parse`     — `marked.parse` + decoration in `MarkdownPreview`
 *
 * To turn off in production builds, ship with the env var unset —
 * `enabled` resolves to `false` at module-eval time so the marks
 * collapse to a no-op (the `if (!enabled) return` guard is the only
 * per-call cost, and the function call gets trivially DCE'd by V8).
 */

const envFlag =
  typeof process !== "undefined" &&
  process.env.NEXT_PUBLIC_PERF_CHAT_STREAM === "1"

let runtimeFlag = false
if (typeof window !== "undefined") {
  // Allow DevTools to flip on at runtime without a reload.
  Object.defineProperty(window, "__hummPerf", {
    configurable: true,
    get() {
      return runtimeFlag
    },
    set(v: boolean) {
      const wasEnabled = enabled()
      runtimeFlag = !!v
      if (!wasEnabled && enabled()) installObserver()
    },
  })
}

function enabled(): boolean {
  return envFlag || runtimeFlag
}

export function mark(name: string): void {
  if (!enabled()) return
  if (typeof performance === "undefined") return
  try {
    performance.mark(name)
  } catch {
    // Two marks with the same name throw in spec-compliant impls.
    // Drop and continue — the cost of uniqueness is not worth it.
  }
}

export function measure(
  name: string,
  startMark: string,
  endMark: string,
): void {
  if (!enabled()) return
  if (typeof performance === "undefined") return
  try {
    performance.measure(name, startMark, endMark)
  } catch {
    // Marks may be missing if disabled mid-stream. Ignore.
  }
}

const counters = new Map<string, { total: number; sinceLastPrint: number }>()
export function count(label: string, by = 1): void {
  if (!enabled()) return
  let c = counters.get(label)
  if (!c) {
    c = { total: 0, sinceLastPrint: 0 }
    counters.set(label, c)
  }
  c.total += by
  c.sinceLastPrint += by
  if (c.sinceLastPrint >= 64) {
    console.info(`[humm-perf] ${label}: ${c.total} total (+${c.sinceLastPrint})`)
    c.sinceLastPrint = 0
  }
}

let observerInstalled = false
function installObserver(): void {
  if (observerInstalled) return
  if (typeof PerformanceObserver === "undefined") return
  observerInstalled = true

  const TRACKED = [
    "humm/chat/append-message",
    "humm/chat/append-reasoning",
    "humm/chat/persist-debounce-flush",
    "humm/chat/render-message",
    "humm/chat/markdown-parse",
  ]

  // Map<entryType, Map<name, number[]>> — last second's samples
  const samples = new Map<string, Map<string, number[]>>()

  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!TRACKED.includes(entry.name)) continue
        let byName = samples.get(entry.entryType)
        if (!byName) {
          byName = new Map()
          samples.set(entry.entryType, byName)
        }
        let arr = byName.get(entry.name)
        if (!arr) {
          arr = []
          byName.set(entry.name, arr)
        }
        arr.push(entry.duration)
      }
    })
    po.observe({ entryTypes: ["measure", "mark"] })
  } catch {
    return
  }

  setInterval(() => {
    if (!enabled()) return
    const lines: string[] = []
    for (const [, byName] of samples) {
      for (const [name, arr] of byName) {
        if (arr.length === 0) continue
        const sorted = arr.slice().sort((a, b) => a - b)
        const p50 = sorted[Math.floor(sorted.length * 0.5)]
        const p95 = sorted[Math.floor(sorted.length * 0.95)]
        const max = sorted[sorted.length - 1]
        const total = sorted.reduce((s, v) => s + v, 0)
        lines.push(
          `${name.replace("humm/chat/", "")}: n=${arr.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms Σ=${total.toFixed(1)}ms`,
        )
        arr.length = 0
      }
    }
    if (lines.length > 0) {
      console.info(`[humm-perf] last 1s — ${lines.join(" | ")}`)
    }
  }, 1000)
}

// Auto-install when the env var is on at module-eval time.
if (enabled()) installObserver()
