// 余额提现（文档O，已冻结 V1.0）：平台把钱付给用户 ⇒ 无网关 ⇒ 人工线下打款。
// 复用 wallet.mjs 的 changeBalance CAS：申请即扣（负向 withdraw），驳回/撤销原路退回（正向 refund_in + reversal_of）。
// users 表不动、金币不动。状态机 PENDING→COMPLETED / PENDING→REJECTED，每步 CAS(=PENDING) + 幂等，副作用只跑一次。
import { AppError } from "./errors.mjs";
import { adminGuard, writeAudit } from "./permissions.mjs";
import { changeBalance, vAmount } from "./wallet.mjs";
import { getMergedConfig } from "./config.mjs";
import { emit } from "./notify.mjs";
import { nowIso, pageParams, pageResult, vEnum, vStr, vUuid } from "./validate.mjs";

const COLS = "id,user_id,amount_base,currency_code,fee_base,method,payout_account,status,review_note,"
  + "reviewed_by,reviewed_at,payout_ref,created_at,updated_at";
const USER_COLS = "id,username,nickname,email,phone,currency_code,balance";
const AMT_MAX = 999999999999;
const ROLLING_MS = 24 * 60 * 60 * 1000;
const STATUS_SET = ["PENDING", "COMPLETED", "REJECTED"];

// —— 收款方式（决策 4：银行卡 / USDT / USDC / PayPal，各自必填信息不同）——
// 四种方式 × 各自字段全部序列化进已有的 payout_account（text），零迁移；落库形态
// `KEY=value | KEY=value`，KEY 恒为大写英文（数据不外露给用户，展示层按 key 出本地化标签）。
const METHOD_SET = ["BANK", "USDT", "USDC", "PAYPAL"];
const NET_SET = ["TRC20", "ERC20", "BEP20"];
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,()（）·\-]{1,59}$/u; // 开户行/持卡人：允许中英数与常见分隔，挡掉 | 与 = 以免破坏序列化
const CARD_RE = /^[0-9A-Za-z]{6,34}$/; // 卡号 / CBU / IBAN 形状的账号
const MAIL_RE = /^[^\s@]+@[^\s@]+(?:\.[^\s@]+)+$/;
const ADDR_RE = {
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  ERC20: /^0x[0-9a-fA-F]{40}$/,
  BEP20: /^0x[0-9a-fA-F]{40}$/,
};

// 校验并按方式产出落库键值；字段不合法 ⇒ 400 + details.field，扣款一分不跑。
function payoutValues(method, raw) {
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (method === "BANK") {
    return {
      BANK_NAME: vStr(p.bank_name, "payout.bank_name", { min: 2, max: 60, pattern: NAME_RE }),
      HOLDER: vStr(p.holder_name, "payout.holder_name", { min: 2, max: 40, pattern: NAME_RE }),
      CARD_NO: vStr(p.card_no, "payout.card_no", { max: 34, pattern: CARD_RE }),
    };
  }
  if (method === "USDT" || method === "USDC") {
    const network = vEnum(p.network, "payout.network", NET_SET);
    return { NETWORK: network, ADDRESS: vStr(p.address, "payout.address", { max: 64, pattern: ADDR_RE[network] }) };
  }
  return { EMAIL: vStr(p.email, "payout.email", { max: 80, pattern: MAIL_RE }) };
}

const payoutText = (values) => Object.entries(values).map(([k, v]) => `${k}=${v}`).join(" | ");

// 旧版「自由文本 payout_account」解析不出 KEY=value ⇒ 整串当 RAW 回显，历史单不崩。
function payoutEntries(text) {
  const parts = String(text ?? "").split(" | ");
  const pairs = parts.map((s) => /^([A-Z][A-Z_]{1,11})=([\s\S]+)$/.exec(s));
  if (!pairs.length || pairs.some((m) => !m)) return [{ key: "RAW", value: String(text ?? "") }];
  return pairs.map((m) => ({ key: m[1], value: m[2] }));
}

const withPayout = (row) => ({ ...row, payout: payoutEntries(row.payout_account) });

// 站内信里的金额：按「元 + 币种码」出。裸 amount_base 是「分」，直接写进正文会让人把 1000.00 读成一万。
const moneyText = (base) => (Number(base) / 100).toFixed(2);

