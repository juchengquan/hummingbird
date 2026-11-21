/**
 * Ports + origins of the two servers `playwright.config.ts` starts. Both
 * are 127.0.0.1 (not `localhost`) so the page origin agent-py's CORS
 * allow-list names is exact. Override the ports with `E2E_WEB_PORT` /
 * `E2E_AGENT_PORT` if 3100 / 8100 are taken.
 */
export const HOST = "127.0.0.1"
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100)
export const AGENT_PORT = Number(process.env.E2E_AGENT_PORT ?? 8100)
export const WEB_ORIGIN = `http://${HOST}:${WEB_PORT}`
export const AGENT_PY_ORIGIN = `http://${HOST}:${AGENT_PORT}`
