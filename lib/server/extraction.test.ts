import { describe, expect, test } from "bun:test"

import { extractFile } from "./extraction"

// A VALID minimal 1-page PDF (renders/parses fine) so the real pdf-parse
// text pass succeeds deterministically and the *vision branch* is what's
// under test. We force `vision: true` to bypass the heuristic and drive
// the vision pass through injected deps (no native renderer / model call).
const FIXTURE_PDF_B64 =
  "JVBERi0xLjMKJf////8KNyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9NZWRpYUJveCBbMCAwIDIwMCAyMDBdCi9Db250ZW50cyA1IDAgUgovUmVzb3VyY2VzIDYgMCBSCi9Vc2VyVW5pdCAxCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Qcm9jU2V0IFsvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJXQovRm9udCA8PAovRjEgOCAwIFIKPj4KL0NvbG9yU3BhY2UgPDwKPj4KPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0xlbmd0aCA3NgovRmlsdGVyIC9GbGF0ZURlY29kZQo+PgpzdHJlYW0KeJwzVDAAQl1DIGFkYKCQnMtVyGWIIeYUAhU0BIooGJpZ6lmaWCiE5HLpuxkqGJoohKRxRduYWJhZ2ikYxCqEeHG5hnAFcgEAJq8SBgplbmRzdHJlYW0KZW5kb2JqCjEwIDAgb2JqCihQREZLaXQpCmVuZG9iagoxMSAwIG9iagooUERGS2l0KQplbmRvYmoKMTIgMCBvYmoKKEQ6MjAyNjA2MjAwNDMzMTlaKQplbmRvYmoKOSAwIG9iago8PAovUHJvZHVjZXIgMTAgMCBSCi9DcmVhdG9yIDExIDAgUgovQ3JlYXRpb25EYXRlIDEyIDAgUgo+PgplbmRvYmoKOCAwIG9iago8PAovVHlwZSAvRm9udAovQmFzZUZvbnQgL0hlbHZldGljYQovU3VidHlwZSAvVHlwZTEKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCjQgMCBvYmoKPDwKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCi9OYW1lcyAyIDAgUgo+PgplbmRvYmoKMSAwIG9iago8PAovVHlwZSAvUGFnZXMKL0NvdW50IDEKL0tpZHMgWzcgMCBSXQo+PgplbmRvYmoKMiAwIG9iago8PAovRGVzdHMgPDwKICAvTmFtZXMgWwpdCj4+Cj4+CmVuZG9iagp4cmVmCjAgMTMKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwNzI2IDAwMDAwIG4gCjAwMDAwMDA3ODMgMDAwMDAgbiAKMDAwMDAwMDY2NCAwMDAwMCBuIAowMDAwMDAwNjQzIDAwMDAwIG4gCjAwMDAwMDAyMzggMDAwMDAgbiAKMDAwMDAwMDEzMSAwMDAwMCBuIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDA1NDYgMDAwMDAgbiAKMDAwMDAwMDQ3MSAwMDAwMCBuIAowMDAwMDAwMzg1IDAwMDAwIG4gCjAwMDAwMDA0MTAgMDAwMDAgbiAKMDAwMDAwMDQzNSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDEzCi9Sb290IDMgMCBSCi9JbmZvIDkgMCBSCi9JRCBbPDUwOGIxMjkyZDkzNmZlMjNiZjdkYjM4ZDZjYWFiYjZiPiA8NTA4YjEyOTJkOTM2ZmUyM2JmN2RiMzhkNmNhYWJiNmI+XQo+PgpzdGFydHhyZWYKODMwCiUlRU9GCg=="
const FAKE_PDF = Buffer.from(FIXTURE_PDF_B64, "base64")

describe("extractFile — vision gating", () => {
  test("no vision model configured → vision pass not invoked (text-only)", async () => {
    let visionCalled = false
    const result = await extractFile(
      { name: "doc.pdf", mimeType: "application/pdf", data: FAKE_PDF },
      {
        vision: true,
        resolveVisionModel: () => null,
        extractWithVision: async () => {
          visionCalled = true
          return { text: "VISION", pageCount: 1 }
        },
      }
    )
    expect(visionCalled).toBe(false)
    expect(result.kind).toBe("pdf")
    expect(result.text).not.toBe("VISION")
  })

  test("forced vision + model present → merges vision markdown", async () => {
    const result = await extractFile(
      { name: "doc.pdf", mimeType: "application/pdf", data: FAKE_PDF },
      {
        vision: true,
        resolveVisionModel: () => "vis/a",
        extractWithVision: async () => ({ text: "| A | B |\n|---|---|\n| 1 | 2 |", pageCount: 1 }),
      }
    )
    expect(result.text).toContain("| A | B |")
  })

  test("vision pass throws → falls back to text-only (never throws)", async () => {
    const result = await extractFile(
      { name: "doc.pdf", mimeType: "application/pdf", data: FAKE_PDF },
      {
        vision: true,
        resolveVisionModel: () => "vis/a",
        extractWithVision: async () => {
          throw new Error("render boom")
        },
      }
    )
    expect(result.kind).toBe("pdf")
    expect(result.text).not.toContain("VISION")
  })

  test("budget denied → vision pass not invoked", async () => {
    let visionCalled = false
    await extractFile(
      { name: "doc.pdf", mimeType: "application/pdf", data: FAKE_PDF },
      {
        vision: true,
        resolveVisionModel: () => "vis/a",
        consumeVisionBudget: () => ({ allowed: false, retryAfterSec: 30 }),
        extractWithVision: async () => {
          visionCalled = true
          return { text: "x", pageCount: 1 }
        },
      }
    )
    expect(visionCalled).toBe(false)
  })
})
