// 客服会话（文档A §29 chat_sessions / §30 chat_messages append-only；文档B §10 waiting→active→closed；
// 方案 §13 五秒轮询 + last_message_id 增量拉取；文档C CH1–CH4 用户端、CS1–CS4 工作台）
// 会话状态只走文档B §10 的三条边：认领是唯一的 waiting→active 入口，closed 是终态。
import { AppError } from "./errors.mjs";
import { adminGuard, writeAudit } from "./permissions.mjs";
import { signedUrlForKey } from "./files.mjs";
import { getMergedConfig } from "./config.mjs";
import { createSession } from "./auth.mjs";
import { nowIso, pageParams, pageResult, vEnum, vStr, vUuid, countRows, I18N_LANGS } from "./validate.mjs";

export const CHAT_STATUS = ["waiting", "active", "closed"];
export const CHAT_CONTENT_TYPES = ["text", "image"];
const OPEN_STATUSES = ["waiting", "active"];
const SESSION_COLS = "id,user_id,status,assigned_admin_id,user_read_at,last_message_at,created_at,updated_at";
const MESSAGE_COLS = "id,session_id,sender_type,sender_id,content_type,content,attachment_key,created_at";
const IMAGE_KEY_RE = /^chat\/[0-9a-f-]{36}\.(png|jpg|webp)$/;
const CONTENT_MAX = 2000;
/** 增量拉取一次读 51 条判 has_more：5s 轮询下正常只有个位数，积压部分下一次带游标继续取 */
const POLL_LIMIT = 50;
const UNREAD_SCAN = 20;
/** system 消息的 sender_id 占位主体（无 FK，函数层写死同一常量，前端按 sender_type 显示「系统」） */
const SYSTEM_ID = "00000000-0000-4000-8000-00000000c0de";
const TEXT_CLOSED_BY_USER = "用户已结束会话";
const TEXT_CLOSED_BY_ADMIN = "客服已结束会话";
const UNREGISTERED_LABEL = "未注册";
/** 后台话术全空时的内置离线自动回复：按访客界面语言出词，配置缺省也不该漏中文 */
const OFFLINE_TEXT = {
  zh: "客服暂时离线，留言后会尽快回复。",
  en: "Support is offline right now. Leave a message and we will reply as soon as we are back.",
  ja: "カスタマーサポートは現在オフラインです。メッセージを残していただければ、対応再開後できるだけ早くご返信します。",
  ko: "고객 센터는 잠시 오프라인입니다. 메시지를 남겨 주시면 담당자가 순서대로 답변드리겠습니다.",
  es: "El servicio de atención al cliente está fuera de línea. Deja un mensaje y responderemos en cuanto estemos de vuelta.",
};

// —— 工具 ——

/** 同一请求内写多条消息时时间戳严格递增，避免同毫秒被增量游标漏掉（D4g 说明 7） */
function stamp(baseMs, index = 0) {
  return new Date(baseMs + index).toISOString();
}

/** 服务时段判定：working_hours 形如 "09:00-18:00"，按 UTC 比较（与全站时间口径一致）；空/不合规 = 全天候在线 */
export function withinWorkingHours(workingHours, date = new Date()) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(workingHours ?? ""));
  if (!m) return true;
  const cur = date.getUTCHours() * 60 + date.getUTCMinutes();
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end; // 跨零点时段
}

/** 访客界面语言：query.lang 优先（前端切语言就带过来），白名单外一律当 zh */
function chatLang(lang) {
  const v = String(lang ?? "").toLowerCase();
  return I18N_LANGS.includes(v) ? v : "zh";
}

/** 离线自动回复取词：后台那句中文原文只发给中文访客，其余语言取 auto_reply_i18n 对应框，没填就用内置该语种话术 */
function offlineGreeting(service, lang) {
  const map = service.auto_reply_i18n;
  const configured = lang === "zh"
    ? (map?.zh || service.auto_reply || service.offline_notice)
    : (map?.[lang] || map?.zh);
  return String(configured || OFFLINE_TEXT[lang] || OFFLINE_TEXT.zh);
}

