// 后台账号/角色/用户管理/装修/币种/文案/审计（文档C §六 AM1-AM3, AU1-AU3/AU5, AN2-AN5, AS1）
import { AppError, ok, fail, isUniqueViolation } from "./errors.mjs";
import { hashPassword, verifyPassword, makeInviteCode } from "./crypto.mjs";
import { createSession, requirePrincipal, revokeSessions } from "./auth.mjs";
import {
  PERMISSION_POINTS, ensureDefaultRoles, loadAdminPermissions, requirePermission, hasPermission,
  syncMapping, writeAudit,
} from "./permissions.mjs";
import { seedCurrencies, saveConfigKeys, getMergedConfig, saveStrings, getCurrency, listConfigHistory, getConfigHistoryRow, rollbackConfig } from "./config.mjs";
import { changeBalance } from "./wallet.mjs";
import { storageClient } from "./files.mjs";
import { NON_METHOD_KEYS } from "./channels.mjs";
import { unusedCouponCounts } from "./coupons.mjs";
import { guardLoginAttempt, noteLoginFail, loginFailFeedback } from "./security.mjs";
import { normalizePhoneString, toE164 } from "./phone.mjs";
import { LANGS, publicUser, resolveRegisterCurrency } from "./users.mjs";
import { vStr, vEnum, vInt, vUuid, vJson, nowIso } from "./validate.mjs";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

const vPassword = (v, field = "password") => vStr(v, field, { min: 8, max: 64 });

function pageParams(query) {
  const offset = vInt(query.offset, "offset", { min: 0, max: 100000, optional: true }) ?? 0;
  const limit = vInt(query.limit, "limit", { min: 1, max: 50, optional: true }) ?? 20;
  return { offset, limit };
}

async function adminCount(supabase) {
  const { count } = await supabase.from("admins")
    .select("id", { count: "exact" }).is("deleted_at", null).limit(1);
  return Number.isSafeInteger(count) ? count : 0;
}

async function publicAdmin(supabase, adminId) {
  const { data } = await supabase.from("admins")
    .select("id,username,nickname,status,created_at").eq("id", adminId).is("deleted_at", null)
    .maybeSingle();
  if (!data) throw new AppError(404, "not_found");
  if (data.status !== "active") throw new AppError(403, "account_disabled");
  return data;
}

// —— AM1 初始化：仅当后台无任何账号时可用（方案 §22.2 演示管理员预置）——
export async function bootstrap(supabase, body) {
  if ((await adminCount(supabase)) > 0) {
    return fail("state_conflict", "后台账号已初始化，引导通道关闭", null, 410);
  }
  const username = vStr(body.username, "username", { min: 3, max: 20, pattern: USERNAME_RE });
  const password = vPassword(body.password);
  const nickname = vStr(body.nickname ?? username, "nickname", { min: 1, max: 30 });
  await ensureDefaultRoles(supabase);
  await seedCurrencies(supabase);
  const id = crypto.randomUUID();
  const { error } = await supabase.from("admins").insert({
    id, username, password_hash: await hashPassword(password), nickname,
    status: "active", created_at: nowIso(),
  });
  if (error) {
    if (isUniqueViolation(error)) return fail("claim_conflict", "用户名已存在", null, 409);
    throw new AppError(500, "internal_error");
  }
  await syncMapping(supabase, "admin_roles", "admin_id", id, "role_key", ["super_admin"]);
  await writeAudit(supabase, {
    adminId: id, action: "admin.bootstrap", targetType: "admin", targetId: id, detail: { username },
  });
  const token = await createSession(supabase, "admin", id);
  return ok({ token, admin: { id, username, nickname, status: "active" }, roleKeys: ["super_admin"], permissions: ["*"] });
}

export async function adminLogin(supabase, body, { ip = null } = {}) {
  const username = vStr(body.username, "username", { min: 1, max: 64 });
  const password = vStr(body.password, "password", { min: 1, max: 64 });
  const { fails } = await guardLoginAttempt(supabase, {
    scope: "admin_login", principalType: "admin", principalKey: username, body,
  });
  const { data } = await supabase.from("admins")
    .select("id,username,nickname,status,password_hash").eq("username", username).is("deleted_at", null).maybeSingle();
  if (!data || !(await verifyPassword(password, data.password_hash))) {
    // 仅真实存在的账号才计失败：不存在的用户名探测被丢弃，无法投毒锁定真实管理员
    if (data) await noteLoginFail(supabase, { principalType: "admin", principalKey: username, ip });
    return fail("unauthenticated", "用户名或密码错误", data ? loginFailFeedback(fails + 1) : null, 401);
  }
  if (data.status !== "active") return fail("account_disabled", "账号已禁用", null, 403);
  const admin = { id: data.id, username: data.username, nickname: data.nickname, status: data.status };
  await supabase.from("admins").update({ last_login_ip: ip }).eq("id", data.id);
  const token = await createSession(supabase, "admin", data.id);
  const loaded = await loadAdminPermissions(supabase, data.id);
  return ok({ token, admin, ...loaded });
}

