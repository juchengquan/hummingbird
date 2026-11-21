/**
 * Cron parity fixture for the agent-py scheduler port.
 *
 * agent-py re-implements `nextRunFromCron` / `validateScheduleCron` /
 * `cronPassesCoarseGuard` in Python (`services/agent-py/src/agent_py/cron.py`
 * + `schedules.py`), and both backends write and fire the same
 * `task_schedules` rows while the Vercel Cron and the agent-py scheduler
 * overlap. This file is the TypeScript half of the parity proof: it runs
 * the real TS functions (and cron-parser, for fire sequences) over a fixed
 * table of (cron, timezone, instant) cases — DST edges in many zones, month
 * ends, steps / ranges / lists / names / `L` / `#`, invalid crons and zones,
 * and a seeded fuzz set — and compares the result with the committed
 * fixture `services/agent-py/tests/fixtures/cron_parity.json`, which
 * `services/agent-py/tests/test_cron_parity.py` replays against the Python
 * port.
 *
 * A failure here means cron-parser's behaviour (or the case table) changed:
 * regenerate the fixture, then make the Python tests pass again.
 *
 *   CRON_PARITY_WRITE=1 bun test lib/server/agent/schedules.parity.test.ts
 *
 * Excluded on purpose: `H` (hashed) fields — random per parse without a
 * `hashSeed`, on both sides — and the `local` / `system` zone, which
 * depends on the machine's TZ.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "bun:test"
import { CronExpressionParser } from "cron-parser"

import { cronPassesCoarseGuard, nextRunFromCron, validateScheduleCron } from "./schedules"

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../services/agent-py/tests/fixtures/cron_parity.json", import.meta.url),
)

interface CronCase {
  cron: string
  tz: string
  after: string
  /** Up to `n` consecutive fires (epoch ms); `error` when parse or an iteration threw. */
  fires: number[]
  error: boolean
  /** `validateScheduleCron` → "ok" (its `next` is `fires[0]`) or the failure
   *  message. `null` = not evaluated: the cron is sparse (its fires span
   *  more than `VALIDATE_MAX_SPAN_MS`), so the 48-fire gap scan is slow
   *  and can only fail on the coarse guard, which `coarse` covers — or
   *  the case pins a slow quirk (Lord Howe, see below). */
  validate: string | null
}

interface ParityFixture {
  note: string
  cronParser: string
  cases: CronCase[]
  coarse: { cron: string; ok: boolean }[]
}

const VALIDATE_MAX_SPAN_MS = 120 * 86_400_000

function fireSequence(cron: string, tz: string, after: Date, n: number) {
  const fires: number[] = []
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: after, tz })
    for (let i = 0; i < n; i++) fires.push(it.next().toDate().getTime())
    return { fires, error: false }
  } catch {
    return { fires, error: true }
  }
}

function evaluate(
  cron: string,
  tz: string,
  afterIso: string,
  n: number,
  withValidate = true,
): CronCase {
  const after = new Date(afterIso)
  const { fires, error } = fireSequence(cron, tz, after, n)
  const first = nextRunFromCron(cron, tz, after)
  // nextRunFromCron is the first fire of the same iterator.
  if ((first?.getTime() ?? null) !== (fires[0] ?? null)) {
    throw new Error(`nextRunFromCron disagrees with the sequence for ${cron} @ ${tz}`)
  }
  const sparse = fires.length > 0 && fires[fires.length - 1] - after.getTime() > VALIDATE_MAX_SPAN_MS
  let validate: string | null = null
  if (withValidate && !sparse) {
    const v = validateScheduleCron(cron, tz, after)
    if (v.ok && v.next.getTime() !== fires[0]) {
      throw new Error(`validateScheduleCron.next disagrees for ${cron} @ ${tz}`)
    }
    validate = v.ok ? "ok" : v.message
  }
  return { cron, tz, after: afterIso, fires, error, validate }
}