function sessionView(row) {
  return {
    session_id: row.id,
    status: row.status,
    assigned_admin_id: row.assigned_admin_id ?? null,
    last_message_at: row.last_message_at,
    created_at: row.created_at,
  };
}

function messageView(row, url) {
  return {
    message_id: row.id,
    sender_type: row.sender_type,
    sender_id: row.sender_id,
    content_type: row.content_type,
    content: row.content,
    attachment_key: row.attachment_key ?? null,
    url: url ?? null,
    created_at: row.created_at,
  };
}

/** CH1 新建会话时随响应带回那条自动回复，省掉一次 poll */
function greetingMessage(id, text, createdAt) {
  return {
    message_id: id,
    sender_type: "system",
    sender_id: SYSTEM_ID,
    content_type: "text",
    content: String(text).slice(0, CONTENT_MAX),
    attachment_key: null,
    url: null,
    created_at: createdAt,
  };
}

/** 图片消息换签名短 URL：storage 不可用时返回 null，前端降级为「图片暂不可用」而不是整页报错 */
async function withUrls(rows) {
  const out = [];
  for (const row of rows) {
    out.push(messageView(row, row.attachment_key ? await signedUrlForKey(row.attachment_key) : null));
  }
  return out;
}

async function loadSession(supabase, sessionId) {
  const { data } = await supabase.from("chat_sessions").select(SESSION_COLS)
    .eq("id", vUuid(sessionId, "session_id")).maybeSingle();
  if (!data) throw new AppError(404, "not_found", "会话不存在");
  return data;
}

// 用户侧端点：别人的会话与不存在的会话同一响应，不泄露 id 是否存在
async function loadOwnedSession(supabase, principal, sessionId) {
  const session = await loadSession(supabase, sessionId);
  if (session.user_id !== principal.id) throw new AppError(404, "not_found", "会话不存在");
  return session;
}

async function listMessages(supabase, sessionId, sinceIso) {
  let q = supabase.from("chat_messages").select(MESSAGE_COLS).eq("session_id", sessionId)
    .order("created_at", { ascending: true }).limit(POLL_LIMIT + 1);
  if (sinceIso) q = q.gt("created_at", sinceIso);
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  return { rows: rows.slice(0, POLL_LIMIT), has_more: rows.length > POLL_LIMIT };
}

/** 游标解析：last_message_id 不在本会话（或已被裁剪）时当作首次全量，客户端不会卡死在坏游标上 */
async function cursorIso(supabase, sessionId, lastMessageId) {
  if (!lastMessageId) return null;
  const { data } = await supabase.from("chat_messages").select("id,created_at")
    .eq("id", vUuid(lastMessageId, "last_message_id")).eq("session_id", sessionId).maybeSingle();
  return data?.created_at ?? null;
}

/** 写消息 + 顶会话时间戳。closed 会话不再改 last_message_at（结束后的系统消息不该把会话顶回队列） */
async function insertMessage(supabase, { sessionId, senderType, senderId, contentType = "text", content, attachmentKey = null, at = null }) {
  const created = at ?? nowIso();
  const id = crypto.randomUUID();
  const { error } = await supabase.from("chat_messages").insert({
    id,
    session_id: sessionId,
    sender_type: senderType,
    sender_id: senderId,
    content_type: contentType,
    content: String(content).slice(0, CONTENT_MAX),
    attachment_key: attachmentKey,
    created_at: created,
  });
  if (error) throw new AppError(500, "internal_error");
  const { data: touched } = await supabase.from("chat_sessions")
    .update({ last_message_at: created, updated_at: created })
    .eq("id", sessionId).neq("status", "closed").select("id");
  return { message_id: id, created_at: created, touched: (touched?.length ?? 0) === 1 };
}

async function systemMessage(supabase, session, text, at = null) {
  return insertMessage(supabase, {
    sessionId: session.id, senderType: "system", senderId: SYSTEM_ID, content: text, at,
  });
}