export async function adminLogout(supabase, request) {
  const principal = await requirePrincipal(supabase, request, "admin");
  await revokeSessions(supabase, "admin", principal.id, null);
  return ok({ logged_out: true });
}

export async function adminMe(supabase, request) {
  const principal = await requirePrincipal(supabase, request, "admin");
  const admin = await publicAdmin(supabase, principal.id);
  const loaded = await loadAdminPermissions(supabase, admin.id);
  return ok({ admin, ...loaded });
}

// —— AM2 建/改后台账号（admin.manage）——
export async function saveAccount(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "admin.manage");
  const adminId = body.admin_id ? vUuid(body.admin_id, "admin_id") : null;
  const nickname = vStr(body.nickname, "nickname", { min: 1, max: 30 });
  const status = vEnum(body.status ?? "active", "status", ["active", "disabled"]);
  const roles = vJson(body.roles, "roles", { maxItems: 10 }).map(
    (r) => vStr(r, "roles[]", { min: 1, max: 40 }),
  );
  const password = body.password ? vPassword(body.password) : null;

  if (adminId) {
    const { data: target } = await supabase.from("admins")
      .select("id,username,status").eq("id", adminId).is("deleted_at", null).maybeSingle();
    if (!target) return fail("not_found", "后台账号不存在", null, 404);
    const loaded = await loadAdminPermissions(supabase, target.id);
    const wasSuper = loaded.roleKeys.includes("super_admin");
    const willSuper = roles.includes("super_admin");
    const demoting = wasSuper && !willSuper;
    const disabling = target.status === "active" && status === "disabled";
    if (demoting || disabling) {
      const { data: others } = await supabase.from("admin_roles")
        .select("admin_id").eq("role_key", "super_admin").is("deleted_at", null);
      const otherActive = (others ?? []).some((r) => r.admin_id !== target.id);
      if (!otherActive) return fail("state_conflict", "必须保留至少一个活跃的超级管理员", null, 409);
    }
    const patch = { nickname, status, updated_at: nowIso() };
    if (password) patch.password_hash = await hashPassword(password);
    const { error } = await supabase.from("admins").update(patch).eq("id", target.id);
    if (error) throw new AppError(500, "internal_error");
    await syncMapping(supabase, "admin_roles", "admin_id", target.id, "role_key", roles);
    if (status === "disabled" || password) await revokeSessions(supabase, "admin", target.id);
    await writeAudit(supabase, {
      adminId: actor.id, action: "admin.account_save", targetType: "admin", targetId: target.id,
      detail: { username: target.username, status, roles, password_changed: !!password },
    });
    return ok({ admin_id: target.id });
  }

  const username = vStr(body.username, "username", { min: 3, max: 20, pattern: USERNAME_RE });
  if (!password) return fail("invalid_request", "新建账号必须设置初始密码");
  const id = crypto.randomUUID();
  const { error } = await supabase.from("admins").insert({
    id, username, password_hash: await hashPassword(password), nickname,
    status: "active", created_at: nowIso(),
  });
  if (error) {
    if (isUniqueViolation(error)) return fail("claim_conflict", "用户名已存在", null, 409);
    throw new AppError(500, "internal_error");
  }
  await syncMapping(supabase, "admin_roles", "admin_id", id, "role_key", roles);
  await writeAudit(supabase, {
    adminId: actor.id, action: "admin.account_save", targetType: "admin", targetId: id,
    detail: { username, created: true, roles },
  });
  return ok({ admin_id: id });
}