// 找到这笔提现当初扣余额的 withdraw 流水，退回时用它做 reversal_of 指向（资金溯源）。
async function originalWithdrawTxnId(supabase, withdrawalId) {
  const { data } = await supabase.from("wallet_txns").select("id")
    .eq("ref_type", "withdrawal").eq("ref_id", withdrawalId).eq("txn_type", "withdraw").maybeSingle();
  return data?.id ?? null;
}

// 驳回/撤销 = CAS 抢占 PENDING→REJECTED，成功后才退余额；退失败则翻回 PENDING 供重试。
// 不变式：只有赢得 CAS 的那一次才会退款；退款走 changeBalance（自身对 balance CAS + 幂等回滚），
// 故「扣一次、退一次」成立，重复请求拿不到 PENDING 直接 state 拒绝。
async function rejectAndRefund(supabase, row, { note, reviewerId }) {
  const now = nowIso();
  const patch = { status: "REJECTED", review_note: note, updated_at: now };
  if (reviewerId) { patch.reviewed_by = reviewerId; patch.reviewed_at = now; }
  const { data: flipped } = await supabase.from("withdrawals")
    .update(patch).eq("id", row.id).eq("status", "PENDING").select("id");
  if (!flipped?.length) return { ok: false, reason: "state" };
  const refund = await changeBalance(supabase, {
    userId: row.user_id, amount: row.amount_base, txnType: "refund_in",
    refType: "withdrawal", refId: row.id, idemKey: `withdraw:refund:${row.id}`,
    reversalOf: await originalWithdrawTxnId(supabase, row.id), remark: `提现退回 ${row.amount_base}`,
  });
  if (!refund.ok) {
    // 退回失败 ⇒ 撤回状态翻转，保持 PENDING，让买家/客服可重试（避免「已驳回却没退钱」）
    await supabase.from("withdrawals")
      .update({ status: "PENDING", review_note: null, updated_at: nowIso() })
      .eq("id", row.id).eq("status", "REJECTED");
    return { ok: false, reason: refund.reason };
  }
  return { ok: true, balance_after: refund.after };
}

// —— WD1 申请（买家 auth:user，扣余额建单 PENDING）——
export async function withdrawApply(supabase, principal, body) {
  const { config } = await getMergedConfig(supabase);
  const cfg = config.withdraw;
  if (!cfg.enabled) throw new AppError(409, "withdraw_disabled", "提现功能未开启", null);

  const amountBase = vAmount(body.amount_base, "amount_base", { min: 1, max: AMT_MAX });
  if (amountBase < cfg.min_amount_base) {
    throw new AppError(400, "below_min", "低于最低提现额", { min_amount_base: cfg.min_amount_base });
  }
  if (amountBase > cfg.max_amount_base) {
    throw new AppError(400, "above_max", "超过单笔提现上限", { max_amount_base: cfg.max_amount_base });
  }
  // W3：方式取自固定四种，必填信息按方式校验（银行卡三样 / USDT·USDC 链+地址 / PayPal 邮箱）
  const method = vEnum(body.method, "method", METHOD_SET);
  const payout = payoutValues(method, body.payout);

  const { data: user } = await supabase.from("users")
    .select("id,balance,currency_code").eq("id", principal.id).is("deleted_at", null).eq("status", "active").maybeSingle();
  if (!user) throw new AppError(404, "not_found");
  const currencyCode = user.currency_code || config.currency?.base || "USD";

  // W5：同人同时仅一笔 PENDING（应用层前置查，平台不能建 UNIQUE）
  const { data: pending, error: eP } = await supabase.from("withdrawals").select("id")
    .eq("user_id", principal.id).eq("status", "PENDING").limit(1);
  if (eP) throw new AppError(500, "internal_error");
  if (pending?.length) throw new AppError(409, "pending_exists", "已有提现申请在审核中，请先等待处理", null);

  // W8：滚动 24h 内提现单数不超过 daily_limit
  const since = new Date(Date.now() - ROLLING_MS).toISOString();
  const { data: recent, error: eR } = await supabase.from("withdrawals").select("id")
    .eq("user_id", principal.id).gte("created_at", since).limit(cfg.daily_limit);
  if (eR) throw new AppError(500, "internal_error");
  if ((recent?.length ?? 0) >= cfg.daily_limit) {
    throw new AppError(429, "daily_limit", "今日提现次数已用完，请稍后再试", null);
  }

  const withdrawalId = crypto.randomUUID();
  const now = nowIso();
  const debit = await changeBalance(supabase, {
    userId: principal.id, amount: -amountBase, txnType: "withdraw",
    refType: "withdrawal", refId: withdrawalId, remark: `提现 ${amountBase}`,
  });
  if (!debit.ok) {
    if (debit.reason === "insufficient") {
      throw new AppError(409, "insufficient_balance", "余额不足", { balance: debit.before ?? null, required: amountBase });
    }
    if (debit.reason === "conflict") throw new AppError(409, "claim_conflict", "余额正在变动，请重试", null);
    if (debit.reason === "duplicated") throw new AppError(409, "state_conflict", "该提现申请已处理，请刷新查看", null);
    throw new AppError(500, "internal_error");
  }

  const { error } = await supabase.from("withdrawals").insert({
    id: withdrawalId, user_id: principal.id, amount_base: amountBase, currency_code: currencyCode,
    fee_base: 0, method, payout_account: payoutText(payout), status: "PENDING",
    created_at: now, updated_at: now,
  });
  if (error) {
    // 建单失败补偿冲正（照 createBalancePayment：扣了钱但没落成单 ⇒ 原路退回）
    await changeBalance(supabase, {
      userId: principal.id, amount: amountBase, txnType: "refund_in", refType: "withdrawal", refId: withdrawalId,
      reversalOf: debit.txn_id, remark: "提现建单失败冲正",
    });
    throw new AppError(500, "internal_error");
  }

  await emit(supabase, {
    userId: principal.id, msgType: "withdraw_applied", title: "提现申请已受理",
    content: `提现 ${moneyText(amountBase)} ${currencyCode} 已受理，客服线下打款后会通知你`,
    refType: "withdrawal", refId: withdrawalId,
  });
  return {
    withdrawal_id: withdrawalId, status: "PENDING", amount_base: amountBase,
    currency_code: currencyCode, balance_after: debit.after,
  };
}

