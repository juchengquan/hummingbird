import { createCspReportHandler } from "@/server/security/csp-report"

/**
 * CSP violation reports (`report-uri` + `report-to` in the policy built
 * by `@/server/security/csp`, emitted by `proxy.ts`). Logs one compact
 * structured line per violation; never echoes input. See
 * `docs/SECURITY.md`.
 */
const handleCspReport = createCspReportHandler()

export async function POST(req: Request): Promise<Response> {
  return handleCspReport(req)
}
