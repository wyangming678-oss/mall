// 用户端账户（文档C §二 A1–A7）
import { AppError, isUniqueViolation } from "./errors.mjs";
import { vStr, vEnum, nowIso } from "./validate.mjs";
import { hashPassword, verifyPassword, makeInviteCode } from "./crypto.mjs";
import { createSession, requirePrincipal, revokeSessions } from "./auth.mjs";
import { bindRelation, grantInviteeCoupon, inviteRules, registerReward, rewardTriggerMode } from "./invite.mjs";
import { consumeChallenge, guardLoginAttempt, noteLoginFail, loginFailFeedback } from "./security.mjs";
import { toE164, normalizePhoneString, intentCurrencyForDial } from "./phone.mjs";
import { getCurrencyOrBase } from "./config.mjs";

export const LANGS = ["zh", "en", "ja", "ko", "es"];

export async function publicUser(supabase, userId) {
  const { data, error } = await supabase.from("users")
    .select("id,username,nickname,email,phone,avatar_key,language,currency_code,balance,invite_code,status,created_at,payment_password_hash")
    .eq("id", userId).is("deleted_at", null).maybeSingle();
  if (error || !data) throw new AppError(404, "not_found");
  if (data.status !== "active") throw new AppError(403, "account_disabled", "账号已被禁用");
  // 支付密码哈希不外泄，只告诉前端「是否已设」，供自助设置区与结算校验判断
  const { payment_password_hash, ...rest } = data;
  return { ...rest, has_payment_password: Boolean(payment_password_hash) };
}

// 登录/标识解析用：平台不能给 username/email/phone 建 UNIQUE（D7），所以「唯一标识」在应用层可能真出现多行。
// 旧实现用 maybeSingle() 且吞掉 error：DB 报错会被当成「查无此人」返回 null，导致登录静默失败（401）而非如实报故障；
// 多行时 maybeSingle 也会抛错被吞掉。这里改成 limit(2) 显式区分：DB 瞬态错误→503（前端不应当过期登出），
// 命中多行未删数据→409 让客服介入（而不是随机挑一行登录进别人账号）。
async function findUserByField(supabase, field, value) {
  const { data, error } = await supabase.from("users")
    .select("id,password_hash,status,deleted_at").eq(field, value).limit(2);
  if (error) throw new AppError(503, "service_unavailable", "服务暂时不可用，请稍后重试");
  const live = (data ?? []).filter((r) => !r.deleted_at);
  if (live.length > 1) throw new AppError(409, "state_conflict", "账号存在重复数据，请联系客服处理");
  return live[0] ?? null;
}

// 注册/代客开号共用：区号意图币种 → 站点本位币 → USD → 首个已开通；全站无币种→报错让运营先去 AN4 补
// 手机号选填后「无区号可依」成了正常路径，所以本位币必须排在 USD 前面
export async function resolveRegisterCurrency(supabase, rawDial) {
  return (await getCurrencyOrBase(supabase, intentCurrencyForDial(rawDial))).code;
}

