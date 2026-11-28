import { describe, expect, test } from "bun:test"

import { expandTemplate, parseTemplate } from "./expand"

describe("parseTemplate", () => {
  test("plain text → single text segment, no variables", () => {
    const r = parseTemplate("hello world")
    expect(r.variables).toEqual([])
    expect(r.segments).toEqual([{ kind: "text", value: "hello world" }])
  })

  test("single variable in the middle", () => {
    const r = parseTemplate("Hello {name}, welcome.")
    expect(r.variables).toEqual(["name"])
    expect(r.segments).toEqual([
      { kind: "text", value: "Hello " },
      { kind: "var", name: "name" },
      { kind: "text", value: ", welcome." },
    ])
  })

  test("variable at start and end", () => {
    const r = parseTemplate("{a} middle {b}")
    expect(r.variables).toEqual(["a", "b"])
    expect(r.segments).toEqual([
      { kind: "var", name: "a" },
      { kind: "text", value: " middle " },
      { kind: "var", name: "b" },
    ])
  })

  test("variables in first-appearance order, deduplicated", () => {
    const r = parseTemplate("{b} {a} {b} {c} {a}")
    expect(r.variables).toEqual(["b", "a", "c"])
  })

  test("whitespace inside braces is tolerated", () => {
    const r = parseTemplate("Hello {   name   }!")
    expect(r.variables).toEqual(["name"])
    expect(r.segments).toEqual([
      { kind: "text", value: "Hello " },
      { kind: "var", name: "name" },
      { kind: "text", value: "!" },
    ])
  })

  test("multi-word variable names allowed", () => {
    const r = parseTemplate("Subject: {key topic}")
    expect(r.variables).toEqual(["key topic"])
  })

  test("empty braces left as literal text", () => {
    const r = parseTemplate("a {} b")
    expect(r.variables).toEqual([])
    expect(r.segments).toEqual([{ kind: "text", value: "a {} b" }])
  })

  test("whitespace-only braces left as literal text", () => {
    const r = parseTemplate("a {  } b")
    expect(r.variables).toEqual([])
    expect(r.segments).toEqual([{ kind: "text", value: "a {  } b" }])
  })

  test("double-brace escapes produce literal braces", () => {
    const r = parseTemplate("{{ literal braces }}")
    expect(r.variables).toEqual([])
    expect(r.segments).toEqual([
      { kind: "text", value: "{ literal braces }" },
    ])
  })

  test("escaped braces with a variable mixed in", () => {
    const r = parseTemplate("{{ code: {var} }}")
    expect(r.variables).toEqual(["var"])
    expect(r.segments).toEqual([
      { kind: "text", value: "{ code: " },
      { kind: "var", name: "var" },
      { kind: "text", value: " }" },
    ])
  })

  test("unmatched single brace treated as literal", () => {
    const r = parseTemplate("a { b c")
    expect(r.variables).toEqual([])
    expect(r.segments).toEqual([{ kind: "text", value: "a { b c" }])
  })

  test("empty template → no segments", () => {
    const r = parseTemplate("")
    expect(r.variables).toEqual([])
    expect(r.segments).toEqual([])
  })

  test("repeated calls don't leak regex state", () => {
    parseTemplate("{a} {b}")
    const r2 = parseTemplate("{c}")
    expect(r2.variables).toEqual(["c"])
  })
})

describe("expandTemplate", () => {
  test("full fill", () => {
    expect(expandTemplate("Hello {name}", { name: "Ada" })).toBe("Hello Ada")
  })

  test("variable referenced twice fills both occurrences", () => {
    expect(expandTemplate("{a} and {a}", { a: "X" })).toBe("X and X")
  })

  test("partial fill leaves missing markers literal", () => {
    expect(
      expandTemplate("Hello {name}, {role}", { name: "Ada" })
    ).toBe("Hello Ada, {role}")
  })

  test("empty string value substitutes empty (intentional suppression)", () => {
    expect(expandTemplate("a{x}b", { x: "" })).toBe("ab")
  })

  test("null and undefined values leave markers literal", () => {
    expect(expandTemplate("{a} {b}", { a: null, b: undefined })).toBe("{a} {b}")
  })

  test("whitespace-tolerant marker substitutes", () => {
    expect(expandTemplate("Hi {  name  }", { name: "Ada" })).toBe("Hi Ada")
  })

  test("template with no variables passes through unchanged", () => {
    expect(expandTemplate("Just plain text.", { x: "y" })).toBe("Just plain text.")
  })

  test("empty braces are left literal", () => {
    expect(expandTemplate("a {} b", { "": "should-not-substitute" })).toBe("a {} b")
  })

  test("escaped braces are preserved", () => {
    expect(expandTemplate("{{ literal }}", { literal: "no" })).toBe("{ literal }")
  })

  test("escaped braces with variables interpolated", () => {
    expect(expandTemplate("{{ code: {var} }}", { var: "x" })).toBe("{ code: x }")
  })

  test("fills with extra keys not in template are ignored", () => {
    expect(expandTemplate("{a}", { a: "1", b: "ignored", c: "ignored" })).toBe("1")
  })
})