// —— AM2a 删除后台账号（软删：列表、登录、会话全部失效，历史审计与操作记录保留）——
export async function deleteAccount(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "admin.manage");
  const adminId = vUuid(body.admin_id, "admin_id");
  if (adminId === actor.id) return fail("state_conflict", "不能删除当前登录的账号", null, 409);
  const { data: target } = await supabase.from("admins")
    .select("id,username,status").eq("id", adminId).is("deleted_at", null).maybeSingle();
  if (!target) return fail("not_found", "后台账号不存在", null, 404);
  // 与 saveAccount 的自锁口径一致：只看角色绑定，不看被删账号自身的状态
  if ((await loadAdminPermissions(supabase, target.id)).roleKeys.includes("super_admin")) {
    const { data: others } = await supabase.from("admin_roles")
      .select("admin_id").eq("role_key", "super_admin").is("deleted_at", null);
    if (!(others ?? []).some((r) => r.admin_id !== target.id)) {
      return fail("state_conflict", "必须保留至少一个超级管理员账号", null, 409);
    }
  }
  const now = nowIso();
  const { data: cas } = await supabase.from("admins")
    .update({ deleted_at: now, status: "disabled", updated_at: now })
    .eq("id", target.id).eq("status", target.status).select("id");
  if (!cas?.length) return fail("claim_conflict", "账号状态已变化，请刷新后重试", null, 409);
  const { error: roleErr } = await supabase.from("admin_roles")
    .update({ deleted_at: now }).eq("admin_id", target.id).is("deleted_at", null);
  if (roleErr) throw new AppError(500, "internal_error");
  await revokeSessions(supabase, "admin", target.id);
  await writeAudit(supabase, {
    adminId: actor.id, action: "admin.account_delete", targetType: "admin", targetId: target.id,
    detail: { username: target.username },
  });
  return ok({ admin_id: target.id, deleted: true });
}

export async function listAccounts(supabase, request) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "admin.manage");
  const { data } = await supabase.from("admins")
    .select("id,username,nickname,status,created_at").is("deleted_at", null).order("created_at");
  const { data: bindings } = await supabase.from("admin_roles")
    .select("admin_id,role_key").is("deleted_at", null);
  const rolesByAdmin = {};
  for (const b of bindings ?? []) {
    (rolesByAdmin[b.admin_id] ??= []).push(b.role_key);
  }
  return ok({ accounts: (data ?? []).map((a) => ({ ...a, roles: rolesByAdmin[a.id] ?? [] })) });
}

// —— AM3 角色权限全量替换（admin.manage）——
export async function saveRole(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "admin.manage");
  const roleKey = vStr(body.role_key, "role_key", { min: 1, max: 40, pattern: /^[a-z][a-z0-9_]{1,39}$/ });
  const list = vJson(body.permissions, "permissions", { maxItems: 60 }).map(
    (p) => vStr(p, "permissions[]", { min: 1, max: 60 }),
  );
  const bad = list.filter((p) => p !== "*" && !PERMISSION_POINTS.includes(p));
  if (bad.length) return fail("invalid_request", "包含未知权限点", { unknown: bad });
  if ((roleKey === "super_admin" || list.includes("*")) && !(await loadAdminPermissions(supabase, actor.id)).permissions.includes("*")) {
    return fail("permission_denied", "仅超级管理员可配置通配角色", null, 403);
  }
  await syncMapping(supabase, "role_permissions", "role_key", roleKey, "permission_key", list);
  await writeAudit(supabase, {
    adminId: actor.id, action: "admin.role_save", targetType: "role", targetId: null,
    detail: { role_key: roleKey, permissions: list },
  });
  return ok({ role_key: roleKey, permissions: list });
}

export async function listRoles(supabase, request) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "admin.manage");
  const { data } = await supabase.from("role_permissions")
    .select("role_key,permission_key").is("deleted_at", null).order("role_key");
  const roles = {};
  for (const row of data ?? []) (roles[row.role_key] ??= []).push(row.permission_key);
  return ok({
    roles: Object.entries(roles).map(([role_key, permissions]) => ({ role_key, permissions })),
    permission_points: PERMISSION_POINTS,
  });
}

