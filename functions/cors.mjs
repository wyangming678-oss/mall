// 跨源闸门。只有显式配置 MALL_ALLOWED_ORIGINS 时才生效（= 脱离平台独立部署）；
// 未配置 ⇒ 一个 CORS 头都不注入，保持平台同源部署的响应逐字节不变
// （现网网关自己会在 GET 上回 access-control-allow-origin: *，我们再叠一个就成双值、浏览器直接报错）。
// Origin 缺失的请求（curl、支付网关的服务器回调）一律透传不拦 —— 这类请求本来就没有 Origin。

const ALLOWED_METHODS = "GET, POST, OPTIONS";
// 不回填 access-control-request-headers，固定返回这份名单：客户端要我们没列的头 ⇒ 预检失败，这是有意的。
const ALLOWED_HEADERS = "content-type, x-mall-token, idempotency-key";
const PREFLIGHT_MAX_AGE = "600";

const normalize = (value) => String(value ?? "").trim().replace(/\/+$/, "");

function parseAllowlist(raw) {
  const set = new Set();
  for (const item of String(raw ?? "").split(",")) {
    const origin = normalize(item);
    if (origin) set.add(origin);
  }
  return set;
}

function forbidden() {
  return new Response(JSON.stringify({ error: "origin_not_allowed" }), {
    status: 403,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function withCorsHeaders(headers, origin) {
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "origin");
  return headers;
}

export function withCors(inner, { env }) {
  // 惰性读：环境变量取不到（权限缺失/尚未配置）就按"未启用"处理 ⇒ 响应与今日完全一致。
  let cached;
  const allowlist = () => {
    if (!cached) {
      try {
        cached = parseAllowlist(env("MALL_ALLOWED_ORIGINS"));
      } catch {
        cached = new Set();
      }
    }
    return cached;
  };

  return async (request) => {
    if (allowlist().size === 0) return inner(request);
    const origin = normalize(request.headers.get("origin"));
    if (!origin) return inner(request);

    let self = "";
    try {
      self = new URL(request.url).origin;
    } catch {
      self = "";
    }
    if (!allowlist().has(origin) && origin !== self) return forbidden();

    if (request.method === "OPTIONS" && request.headers.get("access-control-request-method")) {
      return new Response(null, {
        status: 204,
        headers: withCorsHeaders(new Headers({
          "access-control-allow-methods": ALLOWED_METHODS,
          "access-control-allow-headers": ALLOWED_HEADERS,
          "access-control-max-age": PREFLIGHT_MAX_AGE,
          "cache-control": "no-store",
        }), origin),
      });
    }

    const response = await inner(request);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: withCorsHeaders(new Headers(response.headers), origin),
    });
  };
}