/** 购物端已经拿到这批消息 → 把已读游标推到最新一条（A4 红点口径，D4g 说明 9） */
async function markUserRead(supabase, sessionId, iso) {
  if (!iso) return;
  await supabase.from("chat_sessions").update({ user_read_at: iso }).eq("id", sessionId);
}

function messageDraft(body) {
  const contentType = vEnum(body.content_type ?? "text", "content_type", CHAT_CONTENT_TYPES);
  const content = vStr(body.content, "content", { min: 1, max: CONTENT_MAX });
  if (contentType === "image") {
    return { contentType, content, attachmentKey: vStr(body.attachment_key, "attachment_key", { max: 60, pattern: IMAGE_KEY_RE }) };
  }
  return { contentType, content, attachmentKey: null };
}

// —— CH1 会话主体：复用 waiting/active 会话或新建；非工作时间落一条系统自动回复 ——
async function openFor(supabase, principal, lang = "zh") {
  const isGuest = principal.type === "guest";
  const { data: found } = await supabase.from("chat_sessions").select(SESSION_COLS)
    .eq("user_id", principal.id).in("status", OPEN_STATUSES)
    .order("last_message_at", { ascending: false }).limit(1);
  const existing = (found ?? [])[0] ?? null;
  if (existing) {
    const { rows } = await listMessages(supabase, existing.id, null);
    const messages = await withUrls(rows);
    const latest = messages[messages.length - 1];
    await markUserRead(supabase, existing.id, latest?.created_at ?? null);
    const { config } = await getMergedConfig(supabase);
    return {
      session: sessionView(existing), reused: true, is_guest: isGuest,
      offline: !withinWorkingHours(config.service?.working_hours),
      working_hours: config.service?.working_hours ?? "",
      messages, last_message_id: latest?.message_id ?? null,
    };
  }

  const now = nowIso();
  const id = crypto.randomUUID();
  const { config } = await getMergedConfig(supabase);
  const service = config.service ?? {};
  // 开关是「新建」的闸门：关掉之后已有访客令牌也不能再开一条新会话，只能继续/复用进行中的那条
  if (isGuest && service.guest_chat_open === false) {
    throw new AppError(403, "permission_denied", "访客咨询已关闭，请先注册后再联系客服");
  }
  const { error } = await supabase.from("chat_sessions").insert({
    id, user_id: principal.id, status: "waiting", assigned_admin_id: null,
    user_read_at: null, last_message_at: now, created_at: now, updated_at: now,
  });
  if (error) throw new AppError(500, "internal_error");

  const offline = !withinWorkingHours(service.working_hours);
  const greetingText = offline ? offlineGreeting(service, lang) : null;
  const greeting = greetingText
    ? await systemMessage(supabase, { id }, greetingText)
    : null;
  await markUserRead(supabase, id, greeting?.created_at ?? null);
  return {
    session: sessionView({
      id, status: "waiting", assigned_admin_id: null, last_message_at: greeting?.created_at ?? now, created_at: now,
    }),
    reused: false,
    is_guest: isGuest,
    offline,
    working_hours: service.working_hours ?? "",
    messages: greeting ? [greetingMessage(greeting.message_id, greetingText, greeting.created_at)] : [],
    last_message_id: greeting?.message_id ?? null,
  };
}

