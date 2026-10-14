// 公告（文档A §27 announcements / 文档B §9 状态机 + T7 / 方案 §11 四种人群 / 文档C AN1）
// 四种 scope 各自对应一条固定投放通道：banner=首页横幅、popup=首页弹窗（每人每天≤1 次，应用层）、
// user=单人定向、vip=VIP 定向；后两种通过 notifications 进消息中心（文档B §9：公告已读不占未读红点）。
import { AppError } from "./errors.mjs";
import { adminGuard, writeAudit } from "./permissions.mjs";
import { emit } from "./notify.mjs";
import { nowIso, pageParams, pageResult, vBool, vEnum, vJson, vStr, vUuid } from "./validate.mjs";

export const ANNOUNCE_SCOPES = ["banner", "popup", "user", "vip"];
export const ANNOUNCE_STATUS = ["draft", "published", "offline"];
/** 定向公告发布时要落消息的两种人群（banner/popup 属全站展示位，不群发消息） */
const DIRECTED_SCOPES = ["user", "vip"];
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SCAN_LIMIT = 50;
/** 单次发布的 VIP 群发上限：到期权益名单可能很大，超出的部分靠消息中心已有的分页展示，不做静默截断 */
const FANOUT_LIMIT = 200;
const COLS = "id,scope,target_user_id,title,content,title_i18n,content_i18n,status,publish_at,expire_at,created_at,updated_at";

function vTime(v, field, { optional = false } = {}) {
  if ((v === undefined || v === null || v === "") && optional) return null;
  const s = vStr(v, field, { max: 40, pattern: ISO_RE });
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new AppError(400, "invalid_request", "时间格式不合法", { field });
  return new Date(ms).toISOString();
}

/** 多语言取词：当前语言缺词回退 zh，再缺回退函数写入的原文（同 ui_strings 口径） */
function pickI18n(map, lang, fallback) {
  const m = map ?? {};
  const hit = typeof m[lang] === "string" ? m[lang].trim() : "";
  if (hit) return hit;
  const zh = typeof m.zh === "string" ? m.zh.trim() : "";
  return zh || fallback;
}

function announceView(row, lang = "zh") {
  return {
    announcement_id: row.id,
    scope: row.scope,
    status: row.status,
    target_user_id: row.target_user_id ?? null,
    title: pickI18n(row.title_i18n, lang, row.title),
    content: pickI18n(row.content_i18n, lang, row.content),
    title_i18n: row.title_i18n ?? {},
    content_i18n: row.content_i18n ?? {},
    publish_at: row.publish_at,
    expire_at: row.expire_at ?? null,
  };
}

async function loadAnnouncement(supabase, id) {
  const { data } = await supabase.from("announcements").select(COLS)
    .eq("id", id).is("deleted_at", null).maybeSingle();
  if (!data) throw new AppError(404, "not_found", "公告不存在");
  return data;
}

function announceDraft(body) {
  const scope = vEnum(body.scope, "scope", ANNOUNCE_SCOPES);
  const draft = {
    scope,
    title: vStr(body.title, "title", { min: 1, max: 200 }),
    content: vStr(body.content, "content", { min: 1, max: 2000 }),
    title_i18n: vJson(body.title_i18n ?? {}, "title_i18n"),
    content_i18n: vJson(body.content_i18n ?? {}, "content_i18n"),
    publish_at: body.publish_at === undefined || body.publish_at === null || body.publish_at === ""
      ? nowIso() : vTime(body.publish_at, "publish_at"),
    expire_at: vTime(body.expire_at, "expire_at", { optional: true }),
  };
  if (draft.expire_at && Date.parse(draft.expire_at) <= Date.parse(draft.publish_at)) {
    throw new AppError(400, "invalid_request", "下线时间必须晚于发布时间", { field: "expire_at" });
  }
  return draft;
}

