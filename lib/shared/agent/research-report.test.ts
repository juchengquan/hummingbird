import { describe, expect, test } from "bun:test"

import { deriveResearchReportTitle } from "./research-report"

describe("deriveResearchReportTitle", () => {
  test("uses the first non-empty line, stripping heading hashes", () => {
    expect(deriveResearchReportTitle("# State of AI agents in 2026\n\nSummary…")).toBe(
      "State of AI agents in 2026"
    )
    expect(
      deriveResearchReportTitle("## Open-source agent frameworks\n\nIntro")
    ).toBe("Open-source agent frameworks")
  })

  test("strips a leading bullet or blockquote", () => {
    expect(deriveResearchReportTitle("- Headline summary\n…")).toBe(
      "Headline summary"
    )
    expect(deriveResearchReportTitle("> An interesting quote\n…")).toBe(
      "An interesting quote"
    )
  })

  test("skips leading blank / whitespace lines", () => {
    expect(deriveResearchReportTitle("\n\n   \n# Real title")).toBe(
      "Real title"
    )
  })

  test("truncates long lines to 60 chars", () => {
    const long = "x".repeat(120)
    const title = deriveResearchReportTitle(long)
    expect(title.length).toBe(60)
    expect(title).toBe("x".repeat(60))
  })

  test("falls back to the supplied default when no usable line exists", () => {
    expect(deriveResearchReportTitle("", "From conversation")).toBe(
      "From conversation"
    )
    expect(deriveResearchReportTitle("\n\n\n  \n", "Workspace name")).toBe(
      "Workspace name"
    )
  })

  test("falls back to 'Research report' when nothing else is available", () => {
    expect(deriveResearchReportTitle("")).toBe("Research report")
    expect(deriveResearchReportTitle("   ")).toBe("Research report")
  })

  test("truncates the fallback too", () => {
    const long = "y".repeat(100)
    const title = deriveResearchReportTitle("", long)
    expect(title.length).toBe(60)
  })

  test("trims trailing whitespace after truncation", () => {
    const title = deriveResearchReportTitle("a".repeat(58) + "   trailing")
    expect(title).toBe("a".repeat(58))
  })
})
