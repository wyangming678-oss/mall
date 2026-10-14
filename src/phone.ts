// 前端区号选择器与号码规范化（与 functions/phone.mjs 的精选表保持一致；后端仍做权威校验）

export interface DialCode {
  dial: string; // 国际区号，纯数字，无前导 +
  iso: string;
  label: string; // 中文名，用于下拉（zh 兜底）
  name_i18n: Record<string, string>; // en/ja/ko/es 国家名；缺失语言回落 label
  national: RegExp; // 国内号码位数规则
}

// 精选 26 个常用国家/地区（表外国家回落通用 E.164）
export const DIAL_CODES: DialCode[] = [ /* i18n-fallback */
  { dial: "86", iso: "CN", label: "中国大陆", name_i18n: { en: "Mainland China", ja: "中国 本土", ko: "중국 대륙", es: "China continental" }, national: /^1[3-9]\d{9}$/ },
  { dial: "852", iso: "HK", label: "中国香港", name_i18n: { en: "Hong Kong, China", ja: "香港", ko: "홍콩", es: "Hong Kong, China" }, national: /^[2-9]\d{7}$/ },
  { dial: "853", iso: "MO", label: "中国澳门", name_i18n: { en: "Macau, China", ja: "マカオ", ko: "마카오", es: "Macao, China" }, national: /^6\d{7}$/ },
  { dial: "886", iso: "TW", label: "中国台湾", name_i18n: { en: "Taiwan, China", ja: "台湾", ko: "대만", es: "Taiwán, China" }, national: /^9\d{7,8}$/ },
  { dial: "65", iso: "SG", label: "新加坡", name_i18n: { en: "Singapore", ja: "シンガポール", ko: "싱가포르", es: "Singapur" }, national: /^[689]\d{7}$/ },
  { dial: "60", iso: "MY", label: "马来西亚", name_i18n: { en: "Malaysia", ja: "マレーシア", ko: "말레이시아", es: "Malasia" }, national: /^1\d{7,9}$/ },
  { dial: "66", iso: "TH", label: "泰国", name_i18n: { en: "Thailand", ja: "タイ", ko: "태국", es: "Tailandia" }, national: /^[13-9]\d{8}$/ },
  { dial: "84", iso: "VN", label: "越南", name_i18n: { en: "Vietnam", ja: "ベトナム", ko: "베트남", es: "Vietnam" }, national: /^[1-9]\d{8,9}$/ },
  { dial: "62", iso: "ID", label: "印度尼西亚", name_i18n: { en: "Indonesia", ja: "インドネシア", ko: "인도네시아", es: "Indonesia" }, national: /^[1-8]\d{7,11}$/ },
  { dial: "63", iso: "PH", label: "菲律宾", name_i18n: { en: "Philippines", ja: "フィリピン", ko: "필리핀", es: "Filipinas" }, national: /^[1-9]\d{8,9}$/ },
  { dial: "81", iso: "JP", label: "日本", name_i18n: { en: "Japan", ja: "日本", ko: "일본", es: "Japón" }, national: /^[789]\d{8}$/ },
  { dial: "82", iso: "KR", label: "韩国", name_i18n: { en: "South Korea", ja: "韓国", ko: "한국", es: "Corea del Sur" }, national: /^1[0-9]\d{7,8}$/ },
  { dial: "1", iso: "US_CA", label: "美国 / 加拿大", name_i18n: { en: "United States / Canada", ja: "アメリカ / カナダ", ko: "미국 / 캐나다", es: "Estados Unidos / Canadá" }, national: /^[2-9]\d{9}$/ },
  { dial: "44", iso: "GB", label: "英国", name_i18n: { en: "United Kingdom", ja: "イギリス", ko: "영국", es: "Reino Unido" }, national: /^[1-9]\d{9}$/ },
  { dial: "33", iso: "FR", label: "法国", name_i18n: { en: "France", ja: "フランス", ko: "프랑스", es: "Francia" }, national: /^[1-9]\d{8}$/ },
  { dial: "49", iso: "DE", label: "德国", name_i18n: { en: "Germany", ja: "ドイツ", ko: "독일", es: "Alemania" }, national: /^[1-9]\d{5,12}$/ },
  { dial: "39", iso: "IT", label: "意大利", name_i18n: { en: "Italy", ja: "イタリア", ko: "이탈리아", es: "Italia" }, national: /^[03]\d{8,10}$/ },
  { dial: "34", iso: "ES", label: "西班牙", name_i18n: { en: "Spain", ja: "スペイン", ko: "스페인", es: "España" }, national: /^[1-9]\d{8}$/ },
  { dial: "31", iso: "NL", label: "荷兰", name_i18n: { en: "Netherlands", ja: "オランダ", ko: "네덜란드", es: "Países Bajos" }, national: /^[1-9]\d{8}$/ },
  { dial: "41", iso: "CH", label: "瑞士", name_i18n: { en: "Switzerland", ja: "スイス", ko: "스위스", es: "Suiza" }, national: /^[1-9]\d{8,9}$/ },
  { dial: "61", iso: "AU", label: "澳大利亚", name_i18n: { en: "Australia", ja: "オーストラリア", ko: "호주", es: "Australia" }, national: /^[1-9]\d{8,9}$/ },
  { dial: "64", iso: "NZ", label: "新西兰", name_i18n: { en: "New Zealand", ja: "ニュージーランド", ko: "뉴질랜드", es: "Nueva Zelanda" }, national: /^[1-9]\d{7,9}$/ },
  { dial: "7", iso: "RU", label: "俄罗斯", name_i18n: { en: "Russia", ja: "ロシア", ko: "러시아", es: "Rusia" }, national: /^[1-9]\d{9}$/ },
  { dial: "91", iso: "IN", label: "印度", name_i18n: { en: "India", ja: "インド", ko: "인도", es: "India" }, national: /^[6-9]\d{9}$/ },
  { dial: "55", iso: "BR", label: "巴西", name_i18n: { en: "Brazil", ja: "ブラジル", ko: "브라질", es: "Brasil" }, national: /^[1-9]\d{9,10}$/ },
  { dial: "54", iso: "AR", label: "阿根廷", name_i18n: { en: "Argentina", ja: "アルゼンチン", ko: "아르헨티나", es: "Argentina" }, national: /^[1-9]\d{8,10}$/ },
  { dial: "971", iso: "AE", label: "阿联酋", name_i18n: { en: "United Arab Emirates", ja: "アラブ首長国連邦", ko: "아랍에미리트", es: "Emiratos Árabes Unidos" }, national: /^[1-9]\d{7,8}$/ },
];

