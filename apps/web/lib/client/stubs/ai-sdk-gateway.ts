import "client-only";

// Browser stand-in for `@ai-sdk/gateway` (aliased in next.config.ts, browser
// builds only). The `ai` package imports the Vercel AI Gateway provider at its
// top level for its default string-model provider and its error wrapping; the
// editor's chat hook (components/editor/use-chat.ts) only uses `useChat` with
// a transport to agent-py, so the gateway never runs in the browser. The real
// module names the gateway's key variable, which the bundle audit forbids in
// client chunks (Q143) — this stub keeps it out. ai-sdk-gateway.test.ts pins the
// exports to what `ai` imports.

class NeverGatewayError extends Error {
  static isInstance: (error: unknown) => boolean = () => false;
}

export class GatewayAuthenticationError extends NeverGatewayError {}
export class GatewayModelNotFoundError extends NeverGatewayError {}

export function gateway(modelId: string): never {
  throw new Error(
    `The AI Gateway isn't available in the browser (asked for "${modelId}"); models run on agent-py.`,
  );
}
