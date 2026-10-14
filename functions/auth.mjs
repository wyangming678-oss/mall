// 会话：user_sessions 复用于 user/admin（principal_type），token 存哈希（文档A §2 / 文档C §〇.3）
import { AppError } from "./errors.mjs";
import { sha256Hex, randomToken } from "./crypto.mjs";
import { nowIso } from "./validate.mjs";

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const RENEW_THRESHOLD_MS = 24 * 3600 * 1000;

export async function createSession(supabase, principalType, principalId) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const { error } = await supabase.from("user_sessions").insert({
    id: crypto.randomUUID(),
    principal_type: principalType,
    principal_id: principalId,
    token_hash: await sha256Hex(token),
    expires_at: expiresAt,
    created_at: nowIso(),
  });
  if (error) throw new AppError(500, "internal_error");
  return token;
}

export async function resolvePrincipal(supabase, request) {
  const token = request.headers.get("x-mall-token");
  if (!token || token.length !== 64) return null;
  const tokenHash = await sha256Hex(token);
  // 会话是鉴权决策读：DB 瞬态错误不能当成「无会话」，否则前端会把 401 当过期静默登出。
  const { data, error } = await supabase.from("user_sessions")
    .select("id,principal_type,principal_id,expires_at,revoked_at")
    .eq("token_hash", tokenHash).maybeSingle();
  if (error) throw new AppError(503, "service_unavailable", "服务暂时不可用，请稍后重试");
  if (!data || data.revoked_at) return null;
  const now = Date.now();
  if (Date.parse(data.expires_at) <= now) return null;
  if (Date.parse(data.expires_at) - now < RENEW_THRESHOLD_MS) {
    await supabase.from("user_sessions")
      .update({ expires_at: new Date(now + SESSION_TTL_MS).toISOString() })
      .eq("id", data.id).eq("revoked_at", null);
  }
  return { type: data.principal_type, id: data.principal_id, sessionId: data.id };
}

export async function requirePrincipal(supabase, request, expectType) {
  const principal = await resolvePrincipal(supabase, request);
  if (!principal || principal.type !== expectType) {
    throw new AppError(401, "unauthenticated", "请先登录");
  }
  return principal;
}

export async function requireAnyPrincipal(supabase, request) {
  const principal = await resolvePrincipal(supabase, request);
  if (!principal) throw new AppError(401, "unauthenticated", "请先登录");
  return principal;
}

// 客服会话的主体口径（文档J §2.1）：注册用户或访客。访客 principal_type="guest"，令牌一律服务端签发，
// 客户端不能自称访客 id——否则一枚猜到的 id 就能读到别人的会话。
const CHAT_PRINCIPALS = ["user", "guest"];
export async function requireChatPrincipal(supabase, request, { allowAnonymous = false } = {}) {
  const principal = await resolvePrincipal(supabase, request);
  if (!principal) {
    // 只有 chat/open 允许匿名：服务端随后签发一枚 guest 令牌，客户端不能自称访客 id
    if (allowAnonymous) return null;
    throw new AppError(401, "unauthenticated", "请先登录");
  }
  if (!CHAT_PRINCIPALS.includes(principal.type)) {
    throw new AppError(403, "permission_denied", "该令牌不能用于客服会话");
  }
  return principal;
}

export async function revokeSessions(supabase, principalType, principalId, exceptSessionId = null) {
  let query = supabase.from("user_sessions")
    .update({ revoked_at: nowIso() })
    .eq("principal_type", principalType)
    .eq("principal_id", principalId)
    .is("revoked_at", null);
  if (exceptSessionId) query = query.neq("id", exceptSessionId);
  await query;
}