// —— AU1 用户列表（user.read）——
export async function listUsers(supabase, request, query) {
  const actor = await requirePrincipal(supabase, request, "admin");
  const loaded = await loadAdminPermissions(supabase, actor.id);
  requirePermission(loaded, "user.read");
  // IP 属个人数据：默认只给 super，运营/客服角色需显式授予 user.ip_view
  const canIp = hasPermission(loaded.permissions, "user.ip_view");
  const { offset, limit } = pageParams(query);
  const { count: total } = await supabase.from("users")
    .select("id", { count: "exact" }).is("deleted_at", null).limit(1);
  let list = supabase.from("users")
    .select("id,username,nickname,email,phone,language,currency_code,balance,invite_code,invited_by,status,created_at,payment_password_hash,register_ip,last_login_ip,last_login_at")
    .is("deleted_at", null);
  const kw = query.keyword?.trim();
  if (kw) {
    const safe = kw.replace(/[%*(),".]/g, "");
    list = list.or(`username.ilike.*${safe}*,nickname.ilike.*${safe}*`);
  }
  const status = vEnum(query.status, "status", ["active", "disabled"], { optional: true });
  if (status) list = list.eq("status", status);
  const { data } = await list.order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  const rows = data ?? [];
  const couponCounts = await unusedCouponCounts(supabase, rows.map((u) => u.id));
  return ok({
    total: Number.isSafeInteger(total) ? total : 0,
    offset,
    limit,
    items: rows.map((u) => {
      // 支付密码哈希属敏感列，只对外暴露「是否已设」布尔，绝不外泄哈希
      const { payment_password_hash, ...rest } = u;
      const base = { ...rest, has_payment_password: Boolean(payment_password_hash), coupon_unused: couponCounts.get(u.id) ?? 0 };
      if (canIp) return base;
      const { register_ip, last_login_ip, last_login_at, ...noIp } = base;
      return noIp;
    }),
  });
}

// —— AU8 添加会员（user.create，⚠；文档J §一：替不会注册的顾客开号）——
// 与顾客自助注册的三点刻意差异：免人机验证（入口已有后台鉴权+登录锁定）、不受 switches.register_open 约束、
// 不签发会话令牌。谁开的号记在审计日志，users 表不加创建人列。
// 币种口径与自助注册同链（区号意图币种 → 站点本位币 → USD → 首个已开通），直接复用 resolveRegisterCurrency。
export async function adminUserCreate(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "user.create");
  const username = vStr(body.username, "username", { min: 3, max: 20, pattern: USERNAME_RE });
  const password = vPassword(body.password);
  const nickname = vStr(body.nickname ?? username, "nickname", { max: 30 });
  const email = body.email ? vStr(body.email, "email", { max: 120, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }) : null;
  const language = vEnum(body.language ?? "zh", "language", LANGS);
  // 手机号选填（填了必须能通过区号+号码校验）；D7 唯一约束在平台不可用 ⇒ 沿用应用层查重 + 插入冲突同形报错
  const phone = body.phone_national ? toE164(body.phone_dial_code, body.phone_national) : null;
  const currencyCode = await resolveRegisterCurrency(supabase, phone ? body.phone_dial_code : null);

  const { data: clash } = await supabase.from("users").select("id")
    .eq("username", username).is("deleted_at", null).maybeSingle();
  if (clash) return fail("claim_conflict", "用户名已被占用", null, 409);
  if (phone) {
    const { data: phoneHit } = await supabase.from("users").select("id").eq("phone", phone).is("deleted_at", null).maybeSingle();
    if (phoneHit) return fail("phone_taken", "该手机号已被注册", null, 409);
  }
  if (email) {
    const { data: emailHit } = await supabase.from("users").select("id").eq("email", email).is("deleted_at", null).maybeSingle();
    if (emailHit) return fail("claim_conflict", "邮箱已被占用", null, 409);
  }

  const id = crypto.randomUUID();
  const { error } = await supabase.from("users").insert({
    id, username, email, phone, password_hash: await hashPassword(password), nickname,
    language, currency_code: currencyCode, balance: 0,
    invite_code: makeInviteCode(), invited_by: null,
    register_ip: null, status: "active", created_at: nowIso(),
  });
  if (error) {
    if (isUniqueViolation(error)) {
      if (String(error.message ?? "").includes("phone")) return fail("phone_taken", "该手机号已被注册", null, 409);
      if (String(error.message ?? "").includes("username")) return fail("claim_conflict", "用户名已被占用", null, 409);
      return fail("claim_conflict", "请重试", null, 409);
    }
    throw new AppError(500, "internal_error");
  }
  await writeAudit(supabase, {
    adminId: actor.id, action: "user.create", targetType: "user", targetId: id,
    detail: { username, nickname, phone, source: "admin" },
  });
  return ok({ user: await publicUser(supabase, id) });
}

// —— AU2 禁用/启用（user.disable，⚠）——
export async function setUserStatus(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "user.disable");
  const userId = vUuid(body.user_id, "user_id");
  const status = vEnum(body.status, "status", ["active", "disabled"]);
  const { data: target } = await supabase.from("users")
    .select("id,username,status").eq("id", userId).is("deleted_at", null).maybeSingle();
  if (!target) return fail("not_found", "用户不存在", null, 404);
  const { error } = await supabase.from("users")
    .update({ status, updated_at: nowIso() }).eq("id", target.id);
  if (error) throw new AppError(500, "internal_error");
  if (status === "disabled") await revokeSessions(supabase, "user", target.id);
  await writeAudit(supabase, {
    adminId: actor.id, action: "user.disable", targetType: "user", targetId: target.id,
    detail: { username: target.username, from: target.status, to: status },
  });
  return ok({ user_id: target.id, status });
}

