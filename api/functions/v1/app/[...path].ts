// Vercel Node 函数入口：把 Node 的 (req, res) 桥接成 Web 的 (Request) => Response，
// 复用与 Deno 入口完全相同的一条链（CORS → 压缩 → adapter → handleApp）。
// 路由经 vercel.json 的 rewrite 指到这里；本项目 Vercel 把 api 目录的 [...path] 只注册成
// 单段动态路由，多段路径收不进 pathname，故 rewrite 把整段接口路径塞进 query 参数 _p，
// 这里再据此还原真实 /functions/v1/app/<group>/<action>（handler 的 routeKey 只认末尾若干段）。
import { Readable } from "node:stream";
import { createClient } from "@supabase/supabase-js";
import { serveSite } from "../../../../functions/adapter.mjs";
import { withCompression } from "../../../../functions/compress.mjs";
import { withCors } from "../../../../functions/cors.mjs";
import { handleApp } from "../../../../functions/handler.mjs";
import { env } from "../../../../deploy/vercel-env.mjs";

// 层次与 deno-deploy.ts 一致：CORS 在最外（预检不落库，503/403 也要带跨源头），压缩在中间。
const webHandler = withCors(withCompression(serveSite(handleApp, { createClient, env })), { env });

export default async function handler(req, res) {
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const incoming = new URL(req.url || "/", `${proto}://${host}`);
    const splat = incoming.searchParams.get("_p");
    let url: URL;
    if (splat !== null) {
      // rewrite 把多段路径放进 _p：据此还原 pathname，其余 query（lang/limit…）原样保留。
      url = new URL(`${proto}://${host}/functions/v1/app/${splat.replace(/^\/+/, "")}`);
      for (const [key, value] of incoming.searchParams) {
        if (key !== "_p") url.searchParams.append(key, value);
      }
    } else {
      // 直接打函数（未经 rewrite）时按真实 pathname 走。
      url = incoming;
    }

    const method = (req.method || "GET").toUpperCase();
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
      else headers.set(name, value);
    }

    const init: { method: string; headers: Headers; body?: unknown; duplex?: string } = { method, headers };
    if (method !== "GET" && method !== "HEAD") {
      init.body = Readable.toWeb(req);
      init.duplex = "half";
    }

    const response = await webHandler(new Request(url, init as RequestInit));

    res.statusCode = response.status;
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() === "set-cookie") res.appendHeader(name, value);
      else res.setHeader(name, value);
    });
    const body = new Uint8Array(await response.arrayBuffer());
    res.end(body.byteLength ? body : undefined);
  } catch {
    // 与 adapter 同口径：不记录原始错误/租户/URL/凭据，只回不可用。
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ error: "database_runtime_unavailable" }));
  }
}
