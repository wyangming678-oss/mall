// 分期付款纯类型 + 前端算价镜像（与 functions/installments.mjs 同口径；此处只用于展示与选期，真金算价在函数侧）
// 文档N V1.0 D1–D7。

/** 商品级分期配置（存 products.extra.installment） */
export interface InstallmentProductConfig {
  enabled: boolean;
  periods: number[];
}

/** 单期明细（下单快照 installment_config.periods[]，含首付 index=1） */
export interface InstallmentSnapshotPeriod {
  index: number;
  amount_base: number;
  is_deposit?: boolean;
  due_date?: string | null;
}

/** 下单快照 installment_config（不可变） */
export interface InstallmentConfig {
  n: number;
  total_base: number;
  deposit_ratio: number;
  deposit_amount_base: number;
  tail_each_base: number;
  last_amount_base: number;
  created_at?: string;
  periods: InstallmentSnapshotPeriod[];
}

/** 账单里某一期（installment/bill.periods[]，含落库状态） */
export interface InstallmentBillPeriod {
  installment_index: number;
  amount_base: number;
  due_date: string | null;
  status: string;
  paid_at: string | null;
  payment_id: string | null;
  overdue: boolean;
}

/** 分期账单进度（summarizeBill 展开后的字段） */
export interface InstallmentBillSummary {
  n: number;
  paid_count: number;
  remaining_count: number;
  paid_base: number;
  remaining_base: number;
  confirmed_base: number;
  next_due_date: string | null;
  overdue_indexes: number[];
  fully_paid: boolean;
  periods: InstallmentBillPeriod[];
}

/** IB1 账单端点响应 */
export interface InstallmentBill extends InstallmentBillSummary {
  order_id: string;
  order_no: string;
  status_order: string;
  status_payment: string;
  installment_count: number;
  installment_config: InstallmentConfig | null;
  actual_paid_amount_base: number;
}

/** 后台订单详情里的分期视图（adminOrderDetail 的 installment 字段；非分期单为 null） */
export interface InstallmentAdminView extends InstallmentBillSummary {
  order_id: string;
  installment_count: number;
  installment_config: InstallmentConfig | null;
  status_payment: string;
  actual_paid_amount_base: number;
}

/** IB2 我的分期列表行 */
export interface InstallmentMyItem extends InstallmentBillSummary {
  id: string;
  order_no: string;
  status_order: string;
  status_payment: string;
  actual_paid_amount_base: number;
  currency_code: string;
  currency_actual_amount: number;
  installment_count: number;
  created_at: string;
}

/** installment/pay 响应（BALANCE 与 QR 两支合并成可选字段） */
export interface InstallmentPayResult {
  order_id: string;
  payment_id: string;
  installment_index: number | null;
  amount_base: number;
  balance_after?: number | null;
  started?: boolean;
  settled?: boolean;
  status_payment?: string;
  order_no?: string;
  amount_currency?: number;
  currency_code?: string;
  channel?: Record<string, unknown>;
  transfer_reference?: string;
}

/** installment/settle 响应 */
export interface InstallmentSettleResult {
  order_id: string;
  payment_id: string;
  installment_index?: number | null;
  amount_base: number;
  balance_after?: number | null;
  settled?: boolean;
  status_payment?: string;
  order_no?: string;
  amount_currency?: number;
  currency_code?: string;
  channel?: Record<string, unknown>;
  transfer_reference?: string;
}

// 与函数侧 INSTALLMENT_PERIODS / DEPOSIT_RATIO 完全一致（唯一真源在 functions/installments.mjs，改一处要同步这里）
export const INSTALLMENT_PERIODS = [2, 3, 6, 9, 12];
export const DEPOSIT_RATIO = 30;

/** 多商品同单：买家可选期数 = 各商品可选期数交集（与函数 intersectPeriods 同判据） */
export function intersectPeriods(configs: InstallmentProductConfig[]): number[] {
  const usable = configs.filter((c) => c && c.enabled);
  if (!usable.length || usable.length !== configs.length) return [];
  return usable.reduce<number[]>((acc, c) => {
    const base = acc.length ? acc : INSTALLMENT_PERIODS.slice();
    return base.filter((p) => c.periods.includes(p));
  }, INSTALLMENT_PERIODS.slice());
}

/** 结算页选期预览（前端镜像 functions computeSchedule；真金仍以函数下单快照为准） */
export interface SchedulePreview {
  n: number;
  total_base: number;
  deposit_amount_base: number;
  tail_each_base: number;
  last_amount_base: number;
  periods: { index: number; amount_base: number; is_deposit: boolean }[];
}
export function previewSchedule(totalBase: number, n: number): SchedulePreview | null {
  const P = Math.max(0, Math.round(Number(totalBase) || 0));
  if (!INSTALLMENT_PERIODS.includes(n)) return null;
  const depositBase = Math.round((P * DEPOSIT_RATIO) / 100);
  const tailTotal = P - depositBase;
  const m = n - 1;
  const each = m > 0 ? Math.floor(tailTotal / m) : 0;
  const tailDiff = tailTotal - each * m;
  const periods = [{ index: 1, amount_base: depositBase, is_deposit: true }];
  for (let k = 2; k <= n; k += 1) periods.push({ index: k, amount_base: each + (k === n ? tailDiff : 0), is_deposit: false });
  return { n, total_base: P, deposit_amount_base: depositBase, tail_each_base: each, last_amount_base: each + tailDiff, periods };
}
