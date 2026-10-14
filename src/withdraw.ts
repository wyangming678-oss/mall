// 提现收款方式（决策 4）：银行卡 / USDT / USDC / PayPal 四种固定方式，各自必填信息不同。
// 规则与 functions/withdrawals.mjs 一一对应；落库串 `KEY=value | KEY=value` 只由后端拼装，
// 这里负责表单渲染所需的字段清单、提交前预检（后端仍是权威）与回显 key → 本地化标签。

export const WD_NETS = ["TRC20", "ERC20", "BEP20"];

// 提现单笔上限的配置天花板 = 「不设限」（与 config.mjs 的 withdraw.max_amount_base 上限同值）
export const AMT_UNLIMITED = 999999999999;

// 与后端同形：TRC20 = T + 33 位 base58；ERC20 / BEP20 = 0x + 40 位十六进制
const ADDR_RE: Record<string, RegExp> = {
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  ERC20: /^0x[0-9a-fA-F]{40}$/,
  BEP20: /^0x[0-9a-fA-F]{40}$/,
};

export interface WdField {
  name: string; // 提交字段名（后端 payoutValues 的入参名）
  key: string; // 落库 / 回显的规范 key
  kind: "text" | "numeric" | "email" | "select";
  max: number;
  pattern?: RegExp;
  labelKey: string;
  zh: string; // t() 的中文兜底
}

// 规范 key → 输入框定义（含中文兜底标签，真值在 i18n.ts）
export const WD_FIELDS: Record<string, WdField> = { /* i18n-fallback */
  BANK_NAME: { name: "bank_name", key: "BANK_NAME", kind: "text", max: 60, pattern: /^[\p{L}\p{N}][\p{L}\p{N} .,()（）·\-]{1,59}$/u, labelKey: "withdraw.field.bank_name", zh: "开户行名称" },
  HOLDER: { name: "holder_name", key: "HOLDER", kind: "text", max: 40, pattern: /^[\p{L}\p{N}][\p{L}\p{N} .,()（）·\-]{1,39}$/u, labelKey: "withdraw.field.holder", zh: "持卡人姓名" },
  CARD_NO: { name: "card_no", key: "CARD_NO", kind: "numeric", max: 34, pattern: /^[0-9A-Za-z]{6,34}$/, labelKey: "withdraw.field.card_no", zh: "银行卡号" },
  NETWORK: { name: "network", key: "NETWORK", kind: "select", max: 8, labelKey: "withdraw.field.network", zh: "网络" },
  ADDRESS: { name: "address", key: "ADDRESS", kind: "text", max: 64, labelKey: "withdraw.field.address", zh: "收款地址" },
  EMAIL: { name: "email", key: "EMAIL", kind: "email", max: 80, pattern: /^[^\s@]+@[^\s@]+(?:\.[^\s@]+)+$/, labelKey: "withdraw.field.email", zh: "邮箱" },
};

export interface WdMethod { code: string; fields: WdField[] }

/** 后端把 payout_account 解出来的回显条目（旧版自由文本收款串落 RAW） */
export interface WdPayoutEntry { key: string; value: string }

export const WD_METHODS: WdMethod[] = [
  { code: "BANK", fields: [WD_FIELDS.BANK_NAME, WD_FIELDS.HOLDER, WD_FIELDS.CARD_NO] },
  { code: "USDT", fields: [WD_FIELDS.NETWORK, WD_FIELDS.ADDRESS] },
  { code: "USDC", fields: [WD_FIELDS.NETWORK, WD_FIELDS.ADDRESS] },
  { code: "PAYPAL", fields: [WD_FIELDS.EMAIL] },
];

export const wdMethod = (code: string): WdMethod => WD_METHODS.find((m) => m.code === code) ?? WD_METHODS[0];

/** 方式名：只有「银行卡」需要翻译，USDT / USDC / PayPal 语言中性，原样出 */
export const wdMethodName = (code: string, t: (k: string, zh?: string) => string) =>
  code === "BANK" ? t("withdraw.method.BANK", "银行卡") : code;

/** 回显用：落库 key → 当前语言的字段名；RAW（旧版自由文本收款串）返回空串，调用方只出值 */
export function payoutLabel(key: string, t: (k: string, zh?: string) => string): string {
  const f = WD_FIELDS[key];
  return f ? t(f.labelKey, f.zh) : "";
}

/** 按所选方式取出提交用的 payout 对象 */
export function pickPayout(m: WdMethod, values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(m.fields.map((f) => [f.name, (values[f.name] ?? "").trim()]));
}

/** 后端提现错误码 → 当前语言文案；未收录的码返回空串，由调用方回落后端原文 */
export function wdErrText(code: string, t: (k: string, zh?: string) => string): string {
  const hit: Record<string, [string, string]> = { /* i18n-fallback */
    withdraw_disabled: ["withdraw.err.disabled", "提现功能当前未开放"],
    pending_exists: ["withdraw.err.pending", "已有提现申请在审核中，请先等待处理"],
    daily_limit: ["withdraw.err.daily", "今日提现次数已用完，请稍后再试"],
    insufficient_balance: ["withdraw.err.insufficient", "可提现余额不足"],
    claim_conflict: ["withdraw.err.busy", "余额正在变动，请重试"],
    state_conflict: ["withdraw.err.state", "该提现单已处理，请刷新查看"],
    not_found: ["withdraw.err.gone", "提现单不存在"],
  };
  const key = hit[code];
  return key ? t(key[0], key[1]) : "";
}

/**
 * 提交前的本地预检（后端为权威校验）。
 * @returns 要展示给用户的文案；全部合格时返回空串
 */
export function payoutIssue(
  m: WdMethod,
  values: Record<string, string>,
  t: (k: string, zh?: string) => string,
  tf: (k: string, v: Record<string, string>, zh?: string) => string,
): string {
  const label = (f: WdField) => t(f.labelKey, f.zh);
  const bad = (f: WdField) => tf("withdraw.err.format", { field: label(f) }, "{field}：格式不正确");
  for (const f of m.fields) {
    const v = (values[f.name] ?? "").trim();
    if (!v) return tf("withdraw.err.required", { field: label(f) }, "{field}：请填写");
    if (f.key === "NETWORK") {
      if (!WD_NETS.includes(v)) return bad(f);
      continue;
    }
    if (f.key === "ADDRESS") {
      const re = ADDR_RE[values.network ?? ""];
      if (re && !re.test(v)) return t("withdraw.err.address", "收款地址与所选网络不符：TRC20 地址以 T 开头，ERC20 / BEP20 以 0x 开头");
      continue;
    }
    if (v.length > f.max || (f.pattern && !f.pattern.test(v))) return bad(f);
  }
  return "";
}