// —— AU3 余额调整（user.balance_adjust，⚠；文档B §3.4 CAS + wallet_txns 流水）——
export async function adjustUserBalance(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "user.balance_adjust");
  const userId = vUuid(body.user_id, "user_id");
  const delta = vInt(body.delta, "delta", { min: -999999999, max: 999999999 });
  if (delta === 0) return fail("invalid_request", "调整金额不能为 0");
  const remark = vStr(body.remark, "remark", { min: 2, max: 200 });
  const { data: target } = await supabase.from("users")
    .select("id,username,balance").eq("id", userId).is("deleted_at", null).maybeSingle();
  if (!target) return fail("not_found", "用户不存在", null, 404);
  const res = await changeBalance(supabase, {
    userId, amount: delta, txnType: "admin_adjust", refType: "admin_action", refId: actor.id,
    idemKey: request.headers.get("idempotency-key"), remark,
  });
  if (!res.ok) {
    if (res.reason === "insufficient") {
      return fail("insufficient_balance", "调整后余额不可为负", { balance: Number(target.balance), delta }, 409);
    }
    if (res.reason === "duplicated") return fail("state_conflict", "该笔调整已入账", null, 409);
    if (res.reason === "conflict") return fail("claim_conflict", "余额正在变动，请重试", null, 409);
    if (res.reason === "not_found") return fail("not_found", "用户不可用", null, 404);
    throw new AppError(500, "internal_error");
  }
  await writeAudit(supabase, {
    adminId: actor.id, action: "user.balance_adjust", targetType: "user", targetId: userId,
    detail: { username: target.username, delta, balance_before: res.before, balance_after: res.after, remark },
  });
  return ok({ user_id: userId, balance_before: res.before, balance_after: res.after, txn_id: res.txn_id });
}

// —— AU5 重置密码（user.reset_password，⚠）——
export async function resetUserPassword(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "user.reset_password");
  const userId = vUuid(body.user_id, "user_id");
  const password = vPassword(body.password);
  const { data: target } = await supabase.from("users")
    .select("id,username").eq("id", userId).is("deleted_at", null).maybeSingle();
  if (!target) return fail("not_found", "用户不存在", null, 404);
  const { error } = await supabase.from("users")
    .update({ password_hash: await hashPassword(password), updated_at: nowIso() }).eq("id", target.id);
  if (error) throw new AppError(500, "internal_error");
  await revokeSessions(supabase, "user", target.id);
  await writeAudit(supabase, {
    adminId: actor.id, action: "user.reset_password", targetType: "user", targetId: target.id,
    detail: { username: target.username },
  });
  return ok({ user_id: target.id, reset: true });
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PAY_PIN_RE = /^\d{6,20}$/;

// —— AU6 编辑用户资料（user.edit）：昵称/邮箱/号码，可清空；哈希等敏感列不在此通道 ——
export async function updateUserProfile(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "user.edit");
  const userId = vUuid(body.user_id, "user_id");
  const { data: target } = await supabase.from("users")
    .select("id,username,nickname,email,phone").eq("id", userId).is("deleted_at", null).maybeSingle();
  if (!target) return fail("not_found", "用户不存在", null, 404);

  const patch = { updated_at: nowIso() };
  const changed = {};
  if (body.nickname !== undefined) {
    const nickname = vStr(body.nickname, "nickname", { min: 1, max: 30 });
    if (nickname !== target.nickname) { patch.nickname = nickname; changed.nickname = nickname; }
  }
  if (body.email !== undefined) {
    // 空串/ null 视为清空；非空必须过邮箱格式（与注册同口径）
    const email = (body.email === null || body.email === "")
      ? null : vStr(body.email, "email", { max: 120, pattern: EMAIL_RE });
    if ((email ?? null) !== (target.email ?? null)) { patch.email = email; changed.email = email; }
  }
  if (body.phone !== undefined) {
    const phone = (body.phone === null || body.phone === "")
      ? null : normalizePhoneString(body.phone);
    if ((phone ?? null) !== (target.phone ?? null)) { patch.phone = phone; changed.phone = phone; }
  }
  if (Object.keys(changed).length === 0) return fail("invalid_request", "没有需要更新的字段");

  const { error } = await supabase.from("users").update(patch).eq("id", target.id);
  if (error) {
    if (isUniqueViolation(error) && String(error.message ?? "").includes("phone")) {
      return fail("phone_taken", "该手机号已被其他账号使用", null, 409);
    }
    throw new AppError(500, "internal_error");
  }
  await writeAudit(supabase, {
    adminId: actor.id, action: "user.update", targetType: "user", targetId: target.id,
    detail: { username: target.username, changed },
  });
  return ok({ user_id: target.id, updated: Object.keys(changed) });
}

