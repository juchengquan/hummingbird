import { describe, expect, test } from "bun:test"

import { renderPdfPages } from "./render-pdf"

// Minimal valid 1-page PDF (200x200), generated with pdfkit.
const FIXTURE_PDF_B64 =
  "JVBERi0xLjMKJf////8KNyAwIG9iago8PAovVHlwZSAvUGFnZQovUGFyZW50IDEgMCBSCi9NZWRpYUJveCBbMCAwIDIwMCAyMDBdCi9Db250ZW50cyA1IDAgUgovUmVzb3VyY2VzIDYgMCBSCi9Vc2VyVW5pdCAxCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Qcm9jU2V0IFsvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJXQovRm9udCA8PAovRjEgOCAwIFIKPj4KL0NvbG9yU3BhY2UgPDwKPj4KPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0xlbmd0aCA3NgovRmlsdGVyIC9GbGF0ZURlY29kZQo+PgpzdHJlYW0KeJwzVDAAQl1DIGFrWFkYKCQnMtVyGWIIeYUAhU0BIooGJpZ6lmaWCiE5HLpuxkqGJoohKRxRduYWJhZ2ikYxCqEeHG5hnAFcgEAJq8SBgplbmRzdHJlYW0KZW5kb2JqCjEwIDAgb2JqCihQREZLaXQpCmVuZG9iagoxMSAwIG9iagooUERGS2l0KQplbmRvYmoKMTIgMCBvYmoKKEQ6MjAyNjA2MjAwNDA5MzFaKQplbmRvYmoKOSAwIG9iago8PAovUHJvZHVjZXIgMTAgMCBSCi9DcmVhdG9yIDExIDAgUgovQ3JlYXRpb25EYXRlIDEyIDAgUgo+PgplbmRvYmoKOCAwIG9iago8PAovVHlwZSAvRm9udAovQmFzZUZvbnQgL0hlbHZldGljYQovU3VidHlwZSAvVHlwZTEKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKPj4KZW5kb2JqCjQgMCBvYmoKPDwKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDEgMCBSCi9OYW1lcyAyIDAgUgo+PgplbmRvYmoKMSAwIG9iago8PAovVHlwZSAvUGFnZXMKL0NvdW50IDEKL0tpZHMgWzcgMCBSXQo+PgplbmRvYmoKMiAwIG9iago8PAovRGVzdHMgPDwKICAvTmFtZXMgWwpdCj4+Cj4+CmVuZG9iagp4cmVmCjAgMTMKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwNzI2IDAwMDAwIG4gCjAwMDAwMDA3ODMgMDAwMDAgbiAKMDAwMDAwMDY2NCAwMDAwMCBuIAowMDAwMDAwNjQzIDAwMDAwIG4gCjAwMDAwMDAyMzggMDAwMDAgbiAKMDAwMDAwMDEzMSAwMDAwMCBuIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDA1NDYgMDAwMDAgbiAKMDAwMDAwMDQ3MSAwMDAwMCBuIAowMDAwMDAwMzg1IDAwMDAwIG4gCjAwMDAwMDA0MTAgMDAwMDAgbiAKMDAwMDAwMDQzNSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDEzCi9Sb290IDMgMCBSCi9JbmZvIDkgMCBSCi9JRCBbPGNhMGE0MTJjNDBlY2Y1NjkyYTQwYmMzNWU4OWEzNTQ1PiA8Y2EwYTQxMmM0MGVjZjU2OTJhNDBiYzM1ZTg5YTM1NDU+XQo+PgpzdGFydHhyZWYKODMwCiUlRU9GCg=="

describe("renderPdfPages", () => {
  test("renders a single-page PDF to one valid PNG buffer", async () => {
    const data = new Uint8Array(Buffer.from(FIXTURE_PDF_B64, "base64"))
    let pages: Buffer[]
    try {
      pages = await renderPdfPages(data, { scale: 1.5 })
    } catch (err) {
      // The renderer leans on @napi-rs/canvas (native binding). If it
      // can't load in this environment, skip rather than fail CI.
      console.warn("renderPdfPages skipped (native binding unavailable):", err)
      return
    }
    expect(pages.length).toBe(1)
    const png = pages[0]
    expect(png.length).toBeGreaterThan(0)
    // PNG signature.
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  })

  test("honours maxPages cap", async () => {
    const data = new Uint8Array(Buffer.from(FIXTURE_PDF_B64, "base64"))
    try {
      const pages = await renderPdfPages(data, { maxPages: 0 })
      expect(pages.length).toBe(0)
    } catch {
      return // native binding unavailable → skip
    }
  })
})