// —— WD2 我的提现记录（含门槛供前端展示）——
export async function withdrawList(supabase, principal, query) {
  const { config } = await getMergedConfig(supabase);
  const { offset, limit } = pageParams(query);
  const { data, error } = await supabase.from("withdrawals").select(COLS)
    .eq("user_id", principal.id).order("created_at", { ascending: false }).range(offset, offset + limit);
  if (error) throw new AppError(500, "internal_error");
  return { ...pageResult((data ?? []).map(withPayout), offset, limit), withdraw: config.withdraw };
}

// —— WD3 买家自助撤销 PENDING（→ REJECTED + 退余额，不另立 CANCELLED 态）——
export async function withdrawCancel(supabase, principal, body) {
  const id = vUuid(body.id, "id");
  const { data: row } = await supabase.from("withdrawals").select("id,user_id,amount_base,currency_code,status")
    .eq("id", id).eq("user_id", principal.id).maybeSingle();
  if (!row) throw new AppError(404, "not_found", "提现单不存在");
  if (row.status !== "PENDING") {
    throw new AppError(409, "state_conflict", "该提现单已不可撤销", { status: row.status });
  }
  const res = await rejectAndRefund(supabase, row, { note: "买家自助撤销", reviewerId: null });
  if (!res.ok) {
    if (res.reason === "state") throw new AppError(409, "state_conflict", "该提现单已被处理", null);
    throw new AppError(500, "internal_error");
  }
  await emit(supabase, {
    userId: principal.id, msgType: "withdraw_rejected", title: "提现已撤销",
    content: `提现 ${moneyText(row.amount_base)} ${row.currency_code} 已撤销，金额已退回余额`,
    refType: "withdrawal", refId: row.id,
  });
  return { withdrawal_id: row.id, status: "REJECTED", amount_base: row.amount_base, balance_after: res.balance_after };
}

// —— AN-WD1 后台提现列表（withdraw.review）——
export async function adminWithdrawList(supabase, request, query) {
  await adminGuard(supabase, request, "withdraw.review");
  const { offset, limit } = pageParams(query);
  let q = supabase.from("withdrawals").select(COLS).order("created_at", { ascending: false }).range(offset, offset + limit);
  const status = query?.status;
  if (STATUS_SET.includes(status)) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const { data: users } = userIds.length
    ? await supabase.from("users").select(USER_COLS).in("id", userIds)
    : { data: [] };
  const byId = Object.fromEntries((users ?? []).map((u) => [u.id, u]));
  return pageResult(rows.map((r) => ({ ...withPayout(r), user: byId[r.user_id] ?? null })), offset, limit);
}