// —— AU7 设置/清除支付密码（user.reset_password，⚠）：预留区域，落哈希不外泄 ——
export async function setUserPaymentPassword(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "user.reset_password");
  const userId = vUuid(body.user_id, "user_id");
  const { data: target } = await supabase.from("users")
    .select("id,username,payment_password_hash").eq("id", userId).is("deleted_at", null).maybeSingle();
  if (!target) return fail("not_found", "用户不存在", null, 404);
  // 传空/null 或 clear:true → 清除支付密码；否则必须是 6–20 位数字
  const clear = body.clear === true || body.payment_password === undefined
    || body.payment_password === null || body.payment_password === "";
  let hash = null;
  if (!clear) hash = await hashPassword(vStr(body.payment_password, "payment_password", { pattern: PAY_PIN_RE }));
  const { error } = await supabase.from("users")
    .update({ payment_password_hash: hash, updated_at: nowIso() }).eq("id", target.id);
  if (error) throw new AppError(500, "internal_error");
  // 支付密码不参与登录会话，无需吊销；仅留痕，detail 不含任何口令内容
  await writeAudit(supabase, {
    adminId: actor.id, action: "user.payment_password", targetType: "user", targetId: target.id,
    detail: { username: target.username, set: !clear },
  });
  return ok({ user_id: target.id, has_payment_password: !clear });
}

// 收款渠道注册表里的渠道码 = 除全局键（超时/墓碑）之外的所有键
const methodKeysOf = (pc) => Object.keys(pc ?? {}).filter((k) => !NON_METHOD_KEYS.includes(k));
// 当前被渠道引用的收款码对象键（禁用渠道仍引用原图，所以不算悬空）
// 文档L：币种级 image_key 也是收款码，换码/删币种后同样要清，否则 paycodes/ 里越攒越多
const paycodeKeysOf = (pc) => new Set(methodKeysOf(pc)
  .flatMap((k) => [
    pc?.[k]?.image_key,
    ...(Array.isArray(pc?.[k]?.chains) ? pc[k].chains.map((c) => c?.image_key) : []),
  ])
  .filter((key) => typeof key === "string" && key.startsWith("paycodes/")));

// 收款码图只被渠道条目引用：换码或删渠道后旧键成为悬空对象，顺带删掉，否则 paycodes/ 只增不减。
// 逐键删除（某键可能已被手工删过，不该连累其余）；存储不可用只跳过本次清理，配置照常生效，失败的那张图需手工删。
async function pruneOrphanPaycodes(beforePc, afterPc) {
  const orphans = [...paycodeKeysOf(beforePc)].filter((k) => !paycodeKeysOf(afterPc).has(k));
  const removed = [];
  const storage = await storageClient().catch(() => null);
  for (const key of orphans) {
    try {
      await storage?.remove([key]);
      if (storage) removed.push(key);
    } catch { /* 留待下次保存重试 */ }
  }
  return removed;
}

// —— AN2 装修保存（site.decorate，⚠；改了就生效）——
export async function saveDecor(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  const loaded = await loadAdminPermissions(supabase, actor.id);
  requirePermission(loaded, "site.decorate");
  const patch = body.config && typeof body.config === "object" ? body.config : null;
  if (!patch) return fail("invalid_request", "缺少 config 对象");
  // 收款渠道属 AN3 管辖：装修通道带 pay_channels 时需 site.pay_config
  const withPay = Object.prototype.hasOwnProperty.call(patch, "pay_channels");
  if (withPay) requirePermission(loaded, "site.pay_config");
  const prevPc = withPay ? (await getMergedConfig(supabase)).config.pay_channels : null;
  const expected = body.expected_config_version != null ? Number(body.expected_config_version) : null;
  await saveConfigKeys(supabase, actor.id, patch, { expectedConfigVersion: expected, note: body.note || "decor" });
  const { config, configVersion } = await getMergedConfig(supabase);
  // 装修页的「保存收款配置」也走这条通道，收款码清理须同口径，否则旧码永远留在存储里
  const removedImages = withPay ? await pruneOrphanPaycodes(prevPc, config.pay_channels) : [];
  await writeAudit(supabase, {
    adminId: actor.id, action: "site.decorate", targetType: "site_config", targetId: null,
    detail: { keys: Object.keys(patch), ...(removedImages.length ? { removed_images: removedImages.length } : {}) },
  });
  return ok({ config, config_version: configVersion, removed_images: removedImages });
}

