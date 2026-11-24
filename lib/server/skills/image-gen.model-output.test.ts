import { describe, expect, test } from "bun:test"

import { buildImageGenTool, persistedImageFrame, type ImageGenResult } from "./image-gen"
import type { ImageToPersist, PersistImagesResult } from "@/server/image-storage"

/** Q86: the model gets a generated image's link only when it is stored
 *  (long-lived, a remix can pass it back); an image that isn't stored is
 *  "shown to the user", never Minimax's URL, which dies in hours. */

const CONFIG = { maxCalls: 3, aspectRatio: "1:1" } as Parameters<typeof buildImageGenTool>[1]["config"]
const generate = async () => ({
  ok: true as const,
  images: [
    { url: "https://m.test/a.png", width: 1, height: 1, format: "png" },
    { url: "https://m.test/b.png", width: 1, height: 1, format: "png" },
  ],
})
const OPTIONS = { toolCallId: "tc1", messages: [] }

type Exec = (input: unknown, options: unknown) => Promise<ImageGenResult>
type ToModel = (output: ImageGenResult) => { type: string; value: unknown }

function run(persistImages?: (inputs: ImageToPersist[]) => Promise<PersistImagesResult>) {
  const built = buildImageGenTool([], { config: CONFIG, generate, ...(persistImages ? { persistImages } : {}) })
  return {
    execute: (input: unknown) => (built.execute as unknown as Exec)(input, OPTIONS),
    toModel: (output: ImageGenResult) => (built as unknown as { toModelOutput: ToModel }).toModelOutput(output),
  }
}

describe("generateImage's model output (Q86)", () => {
  test("a stored image keeps its link; one that isn't is shown to the user, with no link", async () => {
    const seen: ImageToPersist[] = []
    const tool = run(async (inputs) => {
      seen.push(...inputs)
      return {
        ok: true,
        images: [
          { ...inputs[0], url: "https://signed.test/a", storagePath: "u/generated/tc1-0.png" },
          { ...inputs[1], url: "data:image/png;base64,AAAA" },
        ],
      }
    })
    const output = await tool.execute({ prompt: "a cat", count: 2 })
    expect(seen.map((i) => i.id)).toEqual(["tc1-0", "tc1-1"])
    expect(output.ok && output.images.map((i) => i.url)).toEqual(["https://signed.test/a", "data:image/png;base64,AAAA"])
    const text = String(tool.toModel(output).value)
    expect(text).toContain("[1] https://signed.test/a")
    expect(text).toContain("[2] Shown to the user above your reply.")
    expect(text).not.toContain("m.test")
    expect(text).not.toContain("data:")
  })

  test("without a way to store them, no image gives the model a link", async () => {
    const tool = run()
    const text = String(tool.toModel(await tool.execute({ prompt: "a cat", count: 2 })).value)
    expect(text).not.toContain("m.test")
    expect(text).toContain("[1] Shown to the user above your reply.")
  })

  test("a failed store keeps Minimax's URLs for the user, never for the model", async () => {
    const tool = run(async () => ({ ok: false, error: "upload failed" }))
    const output = await tool.execute({ prompt: "a cat" })
    expect(output.ok && output.images[0].url).toBe("https://m.test/a.png")
    expect(String(tool.toModel(output).value)).not.toContain("m.test")
  })
})

describe("persistedImageFrame (the route emits stored images as they are)", () => {
  test("images the tool already stored are emitted without storing them again", async () => {
    const tool = run(async (inputs) => ({ ok: true, images: inputs.map((i) => ({ ...i, url: "data:image/png;base64,AA" })) }))
    const frame = persistedImageFrame(await tool.execute({ prompt: "a cat" }))
    // The fake generator returns two images.
    expect(frame?.images.map((i) => i.url)).toEqual(["data:image/png;base64,AA", "data:image/png;base64,AA"])
  })

  test("an output the tool didn't store is left to the route", async () => {
    expect(persistedImageFrame(await run().execute({ prompt: "a cat" }))).toBeNull()
  })
})