// —— AN1 POST /app/admin/announcement/save（content.manage；新建/修改/软删，不改状态）——
export async function adminAnnouncementSave(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "content.manage");
  const id = body.announcement_id ? vUuid(body.announcement_id, "announcement_id") : null;

  if (vBool(body.delete ?? false, "delete")) {
    if (!id) throw new AppError(400, "invalid_request", "删除公告需要 announcement_id", { field: "announcement_id" });
    const doomed = await loadAnnouncement(supabase, id);
    const { data: gone } = await supabase.from("announcements")
      .update({ deleted_at: nowIso(), updated_at: nowIso() }).eq("id", id).is("deleted_at", null).select("id");
    if (!gone?.length) throw new AppError(404, "not_found", "公告不存在");
    await writeAudit(supabase, {
      adminId: actor.id, action: "announcement.delete", targetType: "announcement", targetId: id,
      detail: { scope: doomed.scope, title: doomed.title },
    });
    return { announcement_id: id, deleted: true };
  }

  const draft = announceDraft(body);
  // target_user_id 语义：user=单人站内信（必带）；popup=可选定向（带则单用户弹窗，不带则全站弹窗）；banner/vip 不存
  draft.target_user_id = null;
  if (draft.scope === "user" || (draft.scope === "popup" && body.target_user_id)) {
    const userId = vUuid(body.target_user_id, "target_user_id");
    const { data: target } = await supabase.from("users").select("id,username").eq("id", userId)
      .is("deleted_at", null).maybeSingle();
    if (!target) throw new AppError(404, "not_found", "定向用户不存在");
    draft.target_user_id = userId;
  }

  const now = nowIso();
  if (id) {
    const current = await loadAnnouncement(supabase, id);
    const { data: updated, error } = await supabase.from("announcements")
      .update({ ...draft, updated_at: now }).eq("id", id).eq("status", current.status).is("deleted_at", null).select("id");
    if (error) throw new AppError(500, "internal_error");
    if (!updated?.length) throw new AppError(409, "state_conflict", "公告状态已变动，请刷新后重试");
    await writeAudit(supabase, {
      adminId: actor.id, action: "announcement.save", targetType: "announcement", targetId: id,
      detail: { scope: draft.scope, title: draft.title, status: current.status },
    });
    return { announcement_id: id, updated: true, status: current.status };
  }
  const newId = crypto.randomUUID();
  const { error } = await supabase.from("announcements").insert({
    id: newId, ...draft, status: "draft", created_at: now, updated_at: now, deleted_at: null,
  });
  if (error) throw new AppError(500, "internal_error");
  await writeAudit(supabase, {
    adminId: actor.id, action: "announcement.save", targetType: "announcement", targetId: newId,
    detail: { scope: draft.scope, title: draft.title, status: "draft" },
  });
  return { announcement_id: newId, created: true, status: "draft" };
}

// 定向公告发布时落消息中心。通知失败不回滚发布——公告本身已在位，消息是副作用（文档C §九.5）
async function fanout(supabase, row) {
  let userIds = [];
  if (row.target_user_id) {
    // 单人定向站内信（scope=user）与单用户弹窗（scope=popup ∧ 带 target）都走这一条：弹窗 + 站内信各一条
    userIds = [row.target_user_id];
  } else if (row.scope === "vip") {
    const { data } = await supabase.from("user_vips").select("user_id")
      .eq("status", "active").gt("expire_at", nowIso()).order("expire_at", { ascending: false }).limit(FANOUT_LIMIT);
    userIds = [...new Set((data ?? []).map((r) => r.user_id))];
  }
  const sent = [];
  for (const userId of userIds.filter(Boolean)) {
    const res = await emit(supabase, {
      userId, msgType: "announcement", title: row.title, content: row.content,
      refType: "announcement", refId: row.id,
    });
    if (res.emitted) sent.push(userId);
  }
  return { fanout: sent.length, skipped: userIds.length - sent.length };
}