// —— D1 配置历史（CH-a 列表 / CH-b 单版本 / CH-c 回滚；均 site.decorate）——
export async function listConfigHistoryEndpoint(supabase, request) {
  await requirePermission(await loadAdminPermissions(supabase, (await requirePrincipal(supabase, request, "admin")).id), "site.decorate");
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  const items = await listConfigHistory(supabase, { limit, offset });
  return ok({ items, current_version: items.length ? Math.max(...items.map((x) => x.version)) : 0 });
}

export async function getConfigHistoryEndpoint(supabase, request) {
  await requirePermission(await loadAdminPermissions(supabase, (await requirePrincipal(supabase, request, "admin")).id), "site.decorate");
  const version = Number(new URL(request.url).searchParams.get("version"));
  if (!Number.isInteger(version) || version < 1) return fail("invalid_request", "version 不合法");
  const row = await getConfigHistoryRow(supabase, version);
  if (!row) return fail("not_found", "该配置版本不存在");
  return ok(row);
}

export async function rollbackConfigEndpoint(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  await requirePermission(await loadAdminPermissions(supabase, actor.id), "site.decorate");
  const version = Number(body?.version);
  if (!Number.isInteger(version) || version < 1) return fail("invalid_request", "version 不合法");
  const saved = await rollbackConfig(supabase, actor.id, version);
  await writeAudit(supabase, {
    adminId: actor.id, action: "site.config_rollback", targetType: "site_config", targetId: String(version),
    detail: { rollback_to: version, keys: saved },
  });
  const { config, configVersion } = await getMergedConfig(supabase);
  return ok({ config, config_version: configVersion, rolled_back_to: version });
}

// —— AN3 收款渠道配置（site.pay_config，⚠；渠道注册表数据驱动，收款码图走 storage，仅存键）——
export async function savePayChannels(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "site.pay_config");
  const patch = body.pay_channels ?? body.channels;
  if (!patch || typeof patch !== "object") return fail("invalid_request", "缺少 pay_channels 对象");
  const { config: prevConfig } = await getMergedConfig(supabase);
  await saveConfigKeys(supabase, actor.id, { pay_channels: patch });
  const { config, configVersion } = await getMergedConfig(supabase);
  const pc = config.pay_channels;
  const methodKeys = methodKeysOf(pc);
  const removedImages = await pruneOrphanPaycodes(prevConfig.pay_channels, pc);
  await writeAudit(supabase, {
    adminId: actor.id, action: "site.pay_channels", targetType: "site_config", targetId: null,
    detail: {
      payment_timeout_hours: pc.payment_timeout_hours,
      removed_images: removedImages.length,
      channels: Object.fromEntries(methodKeys.map((k) => [k, {
        enabled: pc[k]?.enabled === true, fulfillment: pc[k]?.fulfillment ?? "manual", has_qrcode: Boolean(pc[k]?.image_key),
      }])),
    },
  });
  return ok({
    removed_images: removedImages,
    pay_channels: {
      payment_timeout_hours: pc.payment_timeout_hours,
      ...Object.fromEntries(methodKeys.map((k) => [k, {
        enabled: pc[k]?.enabled === true, fulfillment: pc[k]?.fulfillment ?? "manual",
        display_name: pc[k]?.display_name ?? k, image_key: pc[k]?.image_key ?? null,
        holder_name: pc[k]?.holder_name ?? "", account_no: pc[k]?.account_no ?? "", pay_link: pc[k]?.pay_link ?? "",
        account_note: pc[k]?.account_note ?? "", account_note_i18n: pc[k]?.account_note_i18n ?? null,
        provider: pc[k]?.provider ?? null,
        chains: pc[k]?.chains ?? [],
      }])),
    },
    config_version: configVersion,
  });
}

// —— A5 静态内容页保存（content.manage，site_config "pages"，无迁移）——
// 整篇替换语义：body.pages 为完整 slug->page 映射；删页即从映射里去掉该 slug。
export async function adminPageSave(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "content.manage");
  if (!body.pages || typeof body.pages !== "object" || Array.isArray(body.pages)) {
    return fail("invalid_request", "缺少 pages 映射对象");
  }
  await saveConfigKeys(supabase, actor.id, { pages: body.pages });
  await writeAudit(supabase, {
    adminId: actor.id, action: "site.pages", targetType: "site_config", targetId: null,
    detail: { slugs: Object.keys(body.pages) },
  });
  const { config, configVersion } = await getMergedConfig(supabase);
  return ok({ pages: config.pages, config_version: configVersion });
}

