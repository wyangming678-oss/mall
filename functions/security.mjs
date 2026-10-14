// 防滥用引擎（注册人机验证 + 登录失败锁定 + 客户端 IP 采集）
// 验证题走 DB 状态一次性消费（仿 idem.mjs，无新增 Secret）；IP 头可被伪造，只用于发题频次这类软限流，绝不当硬性安全门。
import { AppError } from "./errors.mjs";
import { sha256Hex } from "./crypto.mjs";
import { nowIso, vUuid, vEnum, countRows } from "./validate.mjs";
import { generateDigits, digitsSvg } from "./captcha_questions.mjs";

export const CAPTCHA_SCOPES = ["register", "user_login", "admin_login"];

// 测试钩子：smoke 里把它调零/调短，避免为等待窗口而 sleep
export const securityConfig = {
  captcha: {
    ttlMs: 120000,          // 题目 2 分钟过期（原 5 分钟，缩短以缩小重放窗口）
    minDwellMs: 3000,       // 出题→答题最短 3 秒（题面只需抄数字，不再给读题+心算留时间）
    windowMs: 60000,        // 全局发题窗口（兜底：挡住整站被刷）
    windowMax: 60,          // 窗口内全局最多出题数
    ipWindowMs: 300000,     // 按 IP 的发题窗口 5 分钟
    ipMax: 40,              // 单 IP 窗口内最多出题数：够一整层办公室同时注册（共享出口 NAT），只挡住单机脚本刷池
    exposeAnswerForTest: false, // smoke 打开：响应附带 answer_dev 便于答题；生产永远 false
  },
  loginFail: {
    windowMs: 900000,     // 失败计数窗口 15 分钟
    maxFails: 5,          // 达到即锁定
    captchaAfter: 2,      // 达到即答题
  },
};

// x-forwarded-for 取第一段（最接近客户端），退化到 x-real-ip；两者都是转发层约定头，不可信为硬依据
export function clientIp(request) {
  const xff = request?.headers?.get?.("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first.slice(0, 64);
  }
  const real = request?.headers?.get?.("x-real-ip");
  if (real && real.trim()) return real.trim().slice(0, 64);
  return null;
}

// —— 发题：6 位随机数字 → SVG，DB 存题面 + 答案哈希，明文答案不出接口 ——
// 发题频次按 IP 计（security_events 只追加，零迁移）：全局窗口只是兜底，单靠它能被脚本刷爆后把真人挡在门外。
// IP 取不到时不做 IP 判定（不能因为代理头缺失就拒绝真人），仍有全局兜底。
export async function issueChallenge(supabase, scope, request) {
  const checked = vEnum(scope, "scope", CAPTCHA_SCOPES);
  const cfg = securityConfig.captcha;
  const nowMs = Date.now();
  const ip = clientIp(request);
  if (ip) {
    const recentByIp = await countRows(supabase.from("security_events")
      .select("id", { count: "exact" }).eq("event_type", "captcha_issue")
      .eq("principal_type", "ip").eq("principal_key", ip)
      .gte("created_at", new Date(nowMs - cfg.ipWindowMs).toISOString()));
    if (recentByIp >= cfg.ipMax) throw new AppError(429, "captcha_rate_limited", "验证题请求过于频繁，请稍后再试");
  }
  const recent = await countRows(supabase.from("captcha_challenges")
    .select("id", { count: "exact" }).gte("created_at", new Date(nowMs - cfg.windowMs).toISOString()));
  if (recent >= cfg.windowMax) throw new AppError(429, "captcha_rate_limited", "验证题请求过于频繁，请稍后再试");
  const digits = generateDigits();
  const id = crypto.randomUUID();
  const { error } = await supabase.from("captcha_challenges").insert({
    id,
    scope: checked,
    question: digits,
    answer_hash: await sha256Hex(digits),
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + cfg.ttlMs).toISOString(),
    used_at: null,
  });
  if (error) throw new AppError(500, "internal_error");
  if (ip) {
    await supabase.from("security_events").insert({
      id: crypto.randomUUID(), event_type: "captcha_issue",
      principal_type: "ip", principal_key: ip, ip, created_at: new Date(nowMs).toISOString(),
    });
  }
  const out = { challenge_id: id, svg: digitsSvg(digits) };
  if (cfg.exposeAnswerForTest) out.answer_dev = digits;
  return out;
}

