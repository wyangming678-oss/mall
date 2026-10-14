import { AppError } from "./errors.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

export function vUuid(v, field) {
  if (!isUuid(v)) throw new AppError(400, "invalid_request", "参数不合法", { field });
  return String(v).toLowerCase();
}

export function vStr(v, field, { min = 0, max = 5000, optional = false, pattern = null } = {}) {
  if (v === undefined || v === null || v === "") {
    if (optional) return null;
    throw new AppError(400, "invalid_request", "缺少必填参数", { field });
  }
  if (typeof v !== "string") throw new AppError(400, "invalid_request", "参数类型错误", { field });
  const s = v.trim();
  if (s.length < min || s.length > max) {
    throw new AppError(400, "invalid_request", "长度超出限制", { field, min, max });
  }
  if (pattern && !pattern.test(s)) throw new AppError(400, "invalid_request", "格式不正确", { field });
  return s;
}

export function vEnum(v, field, allowed, { optional = false } = {}) {
  if ((v === undefined || v === null || v === "") && optional) return null;
  if (typeof v !== "string" || !allowed.includes(v)) {
    throw new AppError(400, "invalid_request", "取值不在白名单", { field, allowed });
  }
  return v;
}

export function vInt(v, field, { min = 0, max = 999, optional = false } = {}) {
  if ((v === undefined || v === null || v === "") && optional) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new AppError(400, "invalid_request", "数值不合法", { field, min, max });
  }
  return n;
}

// 评分（products.rating_avg 在库里是 text）：0–5，落库保留两位小数字符串；空值 = 未评分
export function vRating(v, field) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n < 0 || n > 5) {
    throw new AppError(400, "invalid_request", "评分不合法", { field, min: 0, max: 5 });
  }
  return String(Math.round(n * 100) / 100);
}

export function vBool(v, field, { optional = false } = {}) {
  if ((v === undefined || v === null) && optional) return null;
  if (typeof v !== "boolean") throw new AppError(400, "invalid_request", "必须为布尔值", { field });
  return v;
}

export function vJson(v, field, { optional = false, maxItems = 50 } = {}) {
  if ((v === undefined || v === null) && optional) return null;
  if (typeof v !== "object") throw new AppError(400, "invalid_request", "必须为对象/数组", { field });
  const size = Array.isArray(v) ? v.length : Object.keys(v).length;
  if (size > maxItems) throw new AppError(400, "invalid_request", "条目过多", { field, maxItems });
  return v;
}

// 业务数据译文列（*_i18n）的统一口径：只收白名单语言、trim 后空串不落库、逐语言限长。
// 缺省返回 {}（绝不返回 null）—— 库里 *_i18n 为 jsonb，函数侧给 null 会撞 NOT NULL 且前端回落逻辑拿不到对象。
export const I18N_LANGS = ["zh", "en", "ja", "ko", "es"];
export function vI18nMap(v, field, maxLen = 5000) {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new AppError(400, "invalid_request", "必须为语言→文案的对象", { field });
  }
  const out = {};
  for (const [lang, text] of Object.entries(v)) {
    if (!I18N_LANGS.includes(lang)) continue;
    if (text === undefined || text === null) continue;
    if (typeof text !== "string") throw new AppError(400, "invalid_request", "译文必须为字符串", { field: `${field}.${lang}` });
    const s = text.trim();
    if (!s) continue;
    if (s.length > maxLen) {
      throw new AppError(400, "invalid_request", "译文长度超出限制", { field: `${field}.${lang}`, maxLen });
    }
    out[lang] = s;
  }
  return out;
}

export async function readJson(request, limitBytes = 262144) {
  const text = await request.text();
  if (text.length > limitBytes) throw new AppError(400, "invalid_request", "请求体过大");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") throw new Error("shape");
    return parsed;
  } catch {
    throw new AppError(400, "invalid_request", "JSON 解析失败");
  }
}

export function stableStringify(value) {  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

export const nowIso = () => new Date().toISOString();

// 固定 limit=20、读 21 行判 has_more（文档C §〇.2）
export const PAGE_LIMIT = 20;

export function pageParams(query) {
  const offset = vInt(query?.offset ?? 0, "offset", { min: 0, max: 100000 });
  return { offset, limit: PAGE_LIMIT };
}

export function pageResult(rows, offset, limit = PAGE_LIMIT) {
  return {
    offset,
    limit,
    has_more: rows.length > limit,
    next_offset: rows.length > limit ? offset + limit : null,
    items: rows.slice(0, limit),
  };
}

// Sites 网关不回传 HEAD 计数的 Content-Range（head:true 时 count 恒为 null），
// 计数只能走带 limit(1) 的 GET——与 adminCount/bootstrap 门禁用的是同一条路径。
export async function countRows(builder) {
  const { count } = await builder.limit(1);
  return Number.isSafeInteger(count) ? count : 0;
}
