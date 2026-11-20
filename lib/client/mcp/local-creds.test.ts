import { describe, expect, test } from "bun:test"

import {
  credentialFingerprint,
  staleCredentialFingerprints,
  type McpCredentials,
} from "./local-creds"

const bearer = (token: string): McpCredentials => ({
  type: "bearer",
  headers: { authorization: `Bearer ${token}` },
})

describe("credentialFingerprint", () => {
  test("different bearer tokens get different fingerprints", async () => {
    const a = await credentialFingerprint(bearer("token-a"))
    const b = await credentialFingerprint(bearer("token-b"))
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  test("is independent of key insertion order", async () => {
    const a = await credentialFingerprint({
      type: "custom",
      headers: { "x-a": "1", "x-b": "2" },
    })
    const b = await credentialFingerprint({
      headers: { "x-b": "2", "x-a": "1" },
      type: "custom",
    })
    expect(a).toBe(b)
  })

  test("never contains the secret", async () => {
    const fp = await credentialFingerprint(bearer("super-secret"))
    expect(fp).not.toContain("secret")
  })
})

describe("staleCredentialFingerprints", () => {
  test("returns only live local-mode servers with an on-device cred whose stored fingerprint is stale", async () => {
    const creds: Record<string, McpCredentials> = {
      stale: bearer("a"),
      fresh: bearer("b"),
      cloud: bearer("c"),
      deleted: bearer("d"),
    }
    const freshFp = await credentialFingerprint(creds.fresh)
    const updates = await staleCredentialFingerprints(
      [
        { id: "stale", credentialMode: "local", credentialFingerprint: "collided" },
        { id: "fresh", credentialMode: "local", credentialFingerprint: freshFp },
        { id: "cloud", credentialMode: "cloud", credentialFingerprint: undefined },
        {
          id: "deleted",
          credentialMode: "local",
          credentialFingerprint: "collided",
          deletedAt: new Date(),
        },
        { id: "other-device", credentialMode: "local", credentialFingerprint: "x" },
      ],
      (id) => creds[id]
    )
    expect(updates).toEqual([
      { id: "stale", fingerprint: await credentialFingerprint(creds.stale) },
    ])
  })
})
