// 国际手机号规范化与校验（注册/登录/资料编辑共用；落库统一存 E.164：+区号+国内号码，纯数字）
import { AppError } from "./errors.mjs";

// 精选区号 + 各国国内号码位数规则（best-effort，移动端为主；表外国家回落到通用 E.164）
export const DIAL_CODES = [
  { dial: "86", iso: "CN", label: "中国大陆", national: /^1[3-9]\d{9}$/ },
  { dial: "852", iso: "HK", label: "中国香港", national: /^[2-9]\d{7}$/ },
  { dial: "853", iso: "MO", label: "中国澳门", national: /^6\d{7}$/ },
  { dial: "886", iso: "TW", label: "中国台湾", national: /^9\d{7,8}$/ },
  { dial: "65", iso: "SG", label: "新加坡", national: /^[689]\d{7}$/ },
  { dial: "60", iso: "MY", label: "马来西亚", national: /^1\d{7,9}$/ },
  { dial: "66", iso: "TH", label: "泰国", national: /^[13-9]\d{8}$/ },
  { dial: "84", iso: "VN", label: "越南", national: /^[1-9]\d{8,9}$/ },
  { dial: "62", iso: "ID", label: "印度尼西亚", national: /^[1-8]\d{7,11}$/ },
  { dial: "63", iso: "PH", label: "菲律宾", national: /^[1-9]\d{8,9}$/ },
  { dial: "81", iso: "JP", label: "日本", national: /^[789]\d{8}$/ },
  { dial: "82", iso: "KR", label: "韩国", national: /^1[0-9]\d{7,8}$/ },
  { dial: "1", iso: "US_CA", label: "美国 / 加拿大", national: /^[2-9]\d{9}$/ },
  { dial: "44", iso: "GB", label: "英国", national: /^[1-9]\d{9}$/ },
  { dial: "33", iso: "FR", label: "法国", national: /^[1-9]\d{8}$/ },
  { dial: "49", iso: "DE", label: "德国", national: /^[1-9]\d{5,12}$/ },
  { dial: "39", iso: "IT", label: "意大利", national: /^[03]\d{8,10}$/ },
  { dial: "34", iso: "ES", label: "西班牙", national: /^[1-9]\d{8}$/ },
  { dial: "31", iso: "NL", label: "荷兰", national: /^[1-9]\d{8}$/ },
  { dial: "41", iso: "CH", label: "瑞士", national: /^[1-9]\d{8,9}$/ },
  { dial: "61", iso: "AU", label: "澳大利亚", national: /^[1-9]\d{8,9}$/ },
  { dial: "64", iso: "NZ", label: "新西兰", national: /^[1-9]\d{7,9}$/ },
  { dial: "7", iso: "RU", label: "俄罗斯", national: /^[1-9]\d{9}$/ },
  { dial: "91", iso: "IN", label: "印度", national: /^[6-9]\d{9}$/ },
  { dial: "55", iso: "BR", label: "巴西", national: /^[1-9]\d{9,10}$/ },
  { dial: "54", iso: "AR", label: "阿根廷", national: /^[1-9]\d{8,10}$/ },
  { dial: "971", iso: "AE", label: "阿联酋", national: /^[1-9]\d{7,8}$/ },
];

const BY_DIAL = new Map(DIAL_CODES.map((d) => [d.dial, d]));
// 通用 E.164 兜底：+ 后 8–15 位数字（表内国家先过国内位数规则，更严）
const E164_RE = /^\+[1-9]\d{6,14}$/;

// 区号→币种映射（前端不做货币切换，结算币种由注册时的区号决定）
// US_CA 合并条目 → USD；欧元区（FR/DE/IT/ES/NL）→ EUR；未收录区号/表外 iso 视为无意图
export const CURRENCY_BY_ISO = {
  CN: "CNY", HK: "HKD", MO: "MOP", TW: "TWD",
  SG: "SGD", MY: "MYR", TH: "THB", VN: "VND", ID: "IDR", PH: "PHP",
  JP: "JPY", KR: "KRW",
  US_CA: "USD", GB: "GBP",
  FR: "EUR", DE: "EUR", IT: "EUR", ES: "EUR", NL: "EUR",
  CH: "CHF", AU: "AUD", NZ: "NZD", RU: "RUB", IN: "INR", BR: "BRL", AE: "AED", AR: "ARS",
};

// 从「注册时选择的区号」推导意图币种；区号未收录 / 号码留空 → null（表示「没有币种意图」，由调用方回落站点本位币）
// 返回 null 而不是 USD，是为了让「无意图」和「意图就是美元」在回落链上排到不同位置
export function intentCurrencyForDial(rawDial) {
  const entry = BY_DIAL.get(digitsOnly(rawDial));
  if (!entry) return null;
  return CURRENCY_BY_ISO[entry.iso] ?? null;
}

const digitsOnly = (v) => String(v ?? "").replace(/[^\d]/g, "");

// 区号选择器路径：注册/抽屉用 {dial_code, national} → 规范 E.164；非法抛 invalid_request
export function toE164(rawDial, rawNational) {
  const dial = digitsOnly(rawDial);
  const entry = BY_DIAL.get(dial);
  if (!entry) {
    throw new AppError(400, "invalid_request", "请选择有效的国家/地区区号", { field: "phone_dial_code" });
  }
  const national = digitsOnly(rawNational);
  if (!entry.national.test(national)) {
    throw new AppError(400, "invalid_request", `${entry.label}的号码格式不正确`, { field: "phone_national" });
  }
  return `+${dial}${national}`;
}

// 整串路径：登录/资料编辑给一个可能含空格或横线的 +区号号码 → 归一 E.164
// 已知区号则按国内位数规则校验；未知区号回落通用 E.164。空/非法返回 null（由调用方决定报错）
export function normalizePhoneString(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const e164 = `+${digitsOnly(s)}`;
  if (!E164_RE.test(e164)) throwPhone();
  // 用最长前缀匹配已知区号，命中则套用国内位数规则
  const digits = digitsOnly(s);
  const known = DIAL_CODES.filter((d) => digits.startsWith(d.dial))
    .sort((a, b) => b.dial.length - a.dial.length)[0];
  if (known && !known.national.test(digits.slice(known.dial.length))) throwPhone();
  return e164;
}

function throwPhone() {
  throw new AppError(400, "invalid_request", "手机号格式不正确（应为 +区号+号码）", { field: "phone" });
}
