/**
 * 余额/金币流水 remark 的落库中文 → 随语言取词（#250-C）。
 * 函数侧把中文写进 wallet_txns.remark / coin_txns.remark（payments/refunds/vip/invite/coins.mjs），
 * 那些不是 t() 出来的界面文案，所以永远不随语言切。这里按写库原文反查语言键：命中取当前语种词，
 * 未命中（后台手填的备注、模板改过的历史行）原样显示 ⇒ 最坏等于修复前，不会显示空白。
 * 后台侧不调用本模块，看到的仍是写库的原文（后台只有中文）。
 */

type TextFn = (key: string, fallback: string, vars?: Record<string, string | number>) => string;

// 整条精确相等的短语（无参）
const EXACT: Record<string, string> = { /* i18n-fallback */
  "扫码充值人工确认到账": "rmk.recharge_manual",
  "扫码分项驳回，余额分项补偿退还": "rmk.recharge_part_reject",
  "支付分项写入失败冲正": "rmk.pay_part_rollback",
  "支付超时自动取消": "rmk.cancel_timeout",
  "用户取消": "rmk.cancel_by_user",
  "会员支付分项写入失败冲正": "rmk.vip_part_rollback",
  "会员开通落库失败冲正": "rmk.vip_open_rollback",
  "邀请奖励金币到账": "rmk.invite_coin_granted",
  "邀请奖励金币撤销冲正": "rmk.invite_coin_reversed",
};

// 捕获组里的固定值：撤销原因的缺省串、邀请触发的枚举码（否则小语种界面会露出 first_order）
const PART: Record<string, string> = { /* i18n-fallback */
  "未填写": "rmk.no_reason",
  first_register: "me.trigger_first_register",
  first_order: "me.trigger_first_order",
  first_recharge: "me.trigger_first_recharge",
};

// 带参短语：逐条对上函数侧模板，捕获组填进 {no}/{name}/{n}/{title}/{reason}/{trigger}
const TEMPLATES: { re: RegExp; key: string; bind: (m: RegExpMatchArray) => Record<string, string> }[] = [ /* i18n-fallback */
  { re: /^订单 (\S+) 余额支付$/, key: "rmk.order_balance", bind: (m) => ({ no: m[1] }) },
  { re: /^订单 (\S+) 余额部分$/, key: "rmk.order_balance_part", bind: (m) => ({ no: m[1] }) },
  { re: /^订单 (\S+) 退款$/, key: "rmk.order_refund", bind: (m) => ({ no: m[1] }) },
  { re: /^开通会员 (.+)$/, key: "rmk.vip_open", bind: (m) => ({ name: m[1] }) },
  { re: /^邀请奖励到账（(\w+)）$/, key: "rmk.invite_reward", bind: (m) => ({ trigger: m[1] }) },
  { re: /^邀请奖励撤销冲正：(.+)$/, key: "rmk.invite_reward_reversed", bind: (m) => ({ reason: m[1] }) },
  { re: /^连续签到第 (\d+) 天$/, key: "rmk.checkin_streak", bind: (m) => ({ n: m[1] }) },
  { re: /^兑换 (.+)$/, key: "rmk.coin_redeem", bind: (m) => ({ title: m[1] }) },
  { re: /^兑换失败退回：(.+)$/, key: "rmk.coin_redeem_fail", bind: (m) => ({ title: m[1] }) },
  { re: /^撤销兑换退回：(.+)$/, key: "rmk.coin_revoke", bind: (m) => ({ reason: m[1] }) },
  { re: /^订单 (\S+) 收货返币$/, key: "rmk.order_coin_reward", bind: (m) => ({ no: m[1] }) },
];

export function dataText(raw: string | null | undefined, text: TextFn): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const exact = EXACT[s];
  if (exact) return text(exact, s);
  for (const tpl of TEMPLATES) {
    const m = tpl.re.exec(s);
    if (!m) continue;
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(tpl.bind(m))) {
      const part = PART[v];
      vars[k] = part ? text(part, v) : v;
    }
    return text(tpl.key, s, vars);
  }
  return s;
}