export const DEFAULT_DIAL = "86";
const byDial = new Map(DIAL_CODES.map((d) => [d.dial, d]));
const digitsOnly = (v: string) => v.replace(/[^\d]/g, "");

/** 按语言取区号对应的国家/地区名；未知/缺省语言回落中文 label，表外区号显示 +数字 */
export function dialLabel(dial: string, lang: string): string {
  const digits = digitsOnly(dial);
  const entry = byDial.get(digits);
  if (!entry) return digits ? `+${digits}` : "";
  return lang === "zh" ? entry.label : entry.name_i18n[lang] ?? entry.label;
}

// 区号→意图币种（与 functions/phone.mjs 同步）
export const CURRENCY_BY_ISO: Record<string, string> = {
  CN: "CNY", HK: "HKD", MO: "MOP", TW: "TWD",
  SG: "SGD", MY: "MYR", TH: "THB", VN: "VND", ID: "IDR", PH: "PHP",
  JP: "JPY", KR: "KRW",
  US_CA: "USD", GB: "GBP",
  FR: "EUR", DE: "EUR", IT: "EUR", ES: "EUR", NL: "EUR",
  CH: "CHF", AU: "AUD", NZ: "NZD", RU: "RUB", IN: "INR", BR: "BRL", AE: "AED", AR: "ARS",
};

/** 注册时按区号预告币种（仅作提示；后端仍会依据站点已开通的币种列表最终裁决）
 *  未收录区号/空值返回 null，表示「没有币种意图」，由调用方回落站点本位币（与 functions/phone.mjs 同源） */
export function intentCurrencyForDial(dial: string): string | null {
  const entry = byDial.get(digitsOnly(dial));
  if (!entry) return null;
  return CURRENCY_BY_ISO[entry.iso] ?? null;
}

/** 区号 + 国内号码 → E.164；空号码返回 null，非法返回 { error, errorKey }（error 为中文兜底，errorKey 供前端 t() 本地化） */
export function buildE164(dial: string, rawNational: string): { value?: string; error?: string; errorKey?: string } {
  const entry = byDial.get(dial);
  if (!entry) return { error: "请选择有效的国家/地区区号", errorKey: "phone.err_region" }; /* i18n-fallback */
  const national = digitsOnly(rawNational);
  if (!national) return { error: "请输入号码", errorKey: "phone.err_empty" }; /* i18n-fallback */
  if (!entry.national.test(national)) return { error: `${entry.label}的号码格式不正确`, errorKey: "phone.err_format" }; /* i18n-fallback */
  return { value: `+${dial}${national}` };
}

/** 把已存 E.164 拆成 { dial, national }，供抽屉回填区号选择器；无法匹配已知区号时 dial 取最长前缀（≤4 位） */
export function splitE164(value: string | null | undefined): { dial: string; national: string } {
  if (!value) return { dial: DEFAULT_DIAL, national: "" };
  const digits = digitsOnly(value);
  const known = DIAL_CODES.filter((d) => digits.startsWith(d.dial)).sort((a, b) => b.dial.length - a.dial.length)[0];
  if (known) return { dial: known.dial, national: digits.slice(known.dial.length) };
  return { dial: DEFAULT_DIAL, national: digits };
}

/** 展示用：+区号 空格 国内号（抽屉/概览只读态） */
export function prettyE164(value: string | null | undefined): string {
  if (!value) return "";
  const { dial, national } = splitE164(value);
  return `+${dial} ${national}`;
}
