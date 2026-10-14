// Deno Deploy 入口（搬家后用）。现网平台入口是 functions/index.ts，两者互不影响。
// 唯一差别：本文件在顶层注册 Deno.cron —— 平台的 Edge 运行时没有这个 API，
// 而平台只打包 functions/index.ts 那一棵 import graph，所以 cron 绝不能写进那里。
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY（cron 必需）、SUPABASE_ANON_KEY（未配 service key 时的 HTTP 回落）、
// MALL_TENANT_ID（单租户常量）、MALL_ALLOWED_ORIGINS（跨源白名单，留空=不启用 CORS 注入）。
// 文件端点：MALL_STORAGE_BACKEND（值必须精确是 supabase 才走 functions/storage.mjs 的 Supabase 适配层；
// 留空=走平台注入模块 _qoder/storage.mjs，脱离平台即全站文件端点 503）、MALL_STORAGE_BUCKET（私有桶名）、
// MALL_PUBLIC_ORIGIN（可选，仅把响应里的相对签名地址补成绝对地址；库里永远只存对象键）。
// 响应压缩：MALL_COMPRESSION（默认开，值 off 才关；只影响本入口，现网 functions/index.ts 不经过压缩层）。
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { serveSite } from "../functions/adapter.mjs";
import { withCompression } from "../functions/compress.mjs";
import { withCors } from "../functions/cors.mjs";
import { handleApp } from "../functions/handler.mjs";
import { tasksTickSystem } from "../functions/tasks.mjs";

const rawEnv = (name: string) => Deno.env.get(name);
const serviceKey = (rawEnv("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();

// 既定方案：搬家后后端以 service_role 连库，权限完全由本仓库代码判定，RLS 对 anon 不放行政策。
// 没配 service key 时仍读 SUPABASE_ANON_KEY，行为与搬家前一致。
const env = (name: string) => (serviceKey && name === "SUPABASE_ANON_KEY" ? serviceKey : rawEnv(name));

// 层次：CORS 在最外（预检不落库，且 503/403 也要带跨源头），压缩在中间 ⇒ 压缩层给的 vary 能与
// CORS 的 vary: origin 合并而不是互相覆盖，两条都得留住（否则共享缓存会串站）。
Deno.serve(withCors(withCompression(serveSite(handleApp, { createClient, env })), { env }));

function cronClient() {
  // 这里刻意只看 service key：anon key 在"默认拒绝"的策略下能让 cron 返回成功却一行都读不到，
  // 那种静默空跑比让 Deploy 记录一次失败更危险。
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY 未配置");
  const url = (rawEnv("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/?#]+$/.test(url)) throw new Error("SUPABASE_URL 不是纯 origin");
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// 表达式按 UTC，每 10 分钟一批；失败退避 30 秒 / 2 分钟 / 5 分钟。
// 与浏览器心跳并存是安全的：T1–T9 每行都有 CAS 认领，重复执行只会认领到 0 行。
Deno.cron("mall-expiry-tasks", "*/10 * * * *", { backoffSchedule: [30_000, 120_000, 300_000] }, async () => {
  const res = await tasksTickSystem(cronClient());
  console.log(`[cron] ran=${res.ran.join(",")} counts=${JSON.stringify(res.counts)} errors=${JSON.stringify(res.errors)}`);
});
