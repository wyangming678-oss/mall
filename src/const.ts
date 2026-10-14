export const LANGUAGES = [ /* native-name */
  { code: "zh", name: "中文" },
  { code: "en", name: "English" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "es", name: "Español" },
] as const;

/** 内置客服邮箱：登录页「忘记密码」兜底展示，后台「公开客服联系方式」填了就以填的为准 */
export const SUPPORT_EMAIL = "chiccartcs@duck.com";


/**
 * 记账本位币：由 SiteProvider 在 bootstrap 后按 config.currency.base 注入「码 + 符号」，
 * 全站不得按某个币种（如 CNY/¥）写死查找或回落。未注入前码与符号均为空串：
 * 所有金额渲染点都在 ready（bootstrap 完成）之后，空符号只会出现在文案占位里，由 baseUnit() 兜底。
 */
let baseCode = "";
let baseSymbol = "";
export function setBaseCurrency(code?: string | null, symbol?: string | null): void {
  baseCode = typeof code === "string" && /^[A-Z]{3}$/.test(code) ? code : "";
  baseSymbol = typeof symbol === "string" && symbol.trim() ? symbol.trim() : baseCode;
}
/** 站点本位币码，未解析出时为空串 */
export function getBaseCode(): string {
  return baseCode;
}
/** 站点本位币符号，供「币种已下架/未注入」这类占位场景使用 */
export function getBaseSymbol(): string {
  return baseSymbol || baseCode;
}
export function formatBase(cents: number): string {
  return `${baseSymbol}${(Number(cents) / 100).toFixed(2)}`;
}
/** 文案里的货币单位占位：优先符号，回落币种码；两者都没解析出来时用通用货币记号 ¤（不写死某一币种） */
export function baseUnit(): string {
  return baseSymbol || baseCode || "¤";
}

export function displayAmount(cents: number, rateScaled: number, symbol: string): string {
  const v = (cents * rateScaled) / 1e6 / 100;
  return `${symbol}${v.toFixed(2)}`;
}

/** 业务数据（分类名/商品名/内容页标题）按语言取值：缺该语言依次回落 zh → 原文 */
export function pickLocalized(map: Record<string, string> | null | undefined, fallback: string, lang: string): string {
  if (map) {
    if (map[lang]) return map[lang];
    if (map.zh) return map.zh;
  }
  return fallback ?? "";
}