export async function register(supabase, body, { ip = null } = {}) {
  const username = vStr(body.username, "username", { min: 3, max: 20, pattern: /^[a-zA-Z0-9_]+$/ });
  const password = vStr(body.password, "password", { min: 8, max: 64 });
  const nickname = vStr(body.nickname ?? username, "nickname", { max: 30 });
  // 全空白按「未填」处理，与手机号同口径（否则前端 trim 后不发，后端却拿空白去校验格式）
  const emailRaw = typeof body.email === "string" ? body.email.trim() : "";
  const email = emailRaw ? vStr(emailRaw, "email", { max: 120, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }) : null;
  // 手机号选填：填了就必须过区号+位数校验（后端权威）；与邮箱至少有一项，否则日后联系不上这个人
  const phoneRaw = typeof body.phone_national === "string" ? body.phone_national.trim() : "";
  const phone = phoneRaw ? toE164(body.phone_dial_code, phoneRaw) : null;
  if (!phone && !email) throw new AppError(400, "contact_required", "手机号和邮箱至少填写一项");
  const language = vEnum(body.language, "language", LANGS);
  // 币种由区号推导（忽略客户端传入）；没填号码或未开通该币种时回落站点本位币，再 USD，再首个已开通
  const currencyCode = await resolveRegisterCurrency(supabase, phone ? body.phone_dial_code : null);
  // 蜜罐：正常用户不可见也不会填；命中就给与参数错误同形的一般报错，不让脚本学到规则
  if (typeof body.website === "string" && body.website.trim()) {
    throw new AppError(400, "invalid_request", "注册请求不合法");
  }
  await consumeChallenge(supabase, { challengeId: body.challenge_id, answer: body.captcha_answer, scope: "register" });
  const switchesRes = await supabase.from("site_config").select("config_value").eq("config_key", "switches").maybeSingle();
  if (switchesRes.data?.config_value?.register_open === false) {
    throw new AppError(403, "permission_denied", "注册通道已关闭");
  }

  // 唯一性预检：平台不给 users 的 username/email/phone 建 UNIQUE（D7 同因），唯一性只能应用层保证。
  // 放在 consumeChallenge 之后，未过人机验证的脚本无法用注册接口探测他人标识是否已占用。
  // 用 limit(1) 而非 maybeSingle：maybeSingle 在多行时会抛错，而这里只关心「有没有」；DB 瞬态错误如实报 503。
  const taken = async (field, value, code, message) => {
    const { data, error } = await supabase.from("users").select("id")
      .eq(field, value).is("deleted_at", null).limit(1);
    if (error) throw new AppError(503, "service_unavailable", "服务暂时不可用，请稍后重试");
    if (data?.length) throw new AppError(409, code, message);
  };
  await taken("username", username, "claim_conflict", "用户名已被占用");
  if (email) await taken("email", email, "claim_conflict", "邮箱已被占用");
  if (phone) await taken("phone", phone, "phone_taken", "该手机号已被注册");

  let invitedBy = null;
  if (body.invite_code) {
    const code = vStr(body.invite_code, "invite_code", { max: 10 }).toUpperCase();
    const { data: inviter } = await supabase.from("users").select("id")
      .eq("invite_code", code).is("deleted_at", null).maybeSingle();
    if (inviter) invitedBy = inviter.id; // 无效邀请码静默忽略（文档B §7 T1）
  }

  const passwordHash = await hashPassword(password);
  let userId = null;
  for (let attempt = 0; attempt < 5 && !userId; attempt += 1) {
    const candidate = {
      id: crypto.randomUUID(),
      username, email, phone, password_hash: passwordHash, nickname,
      language, currency_code: currencyCode, balance: 0,
      invite_code: makeInviteCode(), invited_by: invitedBy,
      register_ip: ip, status: "active", created_at: nowIso(),
    };
    const { error } = await supabase.from("users").insert(candidate);
    if (error) {
      if (isUniqueViolation(error)) {
        if (error.message && String(error.message).includes("invite_code")) continue; // 邀请码撞车重试
        if (String(error.message ?? "").includes("phone")) throw new AppError(409, "phone_taken", "该手机号已被注册");
        if (String(error.message ?? "").includes("username")) throw new AppError(409, "claim_conflict", "用户名已被占用");
        throw new AppError(409, "claim_conflict", "邮箱已被占用");
      }
      throw new AppError(500, "internal_error");
    }
    userId = candidate.id;
  }
  if (!userId) throw new AppError(409, "claim_conflict", "请重试");

  // A1：邀请码命中 → 关系一次性绑定；注册侧奖励（first_register PENDING + welcome 券）按开关即时或推迟到首单
  let invite = null;
  if (invitedBy) {
    const rules = await inviteRules(supabase);
    const rel = await bindRelation(supabase, {
      inviterId: invitedBy, inviteeId: userId, channel: body.invite_channel ?? null,
    });
    if (rel.bound && rel.relation) {
      if (await rewardTriggerMode(supabase) === "first_order") {
        invite = { relation_id: rel.relation.id, registered_reward: false, invitee_coupon: false, deferred_to_first_order: true };
      } else {
        const reward = await registerReward(supabase, {
          relation: rel.relation, triggerType: "first_register", triggerRefId: userId, rule: rules.first_register,
        });
        const coupon = await grantInviteeCoupon(supabase, {
          templateId: rules.invitee_coupon_template_id, inviteeId: userId, relationId: rel.relation.id,
        });
        invite = { relation_id: rel.relation.id, registered_reward: reward.created === true, invitee_coupon: coupon.granted === true };
      }
    } else {
      invite = { relation_id: null, reason: rel.reason ?? "not_bound" };
    }
  }

  const token = await createSession(supabase, "user", userId);
  const user = await publicUser(supabase, userId);
  return { token, user, invited: !!invitedBy, invite };
}

