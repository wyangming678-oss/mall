// Vercel Node 函数入口：把 Node 的 (req, res) 桥接成 Web 的 (Request) => Response，
// 复用与 Deno 入口完全相同的一条链（CORS → 压缩 → adapter → handleApp）。
import { Readable } from "node:stream";
import { createClient } from "@supabase/supabase-js";
import { serveSite } from "../../../../functions/adapter.mjs";
import { withCompression } from "../../../../functions/compress.mjs";
import { withCors } from "../../../../functions/cors.mjs";
import { handleApp } from "../../../../functions/handler.mjs";
import { env } from "../../../../deploy/vercel-env.mjs";

const webHandler = withCors(withCompression(serveSite(handleApp, { createClient, env })), { env });

export default async function handler(req, res) {
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const url = new URL(req.url || "/", `${proto}://${host}`);

    const method = (req.method || "GET").toUpperCase();
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
      else headers.set(name, value);
    }

    const init = { method, headers };
    if (method !== "GET" && method !== "HEAD") {
      init.body = Readable.toWeb(req);
      init.duplex = "half";
    }

    const response = await webHandler(new Request(url, init));

    res.statusCode = response.status;
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() === "set-cookie") res.appendHeader(name, value);
      else res.setHeader(name, value);
    });
    const body = new Uint8Array(await response.arrayBuffer());
    res.end(body.byteLength ? body : undefined);
  } catch {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ error: "database_runtime_unavailable" }));
  }
}