// —— AN4 币种与汇率维护（site.currency，⚠）——
export async function saveCurrency(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "site.currency");
  const code = vStr(body.code, "code", { min: 3, max: 3, pattern: /^[A-Z]{3}$/ });
  const symbol = vStr(body.symbol, "symbol", { min: 1, max: 8 });
  const nameI18n = vJson(body.name_i18n ?? {}, "name_i18n");
  const rateScaled = vInt(body.rate_scaled, "rate_scaled", { min: 1, max: 999999999 });
  const status = vEnum(body.status ?? "on", "status", ["on", "off"]);
  const { data: existing } = await supabase.from("currencies").select("id").eq("code", code).maybeSingle();
  if (existing) {
    const { error } = await supabase.from("currencies")
      .update({ symbol, name_i18n: nameI18n, rate_scaled: rateScaled, status, updated_at: nowIso() })
      .eq("id", existing.id);
    if (error) throw new AppError(500, "internal_error");
  } else {
    const { error } = await supabase.from("currencies").insert({
      id: crypto.randomUUID(), code, symbol, name_i18n: nameI18n, rate_scaled: rateScaled,
      status, created_at: nowIso(),
    });
    if (error) {
      if (isUniqueViolation(error)) return fail("claim_conflict", "币种已存在", null, 409);
      throw new AppError(500, "internal_error");
    }
  }
  await writeAudit(supabase, {
    adminId: actor.id, action: "site.currency", targetType: "currency", targetId: null,
    detail: { code, rate_scaled: rateScaled, status },
  });
  return ok({ code, rate_scaled: rateScaled, status });
}

// —— AN4b 站点本位币切换（site.currency，⚠；写 site_config "currency"，零迁移）——
// 记账币种，只重贴标签/影响未来展示换算；历史订单已按下单汇率快照，不受影响。
export async function saveCurrencyBase(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "site.currency");
  const base = vStr(body.base, "base", { min: 3, max: 3, pattern: /^[A-Z]{3}$/ });
  const currency = await getCurrency(supabase, base);
  if (!currency) return fail("invalid_request", "本位币需为已启用币种", { base });
  await saveConfigKeys(supabase, actor.id, { currency: { base } });
  await writeAudit(supabase, {
    adminId: actor.id, action: "site.currency_base", targetType: "site_config", targetId: null,
    detail: { base, symbol: currency.symbol },
  });
  const { config, configVersion } = await getMergedConfig(supabase);
  return ok({ base: config.currency.base, config_version: configVersion });
}

// —— AN5 语言包保存（content.manage）——
export async function saveUiStrings(supabase, request, body) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "content.manage");
  const items = vJson(body.items, "items", { maxItems: 100 });
  const n = await saveStrings(supabase, items);
  await writeAudit(supabase, {
    adminId: actor.id, action: "content.string_save", targetType: "ui_strings", targetId: null,
    detail: { count: n },
  });
  return ok({ saved: n });
}

// —— AS1 审计查询（audit.read）——
export async function listAudit(supabase, request, query) {
  const actor = await requirePrincipal(supabase, request, "admin");
  const loaded = await loadAdminPermissions(supabase, actor.id);
  requirePermission(loaded, "audit.read");
  const { offset, limit } = pageParams(query);
  const applyFilters = (q) => {
    if (query.admin_id) q = q.eq("admin_id", vUuid(query.admin_id, "admin_id"));
    if (query.action) q = q.eq("action", vStr(query.action, "action", { min: 1, max: 60 }));
    if (query.target_type) q = q.eq("target_type", vStr(query.target_type, "target_type", { min: 1, max: 40 }));
    if (query.target_id) q = q.eq("target_id", vUuid(query.target_id, "target_id"));
    if (query.from) q = q.gte("created_at", vStr(query.from, "from", { min: 8, max: 40, pattern: /^\d{4}-\d{2}-\d{2}/ }));
    if (query.to) q = q.lte("created_at", vStr(query.to, "to", { min: 8, max: 40, pattern: /^\d{4}-\d{2}-\d{2}/ }));
    return q;
  };
  const { count } = await applyFilters(
    supabase.from("audit_logs").select("id", { count: "exact" }),
  ).limit(1);
  const canIp = hasPermission(loaded.permissions, "user.ip_view");
  const { data } = await applyFilters(
    supabase.from("audit_logs")
      .select(canIp ? "id,admin_id,action,target_type,target_id,detail,ip,created_at" : "id,admin_id,action,target_type,target_id,detail,created_at"),
  ).order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  return ok({ total: Number.isSafeInteger(count) ? count : null, offset, limit, items: data ?? [] });
}
