// 文件端点 F1–F3（文档C §七）：存储后端由 storageClient() 解析（平台注入模块 / Supabase / 冒烟假件）
import { ok, fail } from "./errors.mjs";
import { AppError } from "./errors.mjs";
import { requirePrincipal, requireAnyPrincipal } from "./auth.mjs";
import { hasPermission, loadAdminPermissions, requirePermission, writeAudit } from "./permissions.mjs";
import { vStr } from "./validate.mjs";
import { envValue, supabaseStorage } from "./storage.mjs";

const PREFIXES = ["avatars", "proofs", "products", "paycodes", "chat", "announcements", "brand"];
// 公开内容前缀：匿名访客也可取签名 URL（用户资产 avatars/proofs、收款码 paycodes 仍需登录）
const PUBLIC_URL_PREFIXES = ["brand", "products", "announcements"];
// F3 前缀→删除所需权限点；avatars/proofs 属用户资产，仅随业务记录处置，不开放直接删除
const REMOVE_PERMS = {
  products: "product.manage",
  announcements: "content.manage",
  paycodes: "site.pay_config",
  chat: "chat.handle",
  brand: "site.decorate",
};
// 签名 URL 有效期：平台契约 createSignedUrl(path, ttl) 的 ttl 取值范围 1–7200 秒。
// 前端按 F2 返回的 expires_in 缓存并提前复用，所以这里要给够一次浏览的时长，又不能太久（ bearer 能力）。
const SIGN_TTL_SECONDS = 1800;
const MAX_BYTES = 5 * 1024 * 1024;
// 一次批量取址的键上限：前端按「同一渲染周期内未命中的键」合并，一屏商品卡最多也就这么多。
const MAX_BATCH_KEYS = 20;
const BATCH_SIGN_CONCURRENCY = 5;
const KEY_SHAPE = /^[a-z]+\/[0-9a-f-]{36}\.(png|jpg|webp)$/;
const EXT_BY_MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47], "png"],
  [[0xff, 0xd8, 0xff], "jpg"],
];

export async function storageClient() {
  // 本地冒烟注入的无凭证假存储（globalThis 仅在测试进程里存在，部署态永远走下面的注入模块）
  if (globalThis.__MALL_STORAGE_FAKE__) return globalThis.__MALL_STORAGE_FAKE__;
  // 搬家分支：只有显式 MALL_STORAGE_BACKEND=supabase 才启用；现网不配 ⇒ 与搬家前逐字节一致。
  // 配了但 SUPABASE_URL/密钥/桶名任一项不合法，supabaseStorage() 自己抛同一个 503，不会静默回落到平台模块。
  if (String(envValue("MALL_STORAGE_BACKEND") ?? "").trim().toLowerCase() === "supabase") return supabaseStorage();
  try {
    const mod = await import("./_qoder/storage.mjs");
    const storage = mod.storage ?? mod.default;
    if (!storage) throw new Error("missing");
    return storage;
  } catch {
    throw new AppError(503, "internal_error", "文件存储运行时不可用");
  }
}

export function detectImage(bytes) {
  for (const [magic, ext] of EXT_BY_MAGIC) {
    if (magic.every((b, i) => bytes[i] === b)) return ext;
  }
  if (bytes.length >= 12) {
    const head = String.fromCharCode(...bytes.slice(0, 4));
    const tail = String.fromCharCode(...bytes.slice(8, 12));
    if (head === "RIFF" && tail === "WEBP") return "webp";
  }
  return null;
}

