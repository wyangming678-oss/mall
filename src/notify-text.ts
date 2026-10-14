/**
 * 站内信 title/content 的落库中文 → 随语言取词（#250-C 续）。
 * 通知由状态机内联 emit（functions/*.mjs），title/content 是写死的中文串，不是 t() 出来的界面文案，
 * 所以永远不随语言切。这里按写库原文反查语言键（与 src/data-text.ts 同一套路）：
 * 命中取当前语种词，未命中（模板改过的历史行、后台手填正文、公告正文）原样显示 ⇒ 最坏等于修复前，不会显示空白。
 * 后台侧不调用本模块，看到的仍是写库原文。
 */

type TextFn = (key: string, fallback: string, vars?: Record<string, string | number>) => string;

// 标题：全部为无参静态串，17 条互不相同，直接整条精确反查（公告标题走记录里的 title_i18n，不会命中）
const TITLE: Record<string, string> = { /* i18n-fallback */
  "支付成功": "nt.order_paid.title",
  "订单已超时取消": "nt.order_timeout.title",
  "订单已发货": "nt.order_shipped.title",
  "订单已完成": "nt.order_completed.title",
  "退款申请已提交": "nt.refund_applied.title",
  "退款申请未通过": "nt.refund_rejected.title",
  "退款已到账": "nt.refund_full.title",
  "部分退款已到账": "nt.refund_part.title",
  "邀请奖励已到账": "nt.invite_reward.title",
  "充值已到账": "nt.recharge_credited.title",
  "会员已到期": "nt.vip_expired.title",
  "收货返币到账": "nt.coin_order_reward.title",
  "兑换成功": "nt.coin_redeem.title",
  "兑换商品已发货": "nt.coin_redeem_ship.title",
  "发票申请已提交": "nt.invoice_applied.title",
  "发票已开具": "nt.invoice_issued.title",
  "发票申请已作废": "nt.invoice_voided.title",
  "提现申请已受理": "nt.withdraw_applied.title",
  "提现已到账": "nt.withdraw_done.title",
  "提现已撤销": "nt.withdraw_cancel.title",
  "提现被驳回": "nt.withdraw_rejected.title",
};

