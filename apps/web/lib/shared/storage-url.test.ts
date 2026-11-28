import { describe, expect, it } from "bun:test"

import { parseStorageObjectPath } from "./storage-url"

describe("parseStorageObjectPath", () => {
  it("extracts the object path from a user-files signed URL", () => {
    const url =
      "https://proj.supabase.co/storage/v1/object/sign/user-files/u123/generated/call-0-report.csv?token=abc.def.ghi"
    expect(parseStorageObjectPath(url)).toBe("u123/generated/call-0-report.csv")
  })

  it("URL-decodes the path", () => {
    const url =
      "https://proj.supabase.co/storage/v1/object/sign/user-files/u123/generated/call-0-my%20file.csv?token=x"
    expect(parseStorageObjectPath(url)).toBe("u123/generated/call-0-my file.csv")
  })

  it("returns null for a data: URL", () => {
    expect(parseStorageObjectPath("data:text/csv;base64,AAAA")).toBeNull()
  })

  it("returns null for a non-Supabase https URL", () => {
    expect(parseStorageObjectPath("https://example.com/x.csv")).toBeNull()
  })

  it("returns null when the marker is present but the path is empty", () => {
    expect(
      parseStorageObjectPath(
        "https://proj.supabase.co/storage/v1/object/sign/user-files/?token=x",
      ),
    ).toBeNull()
  })

  it("returns null for an empty string", () => {
    expect(parseStorageObjectPath("")).toBeNull()
  })
})
