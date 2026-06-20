import { describe, expect, test } from "bun:test"

import { resolveMountFiles, type MountManifestEntry } from "./mount-files"

const enc = (s: string) => Buffer.from(s).toString("base64")

const manifest: MountManifestEntry[] = [
  { name: "local.csv", fileId: "f1", dataBase64: enc("a,b\n1,2\n") }, // local
  { name: "cloud.parquet", fileId: "f2" }, // cloud
]

// Injected cloud download: fileId → bytes (or null when not found/denied).
const download = async (fileId: string): Promise<Uint8Array | null> =>
  fileId === "f2" ? new Uint8Array([1, 2, 3]) : null

describe("resolveMountFiles", () => {
  test("local file → decoded bytes at MOUNT_DIR/name", async () => {
    const r = await resolveMountFiles(["local.csv"], manifest, download)
    expect(r.files).toHaveLength(1)
    expect(r.files[0].path).toBe("/mnt/files/local.csv")
    expect(new TextDecoder().decode(r.files[0].bytes)).toBe("a,b\n1,2\n")
    expect(r.notes).toHaveLength(0)
  })
  test("cloud file → downloaded bytes", async () => {
    const r = await resolveMountFiles(["cloud.parquet"], manifest, download)
    expect(r.files[0].bytes).toEqual(new Uint8Array([1, 2, 3]))
  })
  test("unknown name → note, no file", async () => {
    const r = await resolveMountFiles(["nope.txt"], manifest, download)
    expect(r.files).toHaveLength(0)
    expect(r.notes.join(" ")).toContain("nope.txt")
  })
  test("cloud download returns null → note (e.g. signed-out / denied)", async () => {
    const m: MountManifestEntry[] = [{ name: "x.bin", fileId: "missing" }]
    const r = await resolveMountFiles(["x.bin"], m, download)
    expect(r.files).toHaveLength(0)
    expect(r.notes.join(" ")).toContain("x.bin")
  })
  test("over per-file cap → dropped + note", async () => {
    const big: MountManifestEntry[] = [
      { name: "big", fileId: "b", dataBase64: enc("Z".repeat(11_000_000)) },
    ]
    const r = await resolveMountFiles(["big"], big, download)
    expect(r.files).toHaveLength(0)
    expect(r.notes.join(" ").toLowerCase()).toContain("too large")
  })
  test("path traversal in name is sanitized to a single segment", async () => {
    const m: MountManifestEntry[] = [
      { name: "../../etc/passwd", fileId: "f", dataBase64: enc("x") },
    ]
    const r = await resolveMountFiles(["../../etc/passwd", "passwd"], m, download)
    // Whichever name the model uses, the written path stays under MOUNT_DIR.
    for (const f of r.files) expect(f.path.startsWith("/mnt/files/")).toBe(true)
    for (const f of r.files) expect(f.path.includes("..")).toBe(false)
  })
  test("two names that sanitize to the same path get distinct paths (no overwrite)", async () => {
    const m: MountManifestEntry[] = [
      { name: "a b.csv", fileId: "x1", dataBase64: enc("one") },
      { name: "a+b.csv", fileId: "x2", dataBase64: enc("two") },
    ]
    const r = await resolveMountFiles(["a b.csv", "a+b.csv"], m, download)
    expect(r.files).toHaveLength(2)
    const paths = r.files.map((f) => f.path)
    expect(new Set(paths).size).toBe(2) // distinct — no silent collision
    expect(paths[0]).toBe("/mnt/files/a_b.csv")
    expect(paths[1]).toBe("/mnt/files/a_b-1.csv")
    expect(new TextDecoder().decode(r.files[0].bytes)).toBe("one")
    expect(new TextDecoder().decode(r.files[1].bytes)).toBe("two")
    expect(r.notes.join(" ").toLowerCase()).toContain("collision")
  })
})
