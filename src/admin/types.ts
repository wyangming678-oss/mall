export interface AdminMe {
  admin: { id: string; username: string; nickname: string; status: string };
  roleKeys: string[];
  permissions: string[];
}

export interface AdminAccount {
  id: string;
  username: string;
  nickname: string;
  status: string;
  created_at: string;
  roles: string[];
}

export interface RoleRow {
  role_key: string;
  permissions: string[];
}

export interface UserRow {
  id: string;
  username: string;
  nickname: string;
  email: string | null;
  phone?: string | null;
  language: string;
  currency_code: string;
  balance: number;
  invite_code: string;
  invited_by: string | null;
  status: string;
  created_at: string;
  has_payment_password?: boolean;
  coupon_unused?: number;
  // 需 user.ip_view 才会由后端下发；无权限时字段缺失
  register_ip?: string | null;
  last_login_ip?: string | null;
  last_login_at?: string | null;
}

// —— 商品评价 RV1/RV2 后台审核（A7）——
export interface AdminReviewRow {
  review_id: string;
  product_id: string;
  product_title: string;
  user_id: string;
  user_name: string;
  rating: number;
  content: string;
  images: string[];
  verified: boolean;
  order_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

// —— A9 发票管理后台行（admin/invoices）——
export interface AdminInvoiceRow {
  invoice_id: string;
  order_id: string;
  order_no: string | null;
  user_id: string;
  buyer: string | null;
  invoice_type: string;
  title: string;
  tax_no: string | null;
  email: string;
  remark: string | null;
  amount_base: number;
  currency_code: string | null;
  status: string;
  issued_at: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
}

// —— 优惠券 CY1/CY2 ——
export interface CouponTemplateRow {  id: string;
  name: string;
  name_i18n?: Record<string, string> | null;
  coupon_type: string;
  threshold_amount_base: number;
  discount_amount_base: number;
  scope: string;
  scope_ids: string[];
  valid_days: number;
  valid_from: string | null;
  valid_until: string | null;
  total_quota: number | null;
  unlimited: boolean;
  issued_count: number;
  per_user_limit: number;
  claimable: boolean;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AdminCouponRow {
  coupon_id: string;
  template_id: string;
  order_id: string | null;
  status: string;
  expire_at: string;
  source: string;
  created_at: string;
  name: string;
  coupon_type: string;
  threshold_amount_base: number;
  discount_amount_base: number;
  scope: string;
  scope_ids: string[];
  user_id: string;
  username: string;
  nickname: string;
}

export interface GrantResultRow {
  user_id: string;
  granted: boolean;
  duplicated?: boolean;
  coupon_id?: string | null;
  reason?: string;
}

export interface BatchGrantResult {
  template_id: string;
  requested: number;
  granted: number;
  results: GrantResultRow[];
}

export interface Paged<T> {
  total?: number | null;
  offset: number;
  limit: number;
  has_more?: boolean;
  next_offset?: number | null;
  items: T[];
}

// —— 邀请返利 CY4/CY5 ——
export interface InviteUserRef { id: string; username: string; nickname: string }

export interface InviteRewardBrief {
  id: string;
  relation_id: string;
  trigger_type: string;
  reward_type: string;
  reward_value: number;
  status: string;
}

export interface InviteRewardRow extends InviteRewardBrief {
  inviter_id: string;
  trigger_ref_id: string | null;
  coupon_template_id: string | null;
  user_coupon_id: string | null;
  wallet_txn_id: string | null;
  available_at: string | null;
  created_at: string;
  updated_at: string;
  inviter: InviteUserRef;
}

export interface InviteRelationRow {
  id: string;
  inviter_id: string;
  invitee_id: string;
  channel: string | null;
  created_at: string;
  inviter: InviteUserRef;
  invitee: InviteUserRef;
  rewards: InviteRewardBrief[];
}

export interface AuditRow {
  id: string;
  admin_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  detail: Record<string, unknown>;
  // 仅当查看者持有 user.ip_view 时后端才下发该字段
  ip?: string | null;
  created_at: string;
}
