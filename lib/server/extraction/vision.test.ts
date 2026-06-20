import { describe, expect, test } from "bun:test"

import { extractWithVision } from "./vision"

const DATA = new Uint8Array([1, 2, 3])

describe("extractWithVision", () => {
  test("concatenates per-page markdown with page separators", async () => {
    const result = await extractWithVision(
      { data: DATA, model: "vis/a" },
      {
        renderPages: async () => [Buffer.from("p1"), Buffer.from("p2")],
        transcribePage: async (_png, _model, _signal, pageNum) => `# Page ${pageNum}`,
      }
    )
    expect(result.pageCount).toBe(2)
    expect(result.text).toContain("# Page 1")
    expect(result.text).toContain("# Page 2")
    // Pages are separated, in order.
    expect(result.text.indexOf("# Page 1")).toBeLessThan(result.text.indexOf("# Page 2"))
  })

  test("no rendered pages → empty text, pageCount 0", async () => {
    const result = await extractWithVision(
      { data: DATA, model: "vis/a" },
      { renderPages: async () => [], transcribePage: async () => "unused" }
    )
    expect(result).toEqual({ text: "", pageCount: 0 })
  })

  test("passes the resolved model + page number through to transcribePage", async () => {
    const seen: Array<{ model: string; page: number }> = []
    await extractWithVision(
      { data: DATA, model: "vis/x" },
      {
        renderPages: async () => [Buffer.from("a")],
        transcribePage: async (_png, model, _signal, pageNum) => {
          seen.push({ model, page: pageNum })
          return "ok"
        },
      }
    )
    expect(seen).toEqual([{ model: "vis/x", page: 1 }])
  })
})
