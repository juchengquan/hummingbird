import { describe, expect, test } from "bun:test"

import {
  ChoicePropsSchema,
  ConfirmPropsSchema,
  DatePickerPropsSchema,
  InfoTablePropsSchema,
  MiniFormPropsSchema,
  UI_KIND_VALUES,
  UiKindEnum,
  UiPartSchema,
  defaultResolutionFor,
  formatAnswerForChat,
  parsePersistedUiPart,
  respondBodyForUiAnswer,
} from "./schemas"

describe("UiKindEnum", () => {
  test("accepts every value in UI_KIND_VALUES", () => {
    for (const v of UI_KIND_VALUES) {
      expect(UiKindEnum.safeParse(v).success).toBe(true)
    }
  })
  test("rejects unknown kinds", () => {
    expect(UiKindEnum.safeParse("bogus-kind").success).toBe(false)
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
      kind: "not-a-kind",
      props: {},
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

  test("round-trips a persisted answer alongside the part", () => {
    const out = parsePersistedUiPart({
      id: "p",
      kind: "confirm",
      props: { prompt: "Apply edits?" },
      answeredAt: "2026-06-10T00:00:00Z",
      answer: { kind: "confirm", confirmed: true },
    })
    expect(out?.answer).toEqual({ kind: "confirm", confirmed: true })
  })

  test("drops a malformed answer but keeps the part", () => {
    const out = parsePersistedUiPart({
      id: "p",
      kind: "confirm",
      props: { prompt: "?" },
      answer: { kind: "confirm" /* missing `confirmed` */ },
    })
    expect(out).not.toBeNull()
    expect(out!.answer).toBeUndefined()
  })
})

// --- v2 (interactive kinds) -----------------------------------------------

describe("ChoicePropsSchema", () => {
  test("accepts a 2-option single-select", () => {
    const r = ChoicePropsSchema.safeParse({
      prompt: "Which?",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    })
    expect(r.success).toBe(true)
  })

  test("rejects < 2 options (use confirm)", () => {
    const r = ChoicePropsSchema.safeParse({
      prompt: "?",
      options: [{ id: "x", label: "X" }],
    })
    expect(r.success).toBe(false)
  })

  test("rejects > 8 options (reads better as prose)", () => {
    const r = ChoicePropsSchema.safeParse({
      prompt: "?",
      options: Array.from({ length: 9 }, (_, i) => ({
        id: `o${i}`,
        label: `O${i}`,
      })),
    })
    expect(r.success).toBe(false)
  })

  test("accepts multiSelect: true", () => {
    const r = ChoicePropsSchema.safeParse({
      prompt: "?",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      multiSelect: true,
    })
    expect(r.success).toBe(true)
  })
})

describe("ConfirmPropsSchema", () => {
  test("prompt-only is enough", () => {
    expect(ConfirmPropsSchema.safeParse({ prompt: "Apply?" }).success).toBe(true)
  })
  test("accepts custom button labels", () => {
    expect(
      ConfirmPropsSchema.safeParse({
        prompt: "?",
        confirmLabel: "Apply",
        cancelLabel: "Discard",
      }).success,
    ).toBe(true)
  })
})

describe("MiniFormPropsSchema", () => {
  test("accepts text + number + select fields", () => {
    const r = MiniFormPropsSchema.safeParse({
      prompt: "Schedule the meeting",
      fields: [
        { type: "text", id: "topic", label: "Topic" },
        { type: "number", id: "minutes", label: "Length", min: 15, max: 120 },
        {
          type: "select",
          id: "day",
          label: "Day",
          options: [
            { id: "tue", label: "Tuesday" },
            { id: "wed", label: "Wednesday" },
          ],
        },
      ],
    })
    expect(r.success).toBe(true)
  })

  test("rejects 0 fields (no point) and > 4 (use a real form)", () => {
    expect(MiniFormPropsSchema.safeParse({ fields: [] }).success).toBe(false)
    const many = Array.from({ length: 5 }, (_, i) => ({
      type: "text" as const,
      id: `f${i}`,
      label: `F${i}`,
    }))
    expect(MiniFormPropsSchema.safeParse({ fields: many }).success).toBe(false)
  })

  test("select field needs >= 2 options (otherwise it's a text field)", () => {
    const r = MiniFormPropsSchema.safeParse({
      fields: [
        {
          type: "select",
          id: "x",
          label: "X",
          options: [{ id: "a", label: "A" }],
        },
      ],
    })
    expect(r.success).toBe(false)
  })
})

describe("UiPartSchema with interactive kinds", () => {
  test("choice round-trips", () => {
    expect(
      UiPartSchema.safeParse({
        kind: "choice",
        props: {
          prompt: "?",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      }).success,
    ).toBe(true)
  })
  test("confirm round-trips", () => {
    expect(
      UiPartSchema.safeParse({
        kind: "confirm",
        props: { prompt: "Apply?" },
      }).success,
    ).toBe(true)
  })
  test("mini-form round-trips", () => {
    expect(
      UiPartSchema.safeParse({
        kind: "mini-form",
        props: {
          fields: [{ type: "text", id: "x", label: "X" }],
        },
      }).success,
    ).toBe(true)
  })
})

describe("formatAnswerForChat", () => {
  test("confirm — confirmed → confirmLabel or 'Yes' default", () => {
    expect(
      formatAnswerForChat(
        { kind: "confirm", props: { prompt: "?" } },
        { kind: "confirm", confirmed: true },
      ),
    ).toBe("Yes")
    expect(
      formatAnswerForChat(
        { kind: "confirm", props: { prompt: "?", confirmLabel: "Apply" } },
        { kind: "confirm", confirmed: true },
      ),
    ).toBe("Apply")
  })

  test("confirm — cancelled → cancelLabel or 'Cancel' default", () => {
    expect(
      formatAnswerForChat(
        { kind: "confirm", props: { prompt: "?" } },
        { kind: "confirm", confirmed: false },
      ),
    ).toBe("Cancel")
  })

  test("choice — single pick returns the label", () => {
    expect(
      formatAnswerForChat(
        {
          kind: "choice",
          props: {
            prompt: "?",
            options: [
              { id: "a", label: "Option A" },
              { id: "b", label: "Option B" },
            ],
          },
        },
        { kind: "choice", selectedIds: ["b"] },
      ),
    ).toBe("Option B")
  })

  test("choice — multi pick comma-joins labels in selection order", () => {
    expect(
      formatAnswerForChat(
        {
          kind: "choice",
          props: {
            prompt: "?",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
              { id: "c", label: "C" },
            ],
          },
        },
        { kind: "choice", selectedIds: ["c", "a"] },
      ),
    ).toBe("C, A")
  })

  test("choice — unknown option ids drop silently", () => {
    expect(
      formatAnswerForChat(
        {
          kind: "choice",
          props: {
            prompt: "?",
            options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
          },
        },
        { kind: "choice", selectedIds: ["ghost", "a"] },
      ),
    ).toBe("A")
  })

  test("mini-form — emits 'Label: value' pairs joined by commas", () => {
    expect(
      formatAnswerForChat(
        {
          kind: "mini-form",
          props: {
            fields: [
              { type: "text", id: "topic", label: "Topic" },
              { type: "number", id: "min", label: "Minutes" },
            ],
          },
        },
        { kind: "mini-form", values: { topic: "Q4 plan", min: "30" } },
      ),
    ).toBe("Topic: Q4 plan, Minutes: 30")
  })

  test("mini-form — empty values drop out", () => {
    expect(
      formatAnswerForChat(
        {
          kind: "mini-form",
          props: {
            fields: [
              { type: "text", id: "a", label: "A" },
              { type: "text", id: "b", label: "B" },
            ],
          },
        },
        { kind: "mini-form", values: { a: "x", b: "" } },
      ),
    ).toBe("A: x")
  })

  test("info-table never produces an answer string", () => {
    expect(
      formatAnswerForChat(
        { kind: "info-table", props: { rows: [] } },
        { kind: "info-table" },
      ),
    ).toBe("")
  })
})

describe("defaultResolutionFor", () => {
  test("mini-form prefills the composer (form usually wants review)", () => {
    expect(defaultResolutionFor("mini-form")).toBe("prefill")
  })
  test("choice / confirm auto-send (one click resolves)", () => {
    expect(defaultResolutionFor("choice")).toBe("auto-send")
    expect(defaultResolutionFor("confirm")).toBe("auto-send")
  })
  test("info-table never resolves — auto-send is a moot default", () => {
    expect(defaultResolutionFor("info-table")).toBe("auto-send")
  })
})

describe("respondBodyForUiAnswer", () => {
  test("confirm — carries uiAnswer + folds the formatted text into `value`", () => {
    const out = respondBodyForUiAnswer(
      "req-1",
      { kind: "confirm", props: { prompt: "Apply?", confirmLabel: "Apply" } },
      { kind: "confirm", confirmed: true },
    )
    expect(out.requestId).toBe("req-1")
    expect(out.uiAnswer).toEqual({ kind: "confirm", confirmed: true })
    expect(out.value).toBe("Apply")
    expect(out.selection).toBeUndefined()
  })

  test("choice — carries uiAnswer + populates `selection` (back-compat for ask-user)", () => {
    const out = respondBodyForUiAnswer(
      "req-2",
      {
        kind: "choice",
        props: {
          prompt: "?",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      },
      { kind: "choice", selectedIds: ["b"] },
    )
    expect(out.selection).toEqual(["b"])
    expect(out.uiAnswer).toEqual({ kind: "choice", selectedIds: ["b"] })
    expect(out.value).toBe("B")
  })

  test("mini-form — carries uiAnswer + folds formatted text into `value`", () => {
    const out = respondBodyForUiAnswer(
      "req-3",
      {
        kind: "mini-form",
        props: {
          fields: [
            { type: "text", id: "topic", label: "Topic" },
            { type: "number", id: "min", label: "Minutes" },
          ],
        },
      },
      { kind: "mini-form", values: { topic: "Q4", min: "30" } },
    )
    expect(out.value).toBe("Topic: Q4, Minutes: 30")
    expect(out.uiAnswer).toEqual({
      kind: "mini-form",
      values: { topic: "Q4", min: "30" },
    })
    expect(out.selection).toBeUndefined()
  })

  test("choice with empty selection — selection field present and empty, no value", () => {
    const out = respondBodyForUiAnswer(
      "req-4",
      {
        kind: "choice",
        props: {
          prompt: "?",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      },
      { kind: "choice", selectedIds: [] },
    )
    expect(out.selection).toEqual([])
    expect(out.value).toBeUndefined()
  })
})

describe("DatePickerPropsSchema", () => {
  test("accepts a single-mode picker and defaults mode to single", () => {
    const parsed = DatePickerPropsSchema.safeParse({ prompt: "Pick a day" })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.mode).toBe("single")
  })
  test("accepts a range with min/max bounds", () => {
    const parsed = DatePickerPropsSchema.safeParse({
      prompt: "Pick a span",
      mode: "range",
      min: "2026-01-01",
      max: "2026-12-31",
    })
    expect(parsed.success).toBe(true)
  })
  test("rejects a non-ISO bound", () => {
    expect(
      DatePickerPropsSchema.safeParse({ prompt: "x", min: "06/20/2026" })
        .success,
    ).toBe(false)
  })
  test("rejects min > max", () => {
    expect(
      DatePickerPropsSchema.safeParse({
        prompt: "x",
        min: "2026-12-31",
        max: "2026-01-01",
      }).success,
    ).toBe(false)
  })
})

describe("date-picker — UiPartSchema + answer round-trips", () => {
  test("UiPartSchema accepts a well-formed date-picker", () => {
    const parsed = UiPartSchema.safeParse({
      kind: "date-picker",
      props: { prompt: "When?", mode: "single" },
    })
    expect(parsed.success).toBe(true)
  })
  test("parsePersistedUiPart round-trips a single answer", () => {
    const out = parsePersistedUiPart({
      id: "p1",
      kind: "date-picker",
      props: { prompt: "When?", mode: "single" },
      answer: { kind: "date-picker", date: "2026-06-20" },
    })
    expect(out?.answer).toEqual({ kind: "date-picker", date: "2026-06-20" })
  })
  test("parsePersistedUiPart round-trips a range answer", () => {
    const out = parsePersistedUiPart({
      id: "p2",
      kind: "date-picker",
      props: { prompt: "Span?", mode: "range" },
      answer: { kind: "date-picker", from: "2026-06-20", to: "2026-06-25" },
    })
    expect(out?.answer).toEqual({
      kind: "date-picker",
      from: "2026-06-20",
      to: "2026-06-25",
    })
  })
  test("drops a malformed range answer (from > to)", () => {
    const out = parsePersistedUiPart({
      id: "p3",
      kind: "date-picker",
      props: { prompt: "Span?", mode: "range" },
      answer: { kind: "date-picker", from: "2026-06-25", to: "2026-06-20" },
    })
    expect(out?.answer).toBeUndefined()
  })
  test("formatAnswerForChat renders single + range human-readable", () => {
    const single = formatAnswerForChat(
      { kind: "date-picker", props: { prompt: "When?", mode: "single" } },
      { kind: "date-picker", date: "2026-06-20" },
    )
    expect(single).toBe("June 20, 2026")
    const range = formatAnswerForChat(
      { kind: "date-picker", props: { prompt: "Span?", mode: "range" } },
      { kind: "date-picker", from: "2026-06-20", to: "2026-06-25" },
    )
    expect(range).toBe("June 20, 2026 – June 25, 2026")
  })
  test("defaultResolutionFor(date-picker) is auto-send", () => {
    expect(defaultResolutionFor("date-picker")).toBe("auto-send")
  })
})