// —— CH1 访客接入：无令牌 → 服务端签发 guest 主体（principal_type="guest"），按 IP 限新建频次 ——
// chat_sessions.user_id 建表时无外键（现网 mall-d4g-chat-1），所以访客不需要一条 users 行。
async function guestOpen(supabase, ip, lang) {
  const { config } = await getMergedConfig(supabase);
  const service = config.service ?? {};
  if (service.guest_chat_open === false) {
    throw new AppError(403, "permission_denied", "访客咨询已关闭，请先注册后再联系客服");
  }
  // IP 只作软信号（转发头可伪造，与 security.mjs 同口径）：取不到 IP 时不做频次判定，也不能因此拒绝服务。
  if (ip) {
    const limit = service.guest_ip_limit ?? 20;
    const cutoff = new Date(Date.now() - 3600000).toISOString();
    const recent = await countRows(supabase.from("security_events").select("id", { count: "exact" })
      .eq("event_type", "guest_chat_open").eq("principal_type", "guest").eq("principal_key", ip).gte("created_at", cutoff));
    if (recent >= limit) throw new AppError(429, "rate_limited", "本机咨询过于频繁，请稍后再试或注册后联系");
  }
  const guestId = crypto.randomUUID();
  if (ip) {
    await supabase.from("security_events").insert({
      id: crypto.randomUUID(), event_type: "guest_chat_open",
      principal_type: "guest", principal_key: ip, ip, created_at: nowIso(),
    });
  }
  const token = await createSession(supabase, "guest", guestId);
  const opened = await openFor(supabase, { type: "guest", id: guestId }, lang);
  return { ...opened, guest_token: token };
}

// —— CH1 POST /app/chat/open：登录态走本人主体，无令牌走访客主体；lang 决定自动回复出哪种语言 ——
export async function chatOpen(supabase, principal, { ip = null, lang = "zh" } = {}) {
  const visitorLang = chatLang(lang);
  if (principal) return openFor(supabase, principal, visitorLang);
  return guestOpen(supabase, ip, visitorLang);
}

// —— CH2 GET /app/chat/poll?session_id&last_message_id：增量拉取，仅返回新消息 ——
export async function chatPoll(supabase, principal, query) {
  const session = await loadOwnedSession(supabase, principal, query.session_id);
  const since = await cursorIso(supabase, session.id, query.last_message_id);
  const { rows, has_more } = await listMessages(supabase, session.id, since);
  const messages = await withUrls(rows);
  const latest = messages[messages.length - 1];
  await markUserRead(supabase, session.id, latest?.created_at ?? null);
  return {
    session_id: session.id,
    status: session.status,
    messages,
    has_more,
    last_message_id: latest?.message_id ?? (query.last_message_id ?? null),
  };
}

// —— CH3 POST /app/chat/send [I]：closed → 410 chat_closed ——
export async function chatSend(supabase, principal, body) {
  const session = await loadOwnedSession(supabase, principal, body.session_id);
  if (session.status === "closed") throw new AppError(410, "chat_closed", "会话已结束，请重新发起会话");
  const draft = messageDraft(body);
  const msg = await insertMessage(supabase, {
    sessionId: session.id, senderType: "user", senderId: principal.id, ...draft,
  });
  // 已接入的会话不因新用户消息退回队列；waiting 保持 waiting 等客服认领
  return { ...msg, status: session.status };
}

// —— CH4 POST /app/chat/close [I]：→ closed + 系统消息，终态 ——
export async function chatClose(supabase, principal, body) {
  const session = await loadOwnedSession(supabase, principal, body.session_id);
  if (session.status === "closed") {
    return { session_id: session.id, status: "closed", already_closed: true };
  }
  const now = nowIso();
  const { data: hit } = await supabase.from("chat_sessions")
    .update({ status: "closed", updated_at: now }).eq("id", session.id).eq("status", session.status).select("id");
  if (!hit?.length) throw new AppError(409, "state_conflict", "会话状态已变动，请刷新后重试");
  const msg = await systemMessage(supabase, session, TEXT_CLOSED_BY_USER, stamp(Date.parse(now), 1));
  // 收尾这条系统话不算买家未读：否则「自己点结束」也会留下一个消不掉的红点
  await markUserRead(supabase, session.id, msg.created_at);
  return { session_id: session.id, status: "closed", from: session.status, message_id: msg.message_id };
}