export async function login(supabase, body, { ip = null } = {}) {
  const password = vStr(body.password, "password", { max: 64 });
  // 标识解析：显式手机号（区号+号码）优先；否则按用户名，且把「+…」形式的号码回落到手机号查询
  let principalKey;
  let row;
  if (body.phone_dial_code !== undefined || body.phone_national !== undefined) {
    principalKey = toE164(body.phone_dial_code, body.phone_national);
    row = await findUserByField(supabase, "phone", principalKey);
  } else {
    const ident = vStr(body.username, "username", { max: 64 });
    principalKey = ident;
    row = await findUserByField(supabase, "username", ident);
    if (!row && ident.startsWith("+")) {
      let e164 = null;
      try { e164 = normalizePhoneString(ident); } catch { e164 = null; }
      if (e164) { principalKey = e164; row = await findUserByField(supabase, "phone", e164); }
    }
  }
  const { fails } = await guardLoginAttempt(supabase, {
    scope: "user_login", principalType: "user", principalKey, body,
  });
  if (!row || row.deleted_at) throw new AppError(401, "unauthenticated", "用户名或密码错误");
  if (!(await verifyPassword(password, row.password_hash))) {
    await noteLoginFail(supabase, { principalType: "user", principalKey, ip });
    throw new AppError(401, "unauthenticated", "用户名或密码错误", loginFailFeedback(fails + 1));
  }
  if (row.status !== "active") throw new AppError(403, "account_disabled", "账号已被禁用");
  await supabase.from("users")
    .update({ last_login_ip: ip, last_login_at: nowIso() }).eq("id", row.id);
  const token = await createSession(supabase, "user", row.id);
  const user = await publicUser(supabase, row.id);
  return { token, user };
}

export async function logout(supabase, principal) {
  await supabase.from("user_sessions").update({ revoked_at: nowIso() })
    .eq("id", principal.sessionId).is("revoked_at", null);
  return { logged_out: true };
}

export async function updateProfile(supabase, principal, body) {
  const patch = { updated_at: nowIso() };
  if (body.nickname !== undefined) patch.nickname = vStr(body.nickname, "nickname", { max: 30 });
  if (body.avatar_key !== undefined) patch.avatar_key = body.avatar_key ? vStr(body.avatar_key, "avatar_key", { max: 200 }) : null;
  if (body.email !== undefined) {
    patch.email = (body.email === null || body.email === "")
      ? null : vStr(body.email, "email", { max: 120, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ });
  }
  if (body.phone !== undefined) {
    patch.phone = (body.phone === null || body.phone === "")
      ? null : normalizePhoneString(body.phone);
  }
  if (body.language !== undefined) patch.language = vEnum(body.language, "language", LANGS);
  // 币种由注册区号决定，自助端不再允许修改；即使客户端仍传 currency_code 也静默忽略（后台 AU6 是唯一入口）
  if (Object.keys(patch).length === 1) throw new AppError(400, "invalid_request", "没有需要更新的字段");
  const { error } = await supabase.from("users").update(patch).eq("id", principal.id).is("deleted_at", null);
  if (error) {
    // 改到已被他人占用的号码：与后台侧一致回 409，而不是通用 500（phone 唯一索引见 D7）
    if (patch.phone && isUniqueViolation(error) && String(error.message ?? "").includes("phone")) {
      throw new AppError(409, "phone_taken", "该手机号已被其他账号使用");
    }
    throw new AppError(500, "internal_error");
  }
  return publicUser(supabase, principal.id);
}

// —— 自助设置/修改/关闭支付密码（6–20 位数字；已设置过则改与关都要验旧密码）——
export async function changePaymentPassword(supabase, principal, body) {
  const clear = body.clear === true;
  const newPin = clear ? null : vStr(body.payment_password, "payment_password", { pattern: /^\d{6,20}$/ });
  const { data } = await supabase.from("users")
    .select("id,payment_password_hash").eq("id", principal.id).is("deleted_at", null).maybeSingle();
  if (!data) throw new AppError(404, "not_found");
  if (data.payment_password_hash) {
    const oldPin = vStr(body.old_payment_password ?? "", "old_payment_password", { max: 20 });
    if (!(await verifyPassword(oldPin, data.payment_password_hash))) {
      throw new AppError(401, "unauthenticated", "原支付密码不正确");
    }
  }
  const { error } = await supabase.from("users")
    .update({ payment_password_hash: clear ? null : await hashPassword(newPin), updated_at: nowIso() })
    .eq("id", principal.id);
  if (error) throw new AppError(500, "internal_error");
  return clear ? { cleared: true } : { set: true };
}

export async function changePassword(supabase, principal, body) {
  const oldPw = vStr(body.old_password, "old_password", { max: 64 });
  const newPw = vStr(body.new_password, "new_password", { min: 8, max: 64 });
  const { data } = await supabase.from("users").select("password_hash").eq("id", principal.id).maybeSingle();
  if (!data || !(await verifyPassword(oldPw, data.password_hash))) {
    throw new AppError(401, "unauthenticated", "原密码不正确");
  }
  const { error } = await supabase.from("users")
    .update({ password_hash: await hashPassword(newPw), updated_at: nowIso() })
    .eq("id", principal.id);
  if (error) throw new AppError(500, "internal_error");
  await revokeSessions(supabase, "user", principal.id);
  return { changed: true };
}
