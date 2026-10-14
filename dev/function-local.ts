// 本地 Deno 运行入口（dev/ 目录不属于发布产物）。
// 需要环境变量 SUPABASE_URL / SUPABASE_ANON_KEY，租户号来自 x-instance-id 请求头
// 或环境变量 MALL_TENANT_ID；站点为 private，云端数据库仅在发布后由 Qoder Sites 运行时注入，
// 本地通常无法直连。MALL_ALLOWED_ORIGINS 只在跨源调试时才需要配置。
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { serveSite } from "../functions/adapter.mjs";
import { withCors } from "../functions/cors.mjs";
import { handleApp } from "../functions/handler.mjs";

const env = (name: string) => Deno.env.get(name);

Deno.serve({ hostname: "127.0.0.1", port: 8000 }, withCors(serveSite(handleApp, {
  createClient,
  env,
}), { env }));