// —— CS1 GET /app/admin/chat/queue（chat.handle）：默认 waiting+active，可按 status 筛 ——
export async function adminChatQueue(supabase, request, query) {
  const { actor } = await adminGuard(supabase, request, "chat.handle");
  const { offset, limit } = pageParams(query);
  
  // 单独查等待中总数（工作台角标），不受分页影响
  let waitingQ = supabase.from("chat_sessions").select("id", { count: "exact", head: true });
  waitingQ = query.status ? waitingQ.eq("status", "waiting") : waitingQ.eq("status", "waiting");
  const { count: waitingTotal } = await waitingQ;
  
  let q = supabase.from("chat_sessions").select(SESSION_COLS)
    .order("last_message_at", { ascending: false });
  q = query.status ? q.eq("status", vEnum(query.status, "status", CHAT_STATUS)) : q.in("status", OPEN_STATUSES);
  const { data, error } = await q.range(offset, offset + limit - 1);
  if (error) throw new AppError(500, "internal_error");
  const items = [];
  for (const row of data ?? []) {
    const { data: user } = await supabase.from("users").select("id,username,nickname,avatar_key")
      .eq("id", row.user_id).maybeSingle();
    let assignedAdminName = null;
    if (row.assigned_admin_id) {
      const { data: a } = await supabase.from("admins").select("id,nickname")
        .eq("id", row.assigned_admin_id).maybeSingle();
      assignedAdminName = a?.nickname ?? null;
    }
    items.push({
      ...sessionView(row),
      user_id: row.user_id,
      // 方案 §2：客服可看用户基本资料与订单，这里只给基本资料，不含手机号/余额等敏感项
      user: user ? { id: user.id, username: user.username, nickname: user.nickname, avatar_key: user.avatar_key ?? null } : null,
      // 文档J §2.3：查不到 users 行 = 免注册访客（user_id 是服务端签发的 guest 主体 id，无外键）
      registered: Boolean(user),
      display_name: user ? (user.nickname || user.username) : UNREGISTERED_LABEL,
      assigned_admin_name: assignedAdminName,
      mine: row.assigned_admin_id === actor.id,
      unread_for_user: await chatUnread(supabase, row.user_id, row.id),
    });
  }
  return { offset, limit, has_more: (data ?? []).length === limit, next_offset: (data ?? []).length === limit ? offset + limit : null, items, waiting_total: waitingTotal ?? 0 };
}

// —— CS2 POST /app/admin/chat/claim：waiting→active，assigned_admin_id CAS 空→本人 ——
export async function adminChatClaim(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "chat.handle");
  const session = await loadSession(supabase, body.session_id);
  if (session.status === "closed") throw new AppError(410, "chat_closed", "会话已结束");
  if (session.assigned_admin_id === actor.id) {
    return { session_id: session.id, status: session.status, already_assigned: true };
  }
  const taken = session.status === "active" || session.assigned_admin_id !== null;
  if (taken) {
    throw new AppError(409, "claim_conflict", "该会话已由其他客服接入", { assigned_admin_id: session.assigned_admin_id });
  }
  const now = nowIso();
  const { data: hit } = await supabase.from("chat_sessions")
    .update({ status: "active", assigned_admin_id: actor.id, updated_at: now })
    .eq("id", session.id).eq("status", "waiting").is("assigned_admin_id", null).select("id");
  if (!hit?.length) throw new AppError(409, "claim_conflict", "该会话已被其他客服接入，请刷新队列");
  await writeAudit(supabase, {
    adminId: actor.id, action: "chat.claim", targetType: "chat_session", targetId: session.id,
    detail: { user_id: session.user_id, from: session.status },
  });
  return { session_id: session.id, status: "active", from: session.status, claimed: true };
}

// 工作台读会话：先过 chat.handle，会话存在性由后台侧统一判定（CS3/CS4 再校验接入归属）
async function loadAdminSession(supabase, request, sessionId) {
  const { actor } = await adminGuard(supabase, request, "chat.handle");
  const session = await loadSession(supabase, sessionId);
  return { actor, session };
}

async function assertWritableByAdmin(session, actor) {
  if (session.status === "closed") throw new AppError(410, "chat_closed", "会话已结束");
  if (session.status === "waiting") {
    throw new AppError(409, "state_conflict", "请先接入境（CS2）再回复", { status: session.status });
  }
  if (session.assigned_admin_id !== actor.id) {
    throw new AppError(409, "claim_conflict", "该会话由其他客服接入", { assigned_admin_id: session.assigned_admin_id });
  }
}

