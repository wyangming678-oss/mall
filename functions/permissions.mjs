// 权限点全集 + 默认角色（方案 §2；文档A §5）。角色关系软删语义：reactivate/insert/soft-delete，无需 delete 授权。
import { AppError } from "./errors.mjs";
import { requirePrincipal } from "./auth.mjs";
import { nowIso } from "./validate.mjs";

export const PERMISSION_POINTS = [
  "admin.manage",
  "user.read", "user.disable", "user.edit", "user.balance_adjust", "user.reset_password", "user.create", "user.ip_view",
  "order.read", "order.operate", "order.ship",
  "payment.review", "refund.review", "refund.offline_done",
  "withdraw.review",
  "product.read", "product.manage", "stock.adjust",
  "coupon.manage", "coupon.grant",
  "coin.manage", "coin.fulfill", "coin.adjust",
  "invite.read", "invite.manage",
  "vip.manage",
  "content.manage", "content.publish",
  "site.decorate", "site.pay_config", "site.currency",
  "chat.handle",
  "audit.read", "dashboard.read",
];

export const DEFAULT_ROLES = {
  super_admin: ["*"],
  operator: [
    "user.read", "user.create", "user.edit", "order.read", "order.operate", "order.ship",
    "product.read", "product.manage", "stock.adjust",
    "coupon.manage", "coupon.grant", "content.manage", "content.publish",
    "coin.manage", "coin.fulfill",
    "invite.read", "invite.manage",
    "site.decorate", "dashboard.read",
  ],
  support: ["user.read", "order.read", "chat.handle", "dashboard.read"],
};

export async function ensureDefaultRoles(supabase) {
  for (const [roleKey, perms] of Object.entries(DEFAULT_ROLES)) {
    for (const permissionKey of perms) {
      const { error } = await supabase.from("role_permissions").insert({
        id: crypto.randomUUID(), role_key: roleKey, permission_key: permissionKey,
      });
      if (error && error.code !== "23505") throw new AppError(500, "internal_error");
    }
  }
}

export async function loadAdminPermissions(supabase, adminId) {
  // 权限是鉴权决策读：DB 瞬态错误不能当成「空权限」，否则会把所有后台端点误判为 403。
  const { data: bindings, error: e1 } = await supabase.from("admin_roles")
    .select("role_key").eq("admin_id", adminId).is("deleted_at", null);
  if (e1) throw new AppError(503, "service_unavailable", "服务暂时不可用，请稍后重试");
  const roleKeys = (bindings ?? []).map((b) => b.role_key);
  if (!roleKeys.length) return { roleKeys, permissions: [] };
  const { data: perms, error: e2 } = await supabase.from("role_permissions")
    .select("permission_key").in("role_key", roleKeys).is("deleted_at", null);
  if (e2) throw new AppError(503, "service_unavailable", "服务暂时不可用，请稍后重试");
  return { roleKeys, permissions: [...new Set((perms ?? []).map((p) => p.permission_key))] };
}

export function hasPermission(permissions, point) {
  return permissions.includes("*") || permissions.includes(point);
}

export function requirePermission(loaded, point) {
  if (!hasPermission(loaded.permissions, point)) {
    throw new AppError(403, "permission_denied", "权限不足", { point });
  }
}

// 后台端点统一入口：admin 会话 + 逐端点权限点复验（方案 §19 原则 9）
export async function adminGuard(supabase, request, point) {
  const actor = await requirePrincipal(supabase, request, "admin");
  const loaded = await loadAdminPermissions(supabase, actor.id);
  requirePermission(loaded, point);
  return { actor, loaded };
}

// 期望集合与现存集合的软删式对齐（用于 admin_roles / role_permissions）
export async function syncMapping(supabase, table, ownColumn, ownValue, otherColumn, desired) {
  const { data: current } = await supabase.from(table)
    .select(`id,${otherColumn},deleted_at`).eq(ownColumn, ownValue);
  const desiredSet = new Set(desired);
  for (const row of current ?? []) {
    const active = !row.deleted_at;
    if (desiredSet.has(row[otherColumn]) && !active) {
      await supabase.from(table).update({ deleted_at: null }).eq("id", row.id);
    } else if (!desiredSet.has(row[otherColumn]) && active) {
      await supabase.from(table).update({ deleted_at: nowIso() }).eq("id", row.id);
    }
  }
  const existingKeys = new Set((current ?? []).map((r) => r[otherColumn]));
  for (const value of desiredSet) {
    if (!existingKeys.has(value)) {
      const { error } = await supabase.from(table).insert({
        id: crypto.randomUUID(), [ownColumn]: ownValue, [otherColumn]: value,
      });
      if (error && error.code !== "23505") throw new AppError(500, "internal_error");
    }
  }
}

export async function writeAudit(supabase, { adminId, action, targetType, targetId = null, detail, ip = null }) {
  const { error } = await supabase.from("audit_logs").insert({
    id: crypto.randomUUID(),
    admin_id: adminId,
    action,
    target_type: targetType,
    target_id: targetId,
    detail: detail ?? {},
    ip,
    created_at: nowIso(),
  });
  return !error;
}
