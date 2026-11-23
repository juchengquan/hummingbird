// Stand-in for Kong: /auth/v1 -> GoTrue, /rest/v1 -> PostgREST. Local only.
const { AUTH, REST } = process.env
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*" }
Bun.serve({
  hostname: "127.0.0.1",
  port: 54871,
  idleTimeout: 120,
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
    const url = new URL(req.url)
    let target = ""
    if (url.pathname.startsWith("/auth/v1")) target = AUTH + url.pathname.slice(8)
    else if (url.pathname.startsWith("/rest/v1")) target = REST + url.pathname.slice(8)
    else return new Response("not found", { status: 404, headers: CORS })
    const headers = new Headers(req.headers)
    headers.delete("host")
    headers.delete("accept-encoding")
    if (!headers.has("authorization") && headers.has("apikey")) headers.set("authorization", `Bearer ${headers.get("apikey")}`)
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()
    const res = await fetch(target + url.search, { method: req.method, headers, body })
    const out = new Headers(res.headers)
    out.delete("content-encoding"); out.delete("content-length")
    for (const [k, v] of Object.entries(CORS)) out.set(k, v)
    return new Response(res.body, { status: res.status, headers: out })
  },
})