// —— CS3 POST /app/admin/chat/reply [I] ——
export async function adminChatReply(supabase, request, body) {
  const { actor, session } = await loadAdminSession(supabase, request, body.session_id);
  await assertWritableByAdmin(session, actor);
  const draft = messageDraft(body);
  const msg = await insertMessage(supabase, {
    sessionId: session.id, senderType: "admin", senderId: actor.id, ...draft,
  });
  return { ...msg, status: session.status };
}

// —— CS3 GET /app/admin/chat/poll：工作台增量拉取，不动用户的已读游标 ——
export async function adminChatPoll(supabase, request, query) {
  await adminGuard(supabase, request, "chat.handle");
  const session = await loadSession(supabase, query.session_id);
  const since = await cursorIso(supabase, session.id, query.last_message_id);
  const { rows, has_more } = await listMessages(supabase, session.id, since);
  const messages = await withUrls(rows);
  const latest = messages[messages.length - 1];
  return {
    session_id: session.id,
    status: session.status,
    user_id: session.user_id,
    messages,
    has_more,
    last_message_id: latest?.message_id ?? (query.last_message_id ?? null),
  };
}

// —— CS4 POST /app/admin/chat/close [I]：→ closed + 系统消息 ——
export async function adminChatClose(supabase, request, body) {
  const { actor, session } = await loadAdminSession(supabase, request, body.session_id);
  if (session.status === "closed") {
    return { session_id: session.id, status: "closed", already_closed: true };
  }
  // 未接入的会话允许有 chat.handle 的账号直接收尾（用户已离场的空会话），已接入的只能由本人收
  if (session.status === "active" && session.assigned_admin_id !== actor.id) {
    throw new AppError(409, "claim_conflict", "该会话由其他客服接入", { assigned_admin_id: session.assigned_admin_id });
  }
  const now = nowIso();
  const { data: hit } = await supabase.from("chat_sessions")
    .update({ status: "closed", updated_at: now }).eq("id", session.id).eq("status", session.status).select("id");
  if (!hit?.length) throw new AppError(409, "state_conflict", "会话状态已变动，请刷新后重试");
  const msg = await systemMessage(supabase, session, TEXT_CLOSED_BY_ADMIN, stamp(Date.parse(now), 1));
  // 同上：客服收尾的系统话不进买家未读，未读只表示「买家还没看到客服的回复」
  await markUserRead(supabase, session.id, msg.created_at);
  await writeAudit(supabase, {
    adminId: actor.id, action: "chat.close", targetType: "chat_session", targetId: session.id,
    detail: { user_id: session.user_id, from: session.status },
  });
  return { session_id: session.id, status: "closed", from: session.status, message_id: msg.message_id };
}

// —— A4 附带：客服未读数（进行中会话 ∧ 非本人消息 ∧ created_at > user_read_at，D4g 说明 9）
// 只算 waiting/active：closed 是终态，而 CH1 只复用进行中会话（chat.mjs openFor），买家端再也打不开
// 已结束会话去推进游标。把它算进红点 = 永久消不掉的红点（现网实测：17 个会话全部 closed，8 个主体卡在 1）
export async function chatUnread(supabase, userId, onlySessionId = null) {
  let q = supabase.from("chat_sessions").select("id,user_read_at,created_at")
    .eq("user_id", userId).in("status", OPEN_STATUSES).order("last_message_at", { ascending: false }).limit(UNREAD_SCAN);
  if (onlySessionId) q = q.eq("id", vUuid(onlySessionId, "session_id"));
  const { data } = await q;
  let total = 0;
  for (const row of data ?? []) {
    const since = row.user_read_at ?? row.created_at;
    total += await countRows(supabase.from("chat_messages").select("id", { count: "exact" })
      .eq("session_id", row.id).neq("sender_type", "user").gt("created_at", since));
  }
  return total;
}