// —— 一次性消费：CAS 翻转 used_at，答错也消耗（防一题多试爆破）——
export async function consumeChallenge(supabase, { challengeId, answer, scope }) {
  if (!challengeId || answer === undefined || answer === null || answer === "") {
    throw new AppError(400, "captcha_required", "请先完成人机验证");
  }
  const id = vUuid(challengeId, "challenge_id");
  const { data: row } = await supabase.from("captcha_challenges")
    .select("id,scope,answer_hash,created_at,expires_at,used_at").eq("id", id).maybeSingle();
  if (!row || row.scope !== scope || row.used_at) {
    throw new AppError(400, "captcha_invalid", "验证题无效或已使用，请点击图片换一张");
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new AppError(400, "captcha_expired", "验证题已过期，请点击图片换一张");
  }
  if (Date.now() - Date.parse(row.created_at) < securityConfig.captcha.minDwellMs) {
    throw new AppError(400, "captcha_too_fast", "操作太快了，请稍等几秒再提交");
  }
  // 先翻转再对答案：并发双花时只有一侧能翻成功
  const { data: flipped } = await supabase.from("captcha_challenges")
    .update({ used_at: nowIso() }).eq("id", id).is("used_at", null).select("id");
  if (!flipped?.length) throw new AppError(400, "captcha_invalid", "验证题已被使用，请点击图片换一张");
  const hash = await sha256Hex(String(answer).trim());
  if (hash !== row.answer_hash) throw new AppError(400, "captcha_wrong", "数字填错了，请重新输入");
  return { consumed: true };
}

// —— 登录失败计数：security_events 只追加，窗口内计数 ——
async function recentFails(supabase, principalType, principalKey) {
  const cutoff = new Date(Date.now() - securityConfig.loginFail.windowMs).toISOString();
  const { data } = await supabase.from("security_events")
    .select("id,created_at").eq("event_type", "login_fail")
    .eq("principal_type", principalType).eq("principal_key", principalKey)
    .gte("created_at", cutoff).limit(200);
  return data ?? [];
}

// 登录入口守卫：锁定 → 429；失败够多 → 必须带题。账号不存在的探测不计（防投毒 security_events）
export async function guardLoginAttempt(supabase, { scope, principalType, principalKey, body }) {
  const fails = await recentFails(supabase, principalType, principalKey);
  const cfg = securityConfig.loginFail;
  if (fails.length >= cfg.maxFails) {
    const oldest = Math.min(...fails.map((f) => Date.parse(f.created_at)));
    throw new AppError(429, "login_locked", "失败次数过多，请稍后再试", {
      retry_after_ms: Math.max(0, oldest + cfg.windowMs - Date.now()),
    });
  }
  if (fails.length >= cfg.captchaAfter) {
    await consumeChallenge(supabase, { challengeId: body?.challenge_id, answer: body?.captcha_answer, scope });
  }
  return { fails: fails.length };
}

// 密码错误时记一笔（仅账号确实存在时调用）；写失败静默——宁少计一次，也不给爆破者额外反馈
export async function noteLoginFail(supabase, { principalType, principalKey, ip }) {
  const { error } = await supabase.from("security_events").insert({
    id: crypto.randomUUID(),
    event_type: "login_fail",
    principal_type: principalType,
    principal_key: String(principalKey).slice(0, 64),
    ip: ip ?? null,
    created_at: nowIso(),
  });
  return !error;
}

// 401 附带的前瞻状态：下一次失败后的答题/锁定预期
export function loginFailFeedback(failsNext) {
  const cfg = securityConfig.loginFail;
  return {
    captcha_required: failsNext >= cfg.captchaAfter && failsNext < cfg.maxFails,
    attempts_until_lock: Math.max(0, cfg.maxFails - failsNext),
  };
}
