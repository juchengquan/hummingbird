import { describe, expect, test } from "bun:test"
import { __test } from "./model-provider"

const { isMinimaxBaseUrlSafe } = __test

describe("isMinimaxBaseUrlSafe — accepts", () => {
  test("plain https URL with public hostname", () => {
    expect(isMinimaxBaseUrlSafe("https://api.minimax.chat/v1")).toBe(true)
  })
  test("https URL with path", () => {
    expect(isMinimaxBaseUrlSafe("https://example.com/v1")).toBe(true)
  })
  test("https URL with port", () => {
    expect(isMinimaxBaseUrlSafe("https://api.example.com:8443/v1")).toBe(true)
  })
})

describe("isMinimaxBaseUrlSafe — rejects", () => {
  test("non-https scheme (http)", () => {
    expect(isMinimaxBaseUrlSafe("http://api.minimax.chat/v1")).toBe(false)
  })
  test("non-http scheme (ftp)", () => {
    expect(isMinimaxBaseUrlSafe("ftp://api.minimax.chat")).toBe(false)
  })
  test("localhost", () => {
    expect(isMinimaxBaseUrlSafe("https://localhost:8080/v1")).toBe(false)
  })
  test("loopback IP", () => {
    expect(isMinimaxBaseUrlSafe("https://127.0.0.1/v1")).toBe(false)
  })
  test("any 127.x.x.x", () => {
    expect(isMinimaxBaseUrlSafe("https://127.5.4.3/v1")).toBe(false)
  })
  test("0.0.0.0", () => {
    expect(isMinimaxBaseUrlSafe("https://0.0.0.0/v1")).toBe(false)
  })
  test("RFC 1918 ranges", () => {
    expect(isMinimaxBaseUrlSafe("https://10.1.2.3/v1")).toBe(false)
    expect(isMinimaxBaseUrlSafe("https://192.168.1.1/v1")).toBe(false)
    expect(isMinimaxBaseUrlSafe("https://172.16.0.1/v1")).toBe(false)
    expect(isMinimaxBaseUrlSafe("https://172.31.255.255/v1")).toBe(false)
  })
  test("172.15.x — outside RFC 1918 — is allowed (regression guard)", () => {
    expect(isMinimaxBaseUrlSafe("https://172.15.0.1/v1")).toBe(true)
    expect(isMinimaxBaseUrlSafe("https://172.32.0.1/v1")).toBe(true)
  })
  test(".local / .internal suffix", () => {
    expect(isMinimaxBaseUrlSafe("https://service.local/v1")).toBe(false)
    expect(isMinimaxBaseUrlSafe("https://api.internal/v1")).toBe(false)
  })
  test("IPv6 loopback", () => {
    expect(isMinimaxBaseUrlSafe("https://[::1]/v1")).toBe(false)
  })
  test("not a URL at all", () => {
    expect(isMinimaxBaseUrlSafe("not a url")).toBe(false)
    expect(isMinimaxBaseUrlSafe("")).toBe(false)
  })
  test("scheme alone", () => {
    expect(isMinimaxBaseUrlSafe("https://")).toBe(false)
  })
})