// mulberry32 — a fixed seed keeps the fuzz section stable.
function prng(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DST_ZONES: { tz: string; transitions: string[] }[] = [
  // Approximate UTC instants of the 2026 transitions; cases sample around them.
  { tz: "America/New_York", transitions: ["2026-03-08T07:00:00Z", "2026-11-01T06:00:00Z"] },
  { tz: "America/Los_Angeles", transitions: ["2026-03-08T10:00:00Z", "2026-11-01T09:00:00Z"] },
  { tz: "Europe/London", transitions: ["2026-03-29T01:00:00Z", "2026-10-25T01:00:00Z"] },
  { tz: "Europe/Berlin", transitions: ["2026-03-29T01:00:00Z", "2026-10-25T01:00:00Z"] },
  { tz: "Australia/Sydney", transitions: ["2026-04-04T16:00:00Z", "2026-10-03T16:00:00Z"] },
  { tz: "Australia/Lord_Howe", transitions: ["2026-10-03T15:30:00Z"] },
  { tz: "America/Santiago", transitions: ["2026-04-05T03:00:00Z", "2026-09-06T04:00:00Z"] },
  { tz: "Pacific/Chatham", transitions: ["2026-04-04T14:00:00Z", "2026-09-26T14:00:00Z"] },
  { tz: "America/Havana", transitions: ["2026-03-08T05:00:00Z", "2026-11-01T05:00:00Z"] },
  { tz: "Asia/Gaza", transitions: ["2026-03-27T22:00:00Z", "2026-10-23T22:00:00Z"] },
]

const DST_CRONS = [
  "30 2 * * *",
  "0 2 * * *",
  "0 1 * * *",
  "30 1 * * *",
  "0 3 * * *",
  "0 0 * * *",
  "*/5 * * * *",
  "*/30 * * * *",
  "15 */2 * * *",
  "0,30 0-3 * * *",
  "45 23 * * *",
  "0 2,3 * * *",
]

const GENERAL_CRONS = [
  "*/5 * * * *",
  "0 8 * * *",
  "0,30 * * * *",
  "15 */2 * * *",
  "0 9-17 * * 1-5",
  "0 9 * * MON-FRI",
  "0 9 * * mon,wed,fri",
  "0 0 1 jan,jul *",
  "0 0 1 */3 *",
  "0 0 L * *",
  "0 0 31 * *",
  "0 0 29 2 *",
  "0 0 30 2 *",
  "0 12 1,15 * *",
  "0 12 15 * 1",
  "0 12 * * 5L",
  "0 12 * * 1#2",
  "0 12 * * 0#5",
  "5-55/10 * * * *",
  "0 0 * * 7",
  "0 0 * * 0-7",
  "0 0 * * 5-7",
  "*/10 1-3 * * *",
  "0 */6 * * *",
  "59 23 31 12 *",
  "0 0 ? * *",
  "0 0 L 2 *",
  "0,0 * * * *",
  "0 0,0 * * *",
  "0,5,10,15,20,25,30,35,40,45,50,55 * * * *",
  "0-59/5 * * * *",
  "7/5 * * * *",
  "3-58/5 * * * *",
  "0,1 * * * *",
  "0,4 * * * *",
  "0,5 * * * *",
  "*/4 * * * *",
  "* * * * *",
  "*/15 * * * *",
  "0 0 * * L",
  "0 0 * * 1L",
  "0 0 1-7 * 1",
  "0 0 * 2 *",
  "0 22 * * 0",
  // invalid / odd
  "",
  "   ",
  "abc",
  "* * * *",
  "0 8 * *",
  "* * * * * * *",
  "0 0 0 * * *",
  "60 * * * *",
  "0 24 * * *",
  "0 0 32 * *",
  "0 0 0 * *",
  "0 0 * 13 *",
  "0 0 * 0 *",
  "0 0 * * 8",
  "*/0 * * * *",
  "1-60 * * * *",
  "5-3 * * * *",
  "5,5 * * * *",
  "0 0 15W * *",
  "0 0 * * 1#6",
  "0 0 * * 1#2,3",
  "0 0 * * 1#0",
  "0 0 * * monday",
  "0 0 * foo *",
  "@daily",
  "@hourly",
  "/5 * * * *",
  "5/ * * * *",
  "1/2/3 * * * *",
  "1,,2 * * * *",
  ", * * * *",
  "- * * * *",
  "0 0 * * sun",
  "0 0 1 sun *",
  "0 0\t8 * *",
]

const GENERAL_ZONES = [
  "UTC",
  "utc",
  "GMT",
  "America/New_York",
  "america/new_york",
  "Europe/London",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Australia/Sydney",
  "Pacific/Chatham",
  "America/St_Johns",
  "Asia/Tehran",
  "Pacific/Apia",
  "Pacific/Kiritimati",
  "US/Pacific",
  "Etc/GMT+5",
  "EST5EDT",
  "+05:30",
  "-0300",
  "+09",
  "UTC+3",
  "utc-05:30",
  "Bogus/Zone",
  "",
  "+5:00",
]

const GENERAL_INSTANTS = [
  "2026-01-31T12:00:00.000Z",
  "2026-02-28T23:59:59.999Z",
  "2026-03-08T06:30:00.000Z",
  "2026-05-30T08:00:00.000Z",
  "2026-05-30T08:00:00.500Z",
  "2026-10-31T22:17:42.123Z",
  "2026-12-31T23:59:59.999Z",
  "2028-02-28T12:00:00.000Z",
]

const FUZZ_ZONES = [
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/Berlin",
  "Europe/London",
  "Australia/Sydney",
  "America/Santiago",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Pacific/Chatham",
  "Africa/Casablanca",
  "America/Sao_Paulo",
  "Asia/Tokyo",
]

function fuzzField(r: () => number, min: number, max: number, names?: string[]): string {
  const pick = (a: number, b: number) => a + Math.floor(r() * (b - a + 1))
  const atom = (): string => {
    const k = r()
    if (k < 0.2) return "*"
    if (k < 0.45) return String(pick(min, max))
    if (k < 0.6 && names) return names[pick(0, names.length - 1)]
    if (k < 0.75) {
      const a = pick(min, max)
      return `${a}-${pick(a, max)}`
    }
    if (k < 0.9) return `${r() < 0.5 ? "*" : pick(min, max)}/${pick(1, Math.max(1, max - min))}`
    const a = pick(min, max)
    return `${a}-${pick(a, max)}/${pick(1, 7)}`
  }
  const n = r() < 0.7 ? 1 : pick(2, 3)
  const atoms = Array.from({ length: n }, atom)
  return atoms.includes("*") && n > 1 ? atoms.filter((a) => a !== "*").join(",") || "*" : atoms.join(",")
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

function fuzzCron(r: () => number): string {
  const minute = r() < 0.5 ? String(Math.floor(r() * 60)) : fuzzField(r, 0, 59)
  const hour = fuzzField(r, 0, 23)
  let dom = r() < 0.6 ? "*" : fuzzField(r, 1, 31)
  if (r() < 0.05) dom = "L"
  const month = r() < 0.7 ? "*" : fuzzField(r, 1, 12, MONTH_NAMES)
  let dow = r() < 0.6 ? "*" : fuzzField(r, 0, 7, DAY_NAMES)
  const special = r()
  if (special < 0.04) dow = `${Math.floor(r() * 7)}L`
  else if (special < 0.08) dow = `${Math.floor(r() * 7)}#${1 + Math.floor(r() * 5)}`
  return `${minute} ${hour} ${dom} ${month} ${dow}`
}

/** One case per line: reviewable diffs without a megabyte of indentation. */
function serialize(fixture: ParityFixture): string {
  const lines = (items: unknown[]) => items.map((c) => `  ${JSON.stringify(c)}`).join(",\n")
  return (
    `{\n "note": ${JSON.stringify(fixture.note)},\n "cronParser": ${JSON.stringify(fixture.cronParser)},\n` +
    ` "cases": [\n${lines(fixture.cases)}\n ],\n "coarse": [\n${lines(fixture.coarse)}\n ]\n}\n`
  )
}

function buildFixture(): ParityFixture {
  const cases: CronCase[] = []

  // 1. DST transitions: hour-sensitive crons sampled around each transition.
  for (const { tz, transitions } of DST_ZONES) {
    for (const t of transitions) {
      const base = Date.parse(t)
      for (const k of [-3, -1, 0, 1]) {
        const after = new Date(base + k * 53 * 60_000).toISOString()
        for (const cron of DST_CRONS) cases.push(evaluate(cron, tz, after, 4))
      }
    }
  }

  // Lord Howe's 30-minute fall-back: cron-parser's DST handling assumes
  // whole-hour shifts and runs into its 10 000-step loop limit around it,
  // returning whatever date it reached (~130 ms per fire). Pin that quirk
  // with a few short sequences; no 48-fire validation (seconds per case).
  for (const k of [-3, -1, 0, 1]) {
    const after = new Date(Date.parse("2026-04-04T15:00:00Z") + k * 53 * 60_000).toISOString()
    for (const cron of ["0 1 * * *", "0 2 * * *", "30 1 * * *", "*/30 * * * *"]) {
      cases.push(evaluate(cron, "Australia/Lord_Howe", after, 2, false))
    }
  }

  // 2. Hand-picked crons × zones × instants (month ends, leap day, ms).
  // Each cron meets 7 of the zones (rotating) at a rotating instant.
  for (const [ci, cron] of GENERAL_CRONS.entries()) {
    for (let j = 0; j < 7; j++) {
      const tz = GENERAL_ZONES[(ci * 7 + j) % GENERAL_ZONES.length]
      const after = GENERAL_INSTANTS[(ci + j) % GENERAL_INSTANTS.length]
      cases.push(evaluate(cron, tz, after, 5))
    }
  }
  for (const after of GENERAL_INSTANTS) {
    for (const cron of ["0 0 L * *", "0 0 29 2 *", "0 12 * * 5L", "0 8 * * *", "*/5 * * * *"]) {
      cases.push(evaluate(cron, "America/New_York", after, 6))
    }
  }

  // 3. Seeded fuzz.
  const r = prng(20261121)
  const start = Date.parse("2026-01-01T00:00:00Z")
  const span = Date.parse("2030-12-31T00:00:00Z") - start
  for (let i = 0; i < 400; i++) {
    const cron = fuzzCron(r)
    const tz = FUZZ_ZONES[Math.floor(r() * FUZZ_ZONES.length)]
    const after = new Date(start + Math.floor(r() * span)).toISOString()
    cases.push(evaluate(cron, tz, after, 3))
  }

  const coarseInputs = [
    ...new Set([
      ...GENERAL_CRONS,
      ...DST_CRONS,
      " */5 * * * * ",
      "*/5  *  * * *",
      "0,5,10,15,20,25,30,35,40,45,50,55,59 * * * *",
      "00,05 * * * *",
      "*/60 * * * *",
      "*/59 * * * *",
      "5-10/5 * * * *",
      "60/5 * * * *",
      "5 * * * *\n",
      "5 * * * *",
    ]),
  ]
  const coarse = coarseInputs.map((cron) => ({ cron, ok: cronPassesCoarseGuard(cron) }))

  return {
    note:
      "Generated by lib/server/agent/schedules.parity.test.ts from the TS schedule functions " +
      "(cron-parser). Do not edit; regenerate with CRON_PARITY_WRITE=1 bun test " +
      "lib/server/agent/schedules.parity.test.ts.",
    cronParser: "5.5.0",
    cases,
    coarse,
  }
}

describe("cron parity fixture (agent-py port)", () => {
  test(
    "committed fixture matches what the TS schedule functions compute",
    () => {
      const fixture = buildFixture()
      if (process.env.CRON_PARITY_WRITE === "1") {
        writeFileSync(FIXTURE_PATH, serialize(fixture))
      }
      const committed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ParityFixture
      expect(committed).toEqual(fixture)
    },
    { timeout: 120_000 },
  )

  test("pins the cron-parser version the fixture was generated with", async () => {
    const pkg = (await import("cron-parser/package.json")) as { version: string }
    expect(pkg.version).toBe("5.5.0")
  })
})
