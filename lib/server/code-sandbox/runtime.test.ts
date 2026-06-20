import { describe, expect, test } from "bun:test"

import { JS_IMAGE, PYTHON_IMAGE } from "./config"
import { runtimeFor } from "./runtime"

describe("runtimeFor", () => {
  test("python → configured python image + python3 -c", () => {
    expect(runtimeFor("python")).toEqual({ image: PYTHON_IMAGE, cmd: "python3", flag: "-c" })
  })
  test("javascript → configured node image + node -e", () => {
    expect(runtimeFor("javascript")).toEqual({ image: JS_IMAGE, cmd: "node", flag: "-e" })
  })
  test("unknown / undefined → python mapping (safe default)", () => {
    expect(runtimeFor(undefined as never)).toEqual({ image: PYTHON_IMAGE, cmd: "python3", flag: "-c" })
    expect(runtimeFor("ruby" as never)).toEqual({ image: PYTHON_IMAGE, cmd: "python3", flag: "-c" })
  })
})
