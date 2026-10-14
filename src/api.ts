// 同源 API 客户端（文档C §〇：/functions/v1/app/<group>/<action>，信封 {ok,data|error}）
import { text } from "./i18n";

// VITE_API_BASE 留空 ⇒ 相对路径，与平台同源部署完全一致（现网默认，构建产物逐字节不变）。
// 填绝对地址时必须带上完整路径段，例如 https://mall.deno.dev/functions/v1/app：
// 后端 routeKey 按「路径末尾若干段」命中，保留这一段就不必改任何调用点。
const API_PATH = "/functions/v1/app";
const configured = String(import.meta.env.VITE_API_BASE ?? "").trim().replace(/\/+$/, "");
export const API_BASE = !configured ? API_PATH
  : /functions\/v1\/app$/.test(configured) ? configured : `${configured}${API_PATH}`;

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const tokenStore = {
  user: {
    get: () => localStorage.getItem("mall.user.token"),
    set: (v: string | null) => (v ? localStorage.setItem("mall.user.token", v) : localStorage.removeItem("mall.user.token")),
  },
  admin: {
    get: () => localStorage.getItem("mall.admin.token"),
    set: (v: string | null) => (v ? localStorage.setItem("mall.admin.token", v) : localStorage.removeItem("mall.admin.token")),
  },
  // 文档J §2.2：免注册客服的主体令牌，由 chat/open 服务端签发，只存在本机
  guest: {
    get: () => localStorage.getItem("mall.guest.token"),
    set: (v: string | null) => (v ? localStorage.setItem("mall.guest.token", v) : localStorage.removeItem("mall.guest.token")),
  },
};

export const newIdem = () => crypto.randomUUID();

/** 图片 → 私有桶对象键（F1）：凭证、退款截图等用户资产统一走函数侧代传 */
export async function uploadImageKey(file: File, prefix: string, token: "user" | "admin" | "chat" = "user"): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  const { key } = await call<{ key: string }>("file/upload", {
    method: "POST", token, idem: newIdem(),
    body: { name: file.name, data_base64: btoa(bin), prefix },
  });
  return key;
}

interface CallOptions {
  method?: "GET" | "POST";
  body?: unknown;
  token?: "user" | "admin" | "chat" | null;
  idem?: string;
  query?: Record<string, string | number | undefined | null>;
}

/** 客服路由的主体令牌：登录用户用本人令牌，否则用服务端签发的访客令牌（文档J §2.2） */
function chatToken(): string | null {
  return tokenStore.user.get() ?? tokenStore.guest.get();
}

export async function call<T = unknown>(path: string, opts: CallOptions = {}): Promise<T> {
  const { method = "GET", body, token, idem, query } = opts;
  const url = new URL(`${API_BASE}/${String(path).replace(/^\/+/, "")}`, location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {};
  const raw = token ? (token === "admin" ? tokenStore.admin.get() : token === "chat" ? chatToken() : tokenStore.user.get()) : null;
  if (raw) headers["x-mall-token"] = raw;
  if (idem) headers["idempotency-key"] = idem;
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError("network_error", text("api.network_failed", "网络请求失败"), 0);
  }
  let json: { ok: boolean; data?: T; error?: ApiErrorShape } | null = null;
  try {
    json = await response.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!json) throw new ApiError("internal_error", text("api.bad_response", "异常响应（{status}）", { status: response.status }), response.status);
  if (json.ok === true) return json.data as T;
  throw new ApiError(json.error?.code ?? "internal_error", json.error?.message ?? "", response.status, json.error?.details);
}
