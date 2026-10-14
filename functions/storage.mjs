// Storage 适配层（文档S §7 的 C 类缺口）。
// 平台注入模块 ./_qoder/storage.mjs 不在仓库里，脱离平台后必然 import 失败，所以搬家前先把这条分支补出来。
// 契约与平台模块逐字一致，files.mjs 的调用点因此一行不动：
//   upload(key, bytes, {contentType}) → 服务 JSON，失败即 throw（不存在 { data, error } 包装）
//   createSignedUrl(key, ttl)        → { signedUrl }
//   remove([key])                    → 服务 JSON
// 只实现这三个方法：全仓库没有 download 调用点（文档S §7 同一口径），不预先补没用的接口。
// 现网不配 MALL_STORAGE_BACKEND ⇒ 永远走平台模块，行为与搬家前一致。
import { AppError } from "./errors.mjs";

// 环境变量在 Deno（两种入口都是）读 Deno.env，本地 node 冒烟读 process.env。
// 读不到一律按「未配置」处理：Deno 缺 --allow-env 时 Deno.env.get 会 throw，这里必须吞掉。
export function envValue(name) {
  try {
    const fromDeno = globalThis.Deno?.env?.get?.(name);
    if (fromDeno !== undefined && fromDeno !== "") return fromDeno;
    return globalThis.process?.env?.[name];
  } catch {
    return undefined;
  }
}

const BUCKET_SHAPE = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;
const unavailable = () => new AppError(503, "internal_error", "文件存储运行时不可用");

// 逐段编码：既挡住 ../ 这类越权路径，又保留 products/<uuid>.webp 的层级。
function encodeKey(key) {
  const parts = String(key).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("storage_key_invalid");
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

// files.mjs 的 signUrl 靠错误文案把「对象不存在」分流成 404、其余留 502，
// 所以这里必须把 404 写成它能识别的样子，不能只丢一个 status。
function providerError(status, text) {
  const missing = status === 404 || /not\s*found|does\s*not\s*exist|no\s*such/i.test(text);
  return missing ? new Error(`storage object not found (${status})`) : new Error(`storage_http_${status} ${text.slice(0, 160)}`);
}

export function supabaseStorage() {
  const raw = String(envValue("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
  // 后端持 service key 直连（既定方案）；没配则回落 anon key，与数据库侧同一口径。
  const token = String(envValue("SUPABASE_SERVICE_ROLE_KEY") || envValue("SUPABASE_ANON_KEY") || "").trim();
  const bucket = String(envValue("MALL_STORAGE_BUCKET") ?? "").trim();
  let origin;
  try {
    origin = new URL(raw);
  } catch {
    throw unavailable();
  }
  if (!["http:", "https:"].includes(origin.protocol) || origin.pathname !== "/"
    || origin.username || origin.password || origin.search || origin.hash
    || !token || !BUCKET_SHAPE.test(bucket)) throw unavailable();

  const root = `${origin.origin}/storage/v1/object`;
  const auth = { apikey: token, authorization: `Bearer ${token}` };
  const read = async (response) => {
    const text = await response.text().catch(() => "");
    if (!response.ok) throw providerError(response.status, text);
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  };

  return {
    async upload(key, bytes, options) {
      const response = await globalThis.fetch(`${root}/${bucket}/${encodeKey(key)}`, {
        method: "POST",
        // 对象键里已含 uuid，不存在同名覆盖的正当场景，所以 upsert 关死。
        headers: { ...auth, "content-type": String(options?.contentType ?? "application/octet-stream"), "x-upsert": "false" },
        body: bytes,
      });
      return read(response);
    },
    async createSignedUrl(key, ttlSeconds) {
      const response = await globalThis.fetch(`${root}/sign/${bucket}/${encodeKey(key)}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: Number(ttlSeconds) }),
      });
      const payload = await read(response);
      // 服务端字段名是 signedURL，平台契约是 signedUrl ⇒ 归一发生在这一层，不在 files.mjs。
      const url = payload?.signedURL ?? payload?.signedUrl ?? null;
      if (!url) throw new Error("storage_sign_empty");
      return { signedUrl: String(url) };
    },
    async remove(keys) {
      const response = await globalThis.fetch(`${root}/${bucket}`, {
        method: "DELETE",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ prefixes: (Array.isArray(keys) ? keys : [keys]).map((k) => String(k)) }),
      });
      return read(response);
    },
  };
}