// —— AN-WD2 后台单笔详情（附用户 + 扣款流水溯源）——
export async function adminWithdrawDetail(supabase, request, query) {
  await adminGuard(supabase, request, "withdraw.review");
  const id = vUuid(query.id, "id");
  const { data: row, error } = await supabase.from("withdrawals").select(COLS).eq("id", id).maybeSingle();
  if (error) throw new AppError(500, "internal_error");
  if (!row) throw new AppError(404, "not_found", "提现单不存在");
  const { data: user } = await supabase.from("users").select(USER_COLS).eq("id", row.user_id).maybeSingle();
  const { data: txn } = await supabase.from("wallet_txns")
    .select("id,amount,balance_before,balance_after,created_at").eq("ref_type", "withdrawal").eq("ref_id", id).maybeSingle();
  return { ...withPayout(row), user: user ?? null, withdraw_txn: txn ?? null };
}

// —— AN-WD3 标记线下已打款 → COMPLETED（纯状态翻转，不再动余额；⚠ highRisk）——
export async function adminWithdrawDone(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "withdraw.review");
  const id = vUuid(body.id, "id");
  const payoutRef = vStr(body.payout_ref, "payout_ref", { min: 1, max: 120, optional: true });
  const note = vStr(body.review_note, "review_note", { min: 1, max: 500, optional: true });
  const now = nowIso();
  const { data: flipped, error } = await supabase.from("withdrawals")
    .update({ status: "COMPLETED", payout_ref: payoutRef, review_note: note, reviewed_by: actor.id, reviewed_at: now, updated_at: now })
    .eq("id", id).eq("status", "PENDING").select("id,user_id,amount_base,currency_code");
  if (error) throw new AppError(500, "internal_error");
  if (!flipped?.length) {
    const { data: exist } = await supabase.from("withdrawals").select("status").eq("id", id).maybeSingle();
    if (!exist) throw new AppError(404, "not_found", "提现单不存在");
    throw new AppError(409, "state_conflict", "该提现单已处理", { status: exist.status });
  }
  const row = flipped[0];
  await emit(supabase, {
    userId: row.user_id, msgType: "withdraw_completed", title: "提现已到账",
    content: `提现 ${moneyText(row.amount_base)} ${row.currency_code} 已线下打款完成`,
    refType: "withdrawal", refId: id,
  });
  await writeAudit(supabase, {
    adminId: actor.id, action: "withdraw.done", targetType: "withdrawal", targetId: id,
    detail: { amount_base: row.amount_base, payout_ref: payoutRef },
  });
  return { withdrawal_id: id, status: "COMPLETED" };
}

// —— AN-WD4 驳回 → REJECTED + 退余额（原因必填；⚠ highRisk）——
export async function adminWithdrawReject(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "withdraw.review");
  const id = vUuid(body.id, "id");
  const reason = vStr(body.review_note, "review_note", { min: 1, max: 500 });
  const { data: row, error } = await supabase.from("withdrawals")
    .select("id,user_id,amount_base,currency_code,status").eq("id", id).maybeSingle();
  if (error) throw new AppError(500, "internal_error");
  if (!row) throw new AppError(404, "not_found", "提现单不存在");
  if (row.status !== "PENDING") throw new AppError(409, "state_conflict", "该提现单已不可驳回", { status: row.status });
  const res = await rejectAndRefund(supabase, row, { note: reason, reviewerId: actor.id });
  if (!res.ok) {
    if (res.reason === "state") throw new AppError(409, "state_conflict", "该提现单已被处理", null);
    throw new AppError(500, "internal_error");
  }
  await emit(supabase, {
    userId: row.user_id, msgType: "withdraw_rejected", title: "提现被驳回",
    content: `提现 ${moneyText(row.amount_base)} ${row.currency_code} 未通过审核：${reason}，金额已退回余额`,
    refType: "withdrawal", refId: id,
  });
  await writeAudit(supabase, {
    adminId: actor.id, action: "withdraw.reject", targetType: "withdrawal", targetId: id,
    detail: { amount_base: row.amount_base, reason },
  });
  return { withdrawal_id: id, status: "REJECTED", amount_base: row.amount_base, balance_after: res.balance_after };
}
