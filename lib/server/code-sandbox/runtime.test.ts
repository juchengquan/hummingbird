import { describe, expect, test } from "bun:test"

import { runtimeFor } from "./runtime"

describe("runtimeFor", () => {
  test("python → python image + python3 -c", () => {
    expect(runtimeFor("python")).toEqual({ image: "python", cmd: "python3", flag: "-c" })
  })
  test("javascript → node image + node -e", () => {
    expect(runtimeFor("javascript")).toEqual({ image: "node", cmd: "node", flag: "-e" })
  })
  test("unknown / undefined → python mapping (safe default)", () => {
    expect(runtimeFor(undefined as never)).toEqual({ image: "python", cmd: "python3", flag: "-c" })
    expect(runtimeFor("ruby" as never)).toEqual({ image: "python", cmd: "python3", flag: "-c" })
  })
})
