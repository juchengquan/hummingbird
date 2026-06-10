import { describe, expect, test } from "bun:test"

import {
  InfoTablePropsSchema,
  UI_KIND_VALUES,
  UiKindEnum,
  UiPartSchema,
  parsePersistedUiPart,
} from "./schemas"

describe("UiKindEnum", () => {
  test("accepts every value in UI_KIND_VALUES", () => {
    for (const v of UI_KIND_VALUES) {
      expect(UiKindEnum.safeParse(v).success).toBe(true)
    }
  })
  test("rejects unknown kinds", () => {
    expect(UiKindEnum.safeParse("choice").success).toBe(false)
    expect(UiKindEnum.safeParse("").success).toBe(false)
  })
})

describe("InfoTablePropsSchema", () => {
  test("simple key/value list — no columns", () => {
    const r = InfoTablePropsSchema.safeParse({
      title: "Order details",
      rows: [
        { key: "Order ID", value: "A-1234" },
        { key: "Status", value: "Shipped" },
      ],
    })
    expect(r.success).toBe(true)
  })

  test("columnar layout — columns + rows", () => {
    const r = InfoTablePropsSchema.safeParse({
      title: "Revenue by segment",
      columns: [
        { id: "segment", label: "Segment" },
        { id: "yoy", label: "YoY" },
      ],
      rows: [
        { segment: "Cloud", yoy: "+18%" },
        { segment: "Consumer", yoy: "+8%" },
      ],
    })
    expect(r.success).toBe(true)
  })

  test("rejects > 6 columns (over-busy table belongs in an artifact)", () => {
    const r = InfoTablePropsSchema.safeParse({
      columns: Array.from({ length: 7 }, (_, i) => ({
        id: `c${i}`,
        label: `Col${i}`,
      })),
      rows: [],
    })
    expect(r.success).toBe(false)
  })

  test("rejects > 50 rows (the cap)", () => {
    const r = InfoTablePropsSchema.safeParse({
      rows: Array.from({ length: 51 }, (_, i) => ({
        key: `K${i}`,
        value: "v",
      })),
    })
    expect(r.success).toBe(false)
  })

  test("rejects a row cell that's not a string", () => {
    const r = InfoTablePropsSchema.safeParse({
      rows: [{ key: "x", value: 42 as unknown as string }],
    })
    expect(r.success).toBe(false)
  })

  test("allows zero rows (empty table renders an empty body)", () => {
    const r = InfoTablePropsSchema.safeParse({ rows: [] })
    expect(r.success).toBe(true)
  })
})

describe("UiPartSchema (discriminated union)", () => {
  test("accepts a well-formed info-table", () => {
    const r = UiPartSchema.safeParse({
      kind: "info-table",
      props: { rows: [{ key: "k", value: "v" }] },
    })
    expect(r.success).toBe(true)
  })

  test("rejects unknown kind (allow-list IS the security boundary)", () => {
    const r = UiPartSchema.safeParse({
      kind: "choice", // not in v1's allow-list
      props: { prompt: "?", options: [] },
    })
    expect(r.success).toBe(false)
  })

  test("rejects valid kind + malformed props", () => {
    const r = UiPartSchema.safeParse({
      kind: "info-table",
      props: { rows: "oops" },
    })
    expect(r.success).toBe(false)
  })
})

describe("parsePersistedUiPart", () => {
  test("round-trips a well-formed persisted part", () => {
    const persisted = {
      id: "p-1",
      kind: "info-table" as const,
      props: { rows: [{ k: "v" }] },
    }
    const out = parsePersistedUiPart(persisted)
    expect(out).not.toBeNull()
    expect(out!.id).toBe("p-1")
    expect(out!.kind).toBe("info-table")
  })

  test("preserves answeredAt when present", () => {
    const out = parsePersistedUiPart({
      id: "p-2",
      kind: "info-table",
      props: { rows: [] },
      answeredAt: "2026-06-10T00:00:00Z",
    })
    expect(out?.answeredAt).toBe("2026-06-10T00:00:00Z")
  })

  test("returns null on missing id", () => {
    expect(
      parsePersistedUiPart({ kind: "info-table", props: { rows: [] } }),
    ).toBeNull()
  })

  test("returns null on unknown kind", () => {
    expect(
      parsePersistedUiPart({ id: "p", kind: "bogus", props: {} }),
    ).toBeNull()
  })

  test("returns null on malformed props", () => {
    expect(
      parsePersistedUiPart({
        id: "p",
        kind: "info-table",
        props: { rows: "oops" },
      }),
    ).toBeNull()
  })

  test("returns null on non-object input", () => {
    expect(parsePersistedUiPart(null)).toBeNull()
    expect(parsePersistedUiPart("oops")).toBeNull()
    expect(parsePersistedUiPart([])).toBeNull()
  })
})
