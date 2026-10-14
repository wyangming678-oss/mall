// Vercel Node 函数共用：env 从 process.env 读，权限全由本仓库代码判定（RLS 对 anon 不放行）。
import { createClient } from "@supabase/supabase-js";

// 剥非 ASCII + trim：网页面板粘贴 env 值常带零宽/换行等不可见字符，会让校验静默失败⇒全站 503。
const clean = (value) => (typeof value === "string" ? value.replace(/[^\x20-\x7E]/g, "").trim() : value);
const rawEnv = (name) => clean(process.env[name]);

export const serviceKey = rawEnv("SUPABASE_SERVICE_ROLE_KEY") || "";

// 配了 service_role 时，SUPABASE_ANON_KEY 位置直接返回 service key（adapter 只按这一个键连库）。
export function env(name) {
  return serviceKey && name === "SUPABASE_ANON_KEY" ? serviceKey : rawEnv(name);
}

export function cronClient() {
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY 未配置");
  const url = (rawEnv("SUPABASE_URL") || "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/?#]+$/.test(url)) throw new Error("SUPABASE_URL 不是纯 origin");
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