export function decodeBase64(value) {
  const clean = String(value ?? "").replace(/^data:[^;]+;base64,/, "");
  if (!clean || clean.length % 4 === 1) return null;
  try {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// 平台契约：storage.createSignedUrl(objectPath, ttl) → { signedUrl }（同源相对下载地址）。
// 严格版会把失败如实抛出，供 F2 区分「签名失败」与「文件不存在」；历史 bug 是漏传 ttl、读 .url，
// 于是永远得到 null 并被下游翻译成假的 404。
// 平台对「对象不存在」也走 throw（不给专门错误码），所以按 cause 文案分流：能判定为缺失 → 干净 404
// （前端已有占位图降级），其余（存储运行时/签名服务真故障）仍如实 502，绝不把宕机伪装成「文件不存在」。
// 判不出时宁可 502（可解释的服务态）也不误报 404（会让真故障静默）。
const MISSING_RE = /not\s*found|does\s*not\s*exist|no\s*such\s*(key|object|file)|object\s*missing|对象不存在|文件不存在|\b404\b/i;
async function signUrl(storage, key) {
  let u;
  try {
    u = await storage.createSignedUrl(key, SIGN_TTL_SECONDS);
  } catch (cause) {
    const msg = String(cause?.message ?? cause ?? "");
    if (MISSING_RE.test(msg)) throw new AppError(404, "not_found", "文件不存在");
    console.warn("file_sign_failed", { key, cause: msg });
    throw new AppError(502, "internal_error", "文件地址生成失败");
  }
  const url = typeof u === "string" ? u : u?.signedUrl ?? u?.url ?? null;
  if (!url) {
    console.warn("file_sign_empty", { key });
    throw new AppError(502, "internal_error", "文件地址生成失败");
  }
  return url;
}

// 分域部署（前端在 Pages/CDN、后端在别处）时，平台给的相对签名路径会去向**前端**源而 404。
// 只有显式配置 MALL_PUBLIC_ORIGIN（= 存储/后端自己的公开源）才改写响应里的地址；
// 不配就与现网同域部署逐字节一致。数据库里永远只存对象键，绝不写绝对地址。
function absoluteUrl(url) {
  if (!String(url ?? "").startsWith("/")) return url;
  const base = String(envValue("MALL_PUBLIC_ORIGIN") ?? "").trim().replace(/\/+$/, "");
  if (!base) return url;
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    console.warn("media_base_invalid", { base });
    return url;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/") {
    console.warn("media_base_not_origin", { base });
    return url;
  }
  return `${parsed.origin}${url}`;
}

// 降级版：业务视图（收款码/凭证/客服图…）宁可少显示一张图，也不能整单报错
async function signedUrl(storage, key) {
  try {
    return absoluteUrl(await signUrl(storage, key));
  } catch {
    return null;
  }
}

// 业务侧取签名 URL（收款码、凭证预览等），失败一律返回 null 由调用方降级
export async function signedUrlForKey(key) {
  if (!PREFIXES.includes(String(key).split("/")[0])) return null;
  try {
    const storage = await storageClient();
    return await signedUrl(storage, key);
  } catch {
    return null;
  }
}

// F2 归属校验：proofs/ 仅上传者本人或持 payment.review 的后台可读（文档C §七）
async function assertProofAccess(supabase, principal, key) {
  if (principal?.type === "admin") {
    const loaded = await loadAdminPermissions(supabase, principal.id);
    if (hasPermission(loaded.permissions, "payment.review")) return;
    throw new AppError(404, "not_found", "文件不存在");
  }
  const { data } = await supabase.from("payment_proofs")
    .select("id").eq("image_key", key).eq("uploaded_by", principal.id).maybeSingle();
  if (!data) throw new AppError(404, "not_found", "文件不存在");
}

// F1 上传（[I]；登录态 user/admin 皆可；访客只能上传客服图）
export async function fileUpload(supabase, request, body) {
  const principal = await requireAnyPrincipal(supabase, request);
  const prefix = vStr(body.prefix, "prefix", { min: 4, max: 14 });
  if (!PREFIXES.includes(prefix)) return fail("invalid_request", "prefix 不在白名单", { allowed: PREFIXES });
  // 访客主体（文档J §2.4）：file/upload 是 auth:"any"，不收口的话一枚访客令牌就能传头像/支付凭证
  if (principal.type === "guest" && prefix !== "chat") {
    return fail("permission_denied", "访客只能上传客服图片", null, 403);
  }
  const bytes = decodeBase64(body.data_base64);
  if (!bytes) return fail("invalid_request", "data_base64 非法");
  if (bytes.length > MAX_BYTES) return fail("invalid_request", "文件超过 5MB");
  const ext = detectImage(bytes);
  if (!ext) return fail("invalid_request", "仅支持 jpg/png/webp 图片");
  const key = `${prefix}/${crypto.randomUUID()}.${ext}`;
  const storage = await storageClient();
  const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  // 平台 upload 返回服务 JSON 且失败即 throw，不存在 { data, error } 包装
  try {
    await storage.upload(key, bytes, { contentType });
  } catch (cause) {
    console.warn("file_upload_failed", { key, cause: cause?.message ?? String(cause) });
    throw new AppError(502, "internal_error", "文件写入失败");
  }
  return ok({ key, preview_url: await signedUrl(storage, key), expires_in: SIGN_TTL_SECONDS });
}

// F2/F2b 共用的取址闸门（口径与原 file/url 逐字一致）：公开前缀匿名可取，其余需登录态，访客再加一道客服口。
function urlGateError(principal, prefix) {
  if (!principal && !PUBLIC_URL_PREFIXES.includes(prefix)) return new AppError(401, "unauthenticated");
  if (principal?.type === "guest" && !PUBLIC_URL_PREFIXES.includes(prefix) && prefix !== "chat") {
    return new AppError(403, "permission_denied", "访客只能读取客服图片");
  }
  return null;
}

// F2 签名短 URL（公开前缀匿名可取；其余需登录态；proofs/ 需归属校验）
export async function fileUrl(supabase, request, principal) {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  const prefix = key.split("/")[0];
  const gate = urlGateError(principal, prefix);
  if (gate) throw gate;
  if (!PREFIXES.includes(prefix) || !KEY_SHAPE.test(key)) {
    return fail("invalid_request", "key 非法");
  }
  if (prefix === "proofs") await assertProofAccess(supabase, principal, key);
  const storage = await storageClient();
  // 签发不预先下载整个文件去校验存在性；平台对缺失对象会在 createSignedUrl 阶段 throw，
  // 由 signUrl 分流成干净 404（悬空键属可解释的业务态，前端回落占位图），真·存储/签名故障仍 502。
  const url = await signUrl(storage, key);
  return ok({ key, url: absoluteUrl(url), expires_in: SIGN_TTL_SECONDS });
}

// F2b 批量签名 URL（一次一屏的键 → 一次请求；签名与权限口径与 F2 完全相同）
// 权限与键形状先整批校验再签发：绝不用「一半成功一半 401」的响应掩盖权限问题。
// 逐键阶段只把 404（这张图的对象不在）降级成该键失败，其余照常出地址；
// 502 是签发服务本身出了问题，与具体键无关，让它整批如实失败，免得现网只看到一堆 200。
export async function fileUrlBatch(supabase, request, body, principal) {
  if (!Array.isArray(body?.keys)) return fail("invalid_request", "keys 必须是字符串数组", { field: "keys" });
  const keys = [];
  for (const item of body.keys) {
    const key = String(item ?? "");
    if (key && !keys.includes(key)) keys.push(key);
  }
  if (!keys.length || keys.length > MAX_BATCH_KEYS) {
    return fail("invalid_request", `keys 需为 1–${MAX_BATCH_KEYS} 个对象键`, { max_keys: MAX_BATCH_KEYS, received: keys.length });
  }
  const bad = [];
  for (const key of keys) {
    const prefix = key.split("/")[0];
    const gate = urlGateError(principal, prefix);
    if (gate) throw gate;
    if (!PREFIXES.includes(prefix) || !KEY_SHAPE.test(key)) bad.push(key);
  }
  if (bad.length) return fail("invalid_request", "key 非法", { bad_keys: bad });

  const storage = await storageClient();
  const settle = async (key) => {
    try {
      if (key.split("/")[0] === "proofs") await assertProofAccess(supabase, principal, key);
      return { key, url: absoluteUrl(await signUrl(storage, key)) };
    } catch (error) {
      if (error instanceof AppError && error.status === 404) return { key, error: error.code };
      throw error;
    }
  };
  const settled = [];
  for (let i = 0; i < keys.length; i += BATCH_SIGN_CONCURRENCY) {
    settled.push(...await Promise.all(keys.slice(i, i + BATCH_SIGN_CONCURRENCY).map(settle)));
  }
  return ok({
    items: settled.filter((row) => row.url),
    failed: settled.filter((row) => !row.url).map((row) => ({ key: row.key, code: row.error })),
    expires_in: SIGN_TTL_SECONDS,
  });
}

// F3 删除（仅后台，按前缀权限点）
export async function fileRemove(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  const key = vStr(body.key, "key", { min: 8, max: 120 });
  const prefix = key.split("/")[0];
  if (!Object.prototype.hasOwnProperty.call(REMOVE_PERMS, prefix)) {
    return fail("invalid_request", "该前缀文件不可直接删除");
  }
  requirePermission(await loadAdminPermissions(supabase, actor.id), REMOVE_PERMS[prefix]);
  if (!/^[a-z]+\/[0-9a-f-]{36}\.(png|jpg|webp)$/.test(key)) return fail("invalid_request", "key 非法");
  const storage = await storageClient();
  await storage.remove([key]);
  await writeAudit(supabase, {
    adminId: actor.id, action: "file.remove", targetType: "storage", targetId: null, detail: { key },
  });
  return ok({ removed: key });
}
