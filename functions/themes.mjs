// M5 运营换肤：主题预设 CRUD（TH1–TH4）+ 生效皮肤/排期读时解析（文档E）
// 全部落 site_config 的 theme_presets / active_theme 两键（jsonb），无迁移、无后台任务。
import { AppError, ok } from "./errors.mjs";
import { requirePrincipal } from "./auth.mjs";
import { loadAdminPermissions, requirePermission, writeAudit } from "./permissions.mjs";
import { getMergedConfig, saveConfigKeys } from "./config.mjs";
import { vUuid } from "./validate.mjs";

const DEFAULT_PTR = { preset_id: "default", override: false };

async function loadThemeActor(supabase, request) {
  const actor = await requirePrincipal(supabase, request, "admin");
  requirePermission(await loadAdminPermissions(supabase, actor.id), "site.decorate");
  return actor;
}

// 命中当前生效预设：手动覆盖优先，其次排期（enabled ∧ 时段命中，sort 小者胜）
export function resolveActive(merged, nowMs = Date.now()) {
  const presets = merged.theme_presets ?? [];
  const ptr = merged.active_theme ?? DEFAULT_PTR;
  if (ptr.override) {
    const p = presets.find((x) => x.id === ptr.preset_id) ?? null;
    return { preset: p, mode: p ? "manual" : "default" };   // 悬空引用 → 回落默认
  }
  const winner = presets
    .filter((p) => p.enabled)
    .filter((p) => p.start_at == null || Date.parse(p.start_at) <= nowMs)
    .filter((p) => p.end_at == null || nowMs < Date.parse(p.end_at))
    .slice()
    .sort((a, b) => a.sort - b.sort)[0] ?? null;
  return { preset: winner, mode: winner ? "scheduled" : "default" };
}

// 前台只渲染启用模块 + 启用条目（模块级/条目级双层海报开关）
function visibleModules(mods) {
  return (mods ?? []).filter((m) => m.enabled).map((m) => ({
    ...m, items: (m.items ?? []).filter((it) => it.enabled !== false),
  }));
}

// 生效皮肤视图：无预设命中时回落默认皮肤（brand.hero_bg_key + 常态楼层）
export function effectiveCampaign(merged, nowMs = Date.now()) {
  const { preset, mode } = resolveActive(merged, nowMs);
  const baseModules = preset?.home_modules?.length ? preset.home_modules : merged.home_modules;
  const posters = preset
    ? {
      hero_bg_key: preset.hero_bg_key ?? null,
      page_bg_key: preset.page_bg_key ?? null,
      splash_poster: preset.splash_poster ?? { enabled: false, image_key: null, link: null },
      daily_popup: preset.daily_popup ?? { enabled: false, image_key: null, link: null, once_per_day: true },
    }
    : {
      hero_bg_key: merged.brand?.hero_bg_key ?? null,
      page_bg_key: null,
      splash_poster: { enabled: false, image_key: null, link: null },
      daily_popup: { enabled: false, image_key: null, link: null, once_per_day: true },
    };
  return {
    mode,
    theme: preset?.theme ?? merged.theme,
    home_modules: visibleModules(baseModules),
    posters,
    active_theme_id: preset?.id ?? null,
  };
}

// 二楼（活动会场）生效视图（文档G §二）：present = enabled ∧ 命中 UTC 半开区间 [start, end)
// 未命中或停用 → { present: false }，前端不挂下拉手势；命中才回渲染数据（复用 home_modules 过滤 + theme 回落生效皮肤）
function visibleSfModules(mods) {
  return (mods ?? []).filter((m) => m.enabled).map((m) => ({
    ...m, items: (m.items ?? []).filter((it) => it.enabled !== false),
  }));
}
export function secondFloorView(merged, fallbackTheme, nowMs = Date.now()) {
  const sf = merged.second_floor;
  if (!sf || sf.enabled !== true) return { present: false };
  const started = sf.start_at == null || Date.parse(sf.start_at) <= nowMs;
  const notEnded = sf.end_at == null || nowMs < Date.parse(sf.end_at);
  if (!started || !notEnded) return { present: false };
  return {
    present: true,
    title: sf.title || "",
    title_i18n: sf.title_i18n ?? null,
    background_key: sf.background_key ?? null,
    theme: sf.theme ?? fallbackTheme ?? merged.theme,
    trigger_hint: sf.trigger_hint ?? { text: "", icon_key: null },
    modules: visibleSfModules(sf.modules),
    cta: sf.cta ?? { label: "", link: "" },
  };
}