// —— AN1 POST /app/admin/announcement/publish ⚠（content.publish；draft/offline → published）——
export async function adminAnnouncementPublish(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "content.publish");
  const id = vUuid(body.announcement_id, "announcement_id");
  const current = await loadAnnouncement(supabase, id);
  if (current.status === "published") {
    return { announcement_id: id, status: "published", already_published: true };
  }
  const publishAt = body.publish_at === undefined || body.publish_at === null || body.publish_at === ""
    ? current.publish_at : vTime(body.publish_at, "publish_at");
  const { data: hit } = await supabase.from("announcements")
    .update({ status: "published", publish_at: publishAt, updated_at: nowIso() })
    .eq("id", id).eq("status", current.status).is("deleted_at", null).select("id");
  if (!hit?.length) throw new AppError(409, "state_conflict", "公告状态已变动，请刷新后重试");
  const shouldFanout = DIRECTED_SCOPES.includes(current.scope)
    || (current.scope === "popup" && current.target_user_id);
  const out = shouldFanout ? await fanout(supabase, current) : { fanout: 0, skipped: 0 };
  await writeAudit(supabase, {
    adminId: actor.id, action: "announcement.publish", targetType: "announcement", targetId: id,
    detail: { scope: current.scope, from: current.status, publish_at: publishAt, fanout: out.fanout },
  });
  return { announcement_id: id, status: "published", from: current.status, publish_at: publishAt, notified: out.fanout };
}

// —— AN1 POST /app/admin/announcement/offline（content.publish；published → offline）——
export async function adminAnnouncementOffline(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "content.publish");
  const id = vUuid(body.announcement_id, "announcement_id");
  const current = await loadAnnouncement(supabase, id);
  if (current.status === "offline") return { announcement_id: id, status: "offline", already_offline: true };
  const { data: hit } = await supabase.from("announcements")
    .update({ status: "offline", updated_at: nowIso() })
    .eq("id", id).eq("status", current.status).select("id");
  if (!hit?.length) throw new AppError(409, "state_conflict", "公告状态已变动，请刷新后重试");
  await writeAudit(supabase, {
    adminId: actor.id, action: "announcement.offline", targetType: "announcement", targetId: id,
    detail: { scope: current.scope, from: current.status },
  });
  return { announcement_id: id, status: "offline", from: current.status };
}

// 后台公告列表（文档C 未单列读端点，与 admin/refunds 同类补充；content.manage）
export async function adminAnnouncements(supabase, request, query) {
  await adminGuard(supabase, request, "content.manage");
  const { offset, limit } = pageParams(query);
  let q = supabase.from("announcements").select(COLS).is("deleted_at", null)
    .order("publish_at", { ascending: false });
  if (query.scope) q = q.eq("scope", vEnum(query.scope, "scope", ANNOUNCE_SCOPES));
  if (query.status) q = q.eq("status", vEnum(query.status, "status", ANNOUNCE_STATUS));
  const { data, error } = await q.range(offset, offset + limit);
  if (error) throw new AppError(500, "internal_error");
  const page = pageResult((data ?? []).map((r) => announceView(r)), offset, limit);
  return page;
}

// —— S1 附带：首页可见的横幅/弹窗公告（横幅全站；弹窗=全站弹窗 + 定向到当前用户的弹窗）——
export async function visibleAnnouncements(supabase, { lang = "zh", userId = null, nowMs = Date.now() } = {}) {
  const now = new Date(nowMs).toISOString();
  const { data } = await supabase.from("announcements").select(COLS)
    .eq("status", "published").in("scope", ["banner", "popup"])
    .lte("publish_at", now).order("publish_at", { ascending: false }).limit(SCAN_LIMIT);
  const rows = (data ?? []).filter((r) => !r.expire_at || Date.parse(r.expire_at) > nowMs);
  // 弹窗有两种：无 target=全站弹窗；带 target=定向弹窗，仅该用户可见（后台「单用户弹窗」）
  const popup = rows.filter((r) => r.scope === "popup"
    && (!r.target_user_id || (userId && r.target_user_id === userId)));
  return {
    banner: rows.filter((r) => r.scope === "banner" && !r.target_user_id).map((r) => announceView(r, lang)),
    popup: popup.map((r) => announceView(r, lang)),
  };
}

// —— T7 公告到期下线（文档B §9：published ∧ expire_at ≤ now → offline；无消息副作用）——
export async function taskExpireAnnouncements(supabase, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  const { data: rows } = await supabase.from("announcements").select("id,title,expire_at")
    .eq("status", "published").lte("expire_at", now).order("expire_at", { ascending: true }).limit(SCAN_LIMIT);
  let offline = 0;
  for (const row of rows ?? []) {
    const { data: hit } = await supabase.from("announcements")
      .update({ status: "offline", updated_at: now }).eq("id", row.id).eq("status", "published").select("id");
    if (hit?.length) offline += 1;
  }
  return offline;
}