// 正文：逐条对上函数侧模板，捕获组填进 {no}/{carrier}/{tracking}/{note}/{reason}/… 未命中原样返回
const BODY: { re: RegExp; key: string; bind: (m: RegExpMatchArray) => Record<string, string> }[] = [ /* i18n-fallback */
  { re: /^订单 (\S+) 已支付成功，我们会在发货后第一时间通知你$/, key: "nt.order_paid.body", bind: (m) => ({ no: m[1] }) },
  { re: /^订单 (\S+) 超过支付时限已自动关闭，冻结的库存与优惠券已退回$/, key: "nt.order_timeout.body", bind: (m) => ({ no: m[1] }) },
  { re: /^订单 (\S+) 已发出：(\S+) (\S+)（(.+)）$/, key: "nt.order_shipped.body_note", bind: (m) => ({ no: m[1], carrier: m[2], tracking: m[3], note: m[4] }) },
  { re: /^订单 (\S+) 已发出：(\S+) (\S+)$/, key: "nt.order_shipped.body", bind: (m) => ({ no: m[1], carrier: m[2], tracking: m[3] }) },
  { re: /^订单已自动确认收货，如需售后请在有效期内联系客服$/, key: "nt.order_completed.auto", bind: () => ({}) },
  { re: /^订单 (\S+) 已确认收货，交易完成$/, key: "nt.order_completed.manual", bind: (m) => ({ no: m[1] }) },
  { re: /^订单 (\S+) 的退款申请已提交，客服审核后会把结果发在这里$/, key: "nt.refund_applied.body", bind: (m) => ({ no: m[1] }) },
  { re: /^订单 (\S+) 的退款申请已由客服提交，审核通过后会把结果发在这里$/, key: "nt.refund_applied_cs.body", bind: (m) => ({ no: m[1] }) },
  { re: /^订单 (\S+) 退款完成，款项已按原路退回（余额支付部分退回钱包余额）$/, key: "nt.refund_full.body", bind: (m) => ({ no: m[1] }) },
  { re: /^订单 (\S+) 的部分退款已到账（(.+?) 基准）。一个订单只能退款一次，本单不再开放退款申请$/, key: "nt.refund_part.body", bind: (m) => ({ no: m[1], amount: m[2] }) },
  { re: /^订单 (\S+) 的退款申请被驳回：(.+)。订单与余额均未变动$/, key: "nt.refund_rejected.body", bind: (m) => ({ no: m[1], reason: m[2] }) },
  { re: /^一张邀请优惠券已放入你的券包，下单时可选用$/, key: "nt.invite_reward.coupon", bind: () => ({}) },
  { re: /^邀请奖励金币已到账，可在金币中心查看与兑换$/, key: "nt.invite_reward.coin", bind: () => ({}) },
  { re: /^邀请奖励已入账到你的余额，可在钱包查看流水$/, key: "nt.invite_reward.balance", bind: () => ({}) },
  { re: /^你的扫码充值已由客服确认入账，可在钱包查看余额与流水$/, key: "nt.recharge_credited.body", bind: () => ({}) },
  { re: /^你的 (\S+) 会员权益已于 (\S+) 到期，此后下单不再享受会员折扣$/, key: "nt.vip_expired.body", bind: (m) => ({ tier: m[1], date: m[2] }) },
  { re: /^订单已完成，获得 (\S+) 金币，可在金币中心查看$/, key: "nt.coin_order_reward.body", bind: (m) => ({ reward: m[1] }) },
  { re: /^「(.+)」已放入你的券包$/, key: "nt.coin_redeem.coupon", bind: (m) => ({ title: m[1] }) },
  { re: /^「(.+)」兑换成功，会员权益已到账，有效期至 (\S+)$/, key: "nt.coin_redeem.vip", bind: (m) => ({ title: m[1], date: m[2] }) },
  { re: /^「(.+)」兑换成功，可在我的兑换查看$/, key: "nt.coin_redeem.virtual", bind: (m) => ({ title: m[1] }) },
  { re: /^「(.+)」兑换成功，等待发货$/, key: "nt.coin_redeem.physical", bind: (m) => ({ title: m[1] }) },
  { re: /^你的兑换商品已发出：(\S+) (\S+)$/, key: "nt.coin_redeem_ship.body", bind: (m) => ({ company: m[1], no: m[2] }) },
  { re: /^订单 (\S+) 的发票申请已提交，开具或作废结果会发在这里$/, key: "nt.invoice_applied.body", bind: (m) => ({ no: m[1] }) },
  { re: /^订单 (\S+) 的发票已开具，电子发票将发送至 (\S+)$/, key: "nt.invoice_issued.body", bind: (m) => ({ no: m[1], email: m[2] }) },
  { re: /^订单 (\S+) 的发票申请已作废：(.+)$/, key: "nt.invoice_voided.body", bind: (m) => ({ no: m[1], reason: m[2] }) },
  { re: /^提现 (\S+) (\S+) 已受理，客服线下打款后会通知你$/, key: "nt.withdraw_applied.body", bind: (m) => ({ amount: m[1], code: m[2] }) },
  { re: /^提现 (\S+) (\S+) 已线下打款完成$/, key: "nt.withdraw_done.body", bind: (m) => ({ amount: m[1], code: m[2] }) },
  { re: /^提现 (\S+) (\S+) 已撤销，金额已退回余额$/, key: "nt.withdraw_cancel.body", bind: (m) => ({ amount: m[1], code: m[2] }) },
  { re: /^提现 (\S+) (\S+) 未通过审核：(.+)，金额已退回余额$/, key: "nt.withdraw_rejected.body", bind: (m) => ({ amount: m[1], code: m[2], reason: m[3] }) },
];

export function notifyTitle(raw: string | null | undefined, text: TextFn): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const key = TITLE[s];
  return key ? text(key, s) : s;
}

export function notifyContent(raw: string | null | undefined, text: TextFn): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  for (const tpl of BODY) {
    const m = tpl.re.exec(s);
    if (!m) continue;
    return text(tpl.key, s, tpl.bind(m));
  }
  return s;
}