function presetStatus(p, { ptr, scheduledWin, nowMs }) {
  if (ptr.override && ptr.preset_id === p.id) return "manual";
  if (!p.enabled) return "disabled";
  const started = p.start_at == null || Date.parse(p.start_at) <= nowMs;
  const notEnded = p.end_at == null || nowMs < Date.parse(p.end_at);
  if (!started) return "scheduled";
  if (!notEnded) return "expired";
  return scheduledWin === p.id ? "active" : "standby";
}

// —— TH1 GET /app/admin/themes ——
export async function adminListThemes(supabase, request) {
  await loadThemeActor(supabase, request);
  const { config } = await getMergedConfig(supabase);
  const nowMs = Date.now();
  const ptr = config.active_theme ?? DEFAULT_PTR;
  const scheduledWin = resolveActive({ ...config, active_theme: DEFAULT_PTR }, nowMs).preset?.id ?? null;
  const items = (config.theme_presets ?? []).slice().sort((a, b) => a.sort - b.sort)
    .map((p) => ({ ...p, status: presetStatus(p, { ptr, scheduledWin, nowMs }) }));
  return ok({
    active_theme: ptr,
    effective: effectiveCampaign(config, nowMs),
    items,
    server_time: new Date(nowMs).toISOString(),
  });
}

// —— TH2 POST /app/admin/theme/save [I] —— 新建或整体覆盖一个预设
export async function adminSaveTheme(supabase, request, body) {
  const actor = await loadThemeActor(supabase, request);
  const incoming = body.preset;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    throw new AppError(400, "invalid_request", "缺少 preset 对象");
  }
  const id = incoming.id ? vUuid(incoming.id, "preset.id") : crypto.randomUUID();
  const { config } = await getMergedConfig(supabase);
  const presets = config.theme_presets ?? [];
  const existingIdx = presets.findIndex((p) => p.id === id);
  const merged = {
    ...incoming,
    id,
    sort: incoming.sort ?? (existingIdx >= 0 ? presets[existingIdx].sort : presets.length),
    enabled: incoming.enabled ?? (existingIdx >= 0 ? presets[existingIdx].enabled : false),
  };
  const next = existingIdx >= 0
    ? presets.map((p, i) => (i === existingIdx ? merged : p))
    : [...presets, merged];
  await saveConfigKeys(supabase, actor.id, { theme_presets: next });
  await writeAudit(supabase, {
    adminId: actor.id, action: existingIdx >= 0 ? "site.theme_update" : "site.theme_create",
    targetType: "site_config", targetId: null, detail: { preset_id: id, name: merged.name ?? null },
  });
  const { config: c2, configVersion } = await getMergedConfig(supabase);
  return ok({ theme_presets: c2.theme_presets, config_version: configVersion });
}

// —— TH3 POST /app/admin/theme/apply [I] —— 设为当前生效皮肤（preset_id="default" 取消手动覆盖）
export async function adminApplyTheme(supabase, request, body) {
  const actor = await loadThemeActor(supabase, request);
  const raw = body.preset_id ?? "default";
  const presetId = raw === "default" ? "default" : vUuid(raw, "preset_id");
  if (presetId !== "default") {
    const { config } = await getMergedConfig(supabase);
    if (!(config.theme_presets ?? []).some((p) => p.id === presetId)) {
      throw new AppError(404, "not_found", "预设不存在");
    }
  }
  const active = presetId === "default" ? DEFAULT_PTR : { preset_id: presetId, override: true };
  await saveConfigKeys(supabase, actor.id, { active_theme: active });
  await writeAudit(supabase, {
    adminId: actor.id, action: "site.theme_apply", targetType: "site_config", targetId: null,
    detail: { preset_id: presetId },
  });
  const { config: c2, configVersion } = await getMergedConfig(supabase);
  return ok({ active_theme: c2.active_theme, effective: effectiveCampaign(c2), config_version: configVersion });
}

// —— TH4 POST /app/admin/theme/delete [I] —— 删除预设；被手动引用则回落默认
export async function adminDeleteTheme(supabase, request, body) {
  const actor = await loadThemeActor(supabase, request);
  const id = vUuid(body.preset_id, "preset_id");
  const { config } = await getMergedConfig(supabase);
  const presets = config.theme_presets ?? [];
  const next = presets.filter((p) => p.id !== id);
  if (next.length === presets.length) throw new AppError(404, "not_found", "预设不存在");
  const patch = { theme_presets: next };
  if ((config.active_theme ?? DEFAULT_PTR).preset_id === id) patch.active_theme = DEFAULT_PTR;
  await saveConfigKeys(supabase, actor.id, patch);
  await writeAudit(supabase, {
    adminId: actor.id, action: "site.theme_delete", targetType: "site_config", targetId: null,
    detail: { preset_id: id },
  });
  const { config: c2, configVersion } = await getMergedConfig(supabase);
  return ok({ theme_presets: c2.theme_presets, active_theme: c2.active_theme, config_version: configVersion });
}
