// Anonymous reference adapter, not a sandbox or a database authorization layer.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unavailable = () => Response.json({ error: "database_runtime_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });

// Returns a Web Request handler for Deno.serve. Dependencies are runtime APIs,
// not user input; never supply environment or tenant values from request JSON.
export function serveSite(handler, { createClient, env, fetch: transport = globalThis.fetch, authMode = "anonymous" }) {
  return async (request) => {
    try {
      if (authMode !== "anonymous") return unavailable();
      // 平台部署时 x-instance-id 由网关注入；脱离平台无人注入 ⇒ 只有显式配置 MALL_TENANT_ID 才回落，
      // 且回落值取自环境变量而非请求头，否则任何客户端都能自带一个租户号。
      const configured = (env("MALL_TENANT_ID") ?? "").trim();
      const tenant = uuid.test(configured) ? configured : request.headers.get("x-instance-id");
      if (!tenant || !uuid.test(tenant)) return unavailable();
      const origin = new URL(env("SUPABASE_URL"));
      const anonKey = env("SUPABASE_ANON_KEY");
      if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || typeof anonKey !== "string" || !anonKey.trim()) return unavailable();
      const routedFetch = async (input, init) => {
        const outgoing = new Request(input, init);
        const url = new URL(outgoing.url);
        if (url.origin !== origin.origin || url.username || url.password || url.hash || /[%\\]/.test(url.pathname) || !(url.pathname === "/rest/v1" || url.pathname.startsWith("/rest/v1/"))) throw Error("database_runtime_unavailable");
        const headers = new Headers(outgoing.headers);
        headers.delete("x-qsites-origin");
        headers.delete("cookie");
        headers.set("x-instance-id", tenant);
        headers.set("apikey", anonKey);
        headers.set("authorization", `Bearer ${anonKey}`);
        const result = await transport(new Request(outgoing, { headers, redirect: "manual", credentials: "omit" }));
        if (result.status >= 300 && result.status < 400) {
          await result.body?.cancel();
          throw Error("database_runtime_unavailable");
        }
        return result;
      };
      const supabase = createClient(origin.origin, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: routedFetch },
      });
      const headers = new Headers(request.headers);
      for (const name of ["x-instance-id", "x-qsites-origin", "authorization", "cookie"]) headers.delete(name);
      return await handler({ request: new Request(request, { headers }), supabase });
    } catch {
      // Never log raw provider errors, tenant IDs, request URLs or credentials.
      return unavailable();
    }
  };
}
