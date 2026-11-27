import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import * as stub from "./ai-sdk-gateway";

// The names `ai` imports from "@ai-sdk/gateway" — the stub must export each,
// or the browser build breaks (or worse, silently gets undefined) after an
// `ai` upgrade.
function namesAiImportsFromGateway(): string[] {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("ai").replace(/index\.js$/, "index.mjs");
  const source = readFileSync(entry, "utf8");
  const names = new Set<string>();
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@ai-sdk\/gateway"/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) names.add(name);
    }
  }
  expect(source).not.toMatch(/export\s*\*\s*from\s*"@ai-sdk\/gateway"/);
  return [...names].sort();
}

describe("the browser's @ai-sdk/gateway stub", () => {
  test("exports every name `ai` imports from the gateway", () => {
    const names = namesAiImportsFromGateway();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(Object.keys(stub)).toContain(name);
  });

  test("never claims an error is a gateway error", () => {
    expect(stub.GatewayAuthenticationError.isInstance(new Error("x"))).toBe(false);
    expect(stub.GatewayModelNotFoundError.isInstance(new Error("x"))).toBe(false);
  });

  test("the gateway provider refuses to run", () => {
    expect(() => stub.gateway("anthropic/claude-haiku-4.5")).toThrow(/agent-py/);
  });

  test("names no secret", () => {
    const source = readFileSync(new URL("./ai-sdk-gateway.ts", import.meta.url), "utf8");
    expect(source).not.toContain("AI_GATEWAY_API_KEY");
  });
});
