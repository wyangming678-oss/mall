import { useEffect, useState } from "react";
import { ApiError, call, newIdem } from "../../api";
import { useSite } from "../../site";
import { useAdmin } from "../AdminAuth";
import { PageTitle, errText, riskyPost, isConfirmCancel, useBusy } from "../ui";
import { useAssetUrl } from "../../components/BrandMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CampaignView, ThemePreset, PayChannelConfig } from "../../site";
import { NON_METHOD_KEYS } from "../../site";
import { baseUnit } from "../../const";
import { yuanToCents } from "../../trade";

interface DraftBrand { site_name: string; logo_key: string | null; favicon_key: string | null; hero_bg_key: string | null }
interface DraftTheme { primary: string; secondary: string; background: string; text: string; radius: string; font: string }
interface DraftNav { label: string; label_en: string; label_ja: string; label_ko: string; label_es: string; target: string; visible: boolean }
interface ConfigHistoryItem { version: number; saved_by: string | null; note: string | null; created_at: string }

/** 导航名四语一起提交：只发英文会把已存的日/韩/西语名覆盖没了 */
function navI18n(n: DraftNav): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (n.label_en.trim()) out.en = n.label_en.trim();
  if (n.label_ja.trim()) out.ja = n.label_ja.trim();
  if (n.label_ko.trim()) out.ko = n.label_ko.trim();
  if (n.label_es.trim()) out.es = n.label_es.trim();
  return Object.keys(out).length ? out : null;
}
interface ChainRowDraft { symbol: string; network: string; address: string; note: string; note_en: string; note_ja: string; note_ko: string; note_es: string; rate: string; decimals: string; image_key: string | null }
/** 币种子表的新空白行：小数位默认 2，与函数侧 coinChains 的缺省一致，避免后台保存把已存值改口径 */
const CHAIN_BLANK: ChainRowDraft = { symbol: "", network: "", address: "", note: "", note_en: "", note_ja: "", note_ko: "", note_es: "", rate: "", decimals: "2", image_key: null };
/** CEX 支付渠道码：后台把它单独拆成一张设置栏，其余渠道留在通用列表 */
const CRYPTO_METHOD = "CRYPTO";
interface ChannelDraft { method: string; display_name: string; fulfillment: "manual" | "online"; enabled: boolean; holder_name: string; account_no: string; pay_link: string; account_note: string; account_note_en: string; account_note_ja: string; account_note_ko: string; account_note_es: string; image_key: string | null; provider: string; chains: ChainRowDraft[] }

/** 收款说明 / 币种备注的多语：只提交非空语种，留空的语种由购物端回落中文原文（同商品译文口径） */
function textI18n(en: string, ja: string, ko: string, es: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (en.trim()) out.en = en.trim();
  if (ja.trim()) out.ja = ja.trim();
  if (ko.trim()) out.ko = ko.trim();
  if (es.trim()) out.es = es.trim();
  return Object.keys(out).length ? out : null;
}

const NOTE_LANGS: { lang: "en" | "ja" | "ko" | "es"; label: string }[] = [
  { lang: "en", label: "English" },
  { lang: "ja", label: "日本語" },
  { lang: "ko", label: "한국어" },
  { lang: "es", label: "Español" },
];

/** 收款说明 / 币种备注的四语录入框。留空 = 购物端回落中文原文，不是显示空白 */
function NoteI18nFields(props: {
  idPrefix: string;
  field: string;
  max: number;
  multiline?: boolean;
  blankHint?: string;
  values: Record<"en" | "ja" | "ko" | "es", string>;
  onChange: (lang: "en" | "ja" | "ko" | "es", text: string) => void;
}) {
  const blank = props.blankHint ?? "留空则显示中文";
  return (
    <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
      {NOTE_LANGS.map((L) => (
        <div key={L.lang} className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${props.idPrefix}-${L.lang}`} className="text-xs font-normal text-muted-foreground">
            {L.label} {props.field}（选填）
          </Label>
          {props.multiline ? (
            <textarea
              id={`${props.idPrefix}-${L.lang}`}
              className="min-h-12 w-full border bg-background px-2 py-1 text-sm"
              maxLength={props.max}
              placeholder={blank}
              value={props.values[L.lang]}
              onChange={(e) => props.onChange(L.lang, e.target.value)}
            />
          ) : (
            <Input
              id={`${props.idPrefix}-${L.lang}`}
              className="h-9"
              maxLength={props.max}
              placeholder={blank}
              value={props.values[L.lang]}
              onChange={(e) => props.onChange(L.lang, e.target.value)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
interface DraftModuleItem { title: string; image_key: string | null; link: string; enabled: boolean }
/** title_en/ja/ko/es = 楼层标题译名；留空则前台按语言回落内置词表（见 Home.tsx 的 moduleTitle） */
interface DraftModule { module: string; enabled: boolean; sort: number; title: string; title_en: string; title_ja: string; title_ko: string; title_es: string; items: DraftModuleItem[] }

/** 首页楼层的固定词表（与函数侧 home_modules 校验枚举一致，顺序即默认展示顺序） */
const MODULE_META: { module: string; name: string; hint: string; productFloor?: boolean }[] = [
  { module: "banner", name: "Banner 轮播（滚动广告）", hint: "每条 = 标题 + 图片 + 跳转地址。传图建议 1600×700 横图；不传图就用品牌绿底显示标题文字广告。2 条以上首页每 5 秒自动滚动，1 条静态展示；标题与图片都为空的条目不会上首页" },
  { module: "image_nav", name: "图文导航（圆形入口）", hint: "建议 200×200 方图；不配置时首页用内置入口：分类 / 领券 / 订单 / 钱包 / 我的" },
  { module: "announce", name: "公告栏", hint: "一行横滚公告文字，可配跳转；全部留空则首页不显示公告条" },
  { module: "recommend", name: "推荐位（四联小卡）", hint: "商品取自「商品管理」上架列表前 4 件，此处只改标题与开关", productFloor: true },
  { module: "hot", name: "热销榜（双列网格）", hint: "商品取上架列表接下来的 8 件，此处只改标题与开关", productFloor: true },
  { module: "activity", name: "活动楼层", hint: "图片砖块楼层，用于专题/活动入口" },
  { module: "brand_story", name: "品牌故事", hint: "图片砖块楼层，用于品牌图文" },
];

/** 海报草稿（开屏/每日弹窗）：关=前台整块海报位不渲染 */
interface DraftPoster { enabled: boolean; image_key: string | null; link: string }
/** 主题预设编辑草稿：home 为楼层快照（含条目级开关），startAt/endAt 为 datetime-local 串 */
interface DraftPreset {
  id: string | null; name: string; theme: DraftTheme; home: DraftModule[];
  hero_bg_key: string | null; page_bg_key: string | null;
  splash: DraftPoster; popup: DraftPoster;
  startAt: string; endAt: string; enabled: boolean; sort: number;
}

interface ThemesResp {
  active_theme: { preset_id: string; override: boolean };
  effective: CampaignView;
  items: ThemePreset[];
  server_time: string;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  manual: { label: "手动生效", cls: "bg-primary text-white" },
  active: { label: "排期生效中", cls: "bg-emerald-600 text-white" },
  scheduled: { label: "待开始", cls: "bg-sky-600 text-white" },
  standby: { label: "候补", cls: "bg-muted text-muted-foreground" },
  expired: { label: "已过期", cls: "bg-zinc-500 text-white" },
  disabled: { label: "已停用", cls: "bg-muted text-muted-foreground" },
};

function posterOf(p?: { enabled: boolean; image_key: string | null; link: string | null } | null): DraftPoster {
  return { enabled: p?.enabled ?? false, image_key: p?.image_key ?? null, link: p?.link ?? "" };
}

/** 楼层标题多语译名 → site_config 的 title_i18n；全空回 null，避免把空白存成对象 */
function floorI18n(m: Pick<DraftModule, "title_en" | "title_ja" | "title_ko" | "title_es">) {
  const out: Record<string, string> = {};
  if (m.title_en.trim()) out.en = m.title_en.trim();
  if (m.title_ja.trim()) out.ja = m.title_ja.trim();
  if (m.title_ko.trim()) out.ko = m.title_ko.trim();
  if (m.title_es.trim()) out.es = m.title_es.trim();
  return Object.keys(out).length ? out : null;
}

function toHomeModulesPayload(mods: DraftModule[]) {
  return mods.map((m, i) => ({
    module: m.module,
    enabled: m.enabled,
    sort: i,
    title: m.title.trim() || null,
    title_i18n: floorI18n(m),
    items: m.items.map((it) => ({ title: it.title.trim() || null, image_key: it.image_key, link: it.link.trim() || null, enabled: it.enabled !== false })),
  }));
}

/** datetime-local 串按 UTC 解释 → ISO，与公告/券同一口径，避免保存漂移时区 */
function isoOf(local: string): string | null {
  if (!local) return null;
  const ms = Date.parse(local.length === 16 ? `${local}:00Z` : local);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
/** ISO → datetime-local 展示串（截到分钟，UTC 口径） */
function localOf(iso: string | null): string {
  return iso ? iso.slice(0, 16) : "";
}

/** 固定楼层词表 → 可编辑草稿：按 MODULE_META 顺序补齐缺失模块，defOn 决定未配置项的默认开关 */
function modsFrom(src: { module: string; enabled: boolean; sort: number; title: string | null; title_i18n?: Record<string, string> | null; items?: { title: string | null; image_key: string | null; link: string | null; enabled: boolean }[] }[] | undefined, defOn: (i: number) => boolean): DraftModule[] {
  return MODULE_META.map((meta, i) => {
    const found = (src ?? []).find((m) => m.module === meta.module);
    return {
      module: meta.module,
      enabled: found?.enabled ?? defOn(i),
      sort: found?.sort ?? i,
      title: found?.title ?? "",
      title_en: found?.title_i18n?.en ?? "",
      title_ja: found?.title_i18n?.ja ?? "",
      title_ko: found?.title_i18n?.ko ?? "",
      title_es: found?.title_i18n?.es ?? "",
      items: (found?.items ?? []).map((it) => ({ title: it.title ?? "", image_key: it.image_key ?? null, link: it.link ?? "", enabled: it.enabled !== false })),
    };
  }).sort((a, b) => a.sort - b.sort);
}

/** 商城二楼编辑草稿：modules 复用首页模块编辑器；customTheme=false 时提交 theme:null 回落生效皮肤 */
interface DraftSecondFloor {
  enabled: boolean; title: string; title_en: string; title_ja: string; title_ko: string; title_es: string;
  startAt: string; endAt: string;
  background_key: string | null;
  customTheme: boolean; theme: DraftTheme;
  hintText: string; hintIconKey: string | null;
  ctaLabel: string; ctaLink: string;
  modules: DraftModule[];
}

/** 二楼标题译名：四语一起提交，缺一语就等于把已存的那一语清掉，所以必须逐语言带上 */
function sfI18n(d: Pick<DraftSecondFloor, "title_en" | "title_ja" | "title_ko" | "title_es">) {
  const out: Record<string, string> = {};
  if (d.title_en.trim()) out.en = d.title_en.trim();
  if (d.title_ja.trim()) out.ja = d.title_ja.trim();
  if (d.title_ko.trim()) out.ko = d.title_ko.trim();
  if (d.title_es.trim()) out.es = d.title_es.trim();
  return Object.keys(out).length ? out : null;
}

/** 二楼草稿 → site_config.second_floor 载荷（键名裸写，与 home_modules 等同一约定） */
function buildSfPayload(d: DraftSecondFloor) {
  return {
    enabled: d.enabled,
    start_at: isoOf(d.startAt),
    end_at: isoOf(d.endAt),
    title: d.title.trim(),
    title_i18n: sfI18n(d),
    background_key: d.background_key,
    theme: d.customTheme ? d.theme : null,
    trigger_hint: { text: d.hintText.trim(), icon_key: d.hintIconKey },
    cta: { label: d.ctaLabel.trim(), link: d.ctaLink.trim() },
    modules: toHomeModulesPayload(d.modules),
  };
}

function snapshotMods(mods: DraftModule[]): DraftModule[] {
  return mods.map((m) => ({ ...m, items: m.items.map((it) => ({ ...it })) }));
}

function presetToDraft(p: ThemePreset): DraftPreset {
  return {
    id: p.id, name: p.name,
    theme: { ...p.theme } as unknown as DraftTheme,
    home: (p.home_modules ?? []).map((m, i) => ({
      module: m.module, enabled: m.enabled, sort: m.sort ?? i, title: m.title ?? "",
      title_en: m.title_i18n?.en ?? "", title_ja: m.title_i18n?.ja ?? "", title_ko: m.title_i18n?.ko ?? "", title_es: m.title_i18n?.es ?? "",
      items: (m.items ?? []).map((it) => ({ title: it.title ?? "", image_key: it.image_key, link: it.link ?? "", enabled: it.enabled !== false })),
    })),
    hero_bg_key: p.hero_bg_key ?? null, page_bg_key: p.page_bg_key ?? null,
    splash: posterOf(p.splash_poster), popup: posterOf(p.daily_popup),
    startAt: p.start_at ?? "", endAt: p.end_at ?? "", enabled: p.enabled, sort: p.sort,
  };
}

function blankPreset(theme: DraftTheme, mods: DraftModule[]): DraftPreset {
  return {
    id: null, name: "", theme: { ...theme }, home: snapshotMods(mods),
    hero_bg_key: null, page_bg_key: null,
    splash: { enabled: false, image_key: null, link: "" }, popup: { enabled: false, image_key: null, link: "" },
    startAt: "", endAt: "", enabled: false, sort: mods.length,
  };
}

function presetPayload(d: DraftPreset) {
  return {
    ...(d.id ? { id: d.id } : {}),
    name: d.name.trim(),
    theme: d.theme,
    home_modules: toHomeModulesPayload(d.home),
    hero_bg_key: d.hero_bg_key,
    page_bg_key: d.page_bg_key,
    splash_poster: { enabled: d.splash.enabled, image_key: d.splash.image_key, link: d.splash.link.trim() || null },
    daily_popup: { enabled: d.popup.enabled, image_key: d.popup.image_key, link: d.popup.link.trim() || null, once_per_day: true },
    start_at: d.startAt || null,
    end_at: d.endAt || null,
    enabled: d.enabled,
    sort: d.sort,
  };
}

async function uploadImage(file: File, prefix: string): Promise<string> {
  const data = await file.arrayBuffer();
  const bytes = new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return call<{ key: string }>("file/upload", {
    method: "POST",
    token: "admin",
    idem: newIdem(),
    body: { name: file.name, data_base64: btoa(bin), prefix },
  }).then((r) => r.key);
}

function BrandAssetRow({ label, hint, value, disabled, canDelete, onChange, onError }: {
  label: string; hint: string; value: string | null; disabled: boolean; canDelete: boolean;
  onChange: (k: string | null) => void; onError: (msg: string) => void;
}) {
  const [busy, run] = useBusy();
  const url = useAssetUrl(value);

  function removeAsset() {
    if (!value) return;
    if (!window.confirm(`删除素材文件？\n${value}\n\n将从存储中永久移除，并清除这里的引用（记得随后点保存）。`)) return;
    const key = value;
    void run(async () => {
      try {
        await call("file/remove", { method: "POST", token: "admin", idem: newIdem(), body: { key } });
        onChange(null);
      } catch (err) {
        onError(errText(err));
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="w-20 shrink-0 font-medium">{label}</span>
      <span className={`grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl border bg-muted ${url ? "" : "text-xs text-muted-foreground"}`}>
        {url ? <img src={url} alt="" className="size-full object-contain p-0.5" /> : "预览"}
      </span>
      <label className={`flex cursor-pointer items-center gap-1 text-primary underline ${busy || disabled ? "pointer-events-none opacity-60" : ""}`}>
        {value ? "更换图片" : "上传图片"}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void run(async () => {
              try {
                onChange(await uploadImage(file, "brand"));
              } catch (err) {
                onError(errText(err));
              }
            });
          }}
        />
      </label>
      {value && (
        <>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => onChange(null)}>清除引用</Button>
          {canDelete && (
            <Button size="sm" variant="outline" disabled={disabled || busy} onClick={removeAsset}>删除素材</Button>
          )}
        </>
      )}
      <span className="max-w-44 truncate text-xs text-muted-foreground" title={hint}>{value ?? hint}</span>
    </div>
  );
}

/** 海报位编辑块：开关 + 图片 + 跳转。关闭时前台整块海报位不渲染 */
function PosterBlock({ title, note, hint, poster, busy, onChange, onError }: {
  title: string; note: string; hint: string; poster: DraftPoster; busy: boolean;
  onChange: (next: DraftPoster) => void; onError: (msg: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-border/70 pt-2">
      <label className="flex items-center gap-2 text-sm">
        <span className="font-medium">{title}</span>
        <Switch checked={poster.enabled} onCheckedChange={(v) => onChange({ ...poster, enabled: v })} />
        <span className="text-xs text-muted-foreground">{note}</span>
      </label>
      {poster.enabled && (
        <>
          <BrandAssetRow
            label="海报图"
            hint={hint}
            value={poster.image_key}
            disabled={busy}
            canDelete={false}
            onChange={(k) => onChange({ ...poster, image_key: k })}
            onError={onError}
          />
          <div className="flex items-center gap-2 text-sm">
            <span className="w-20 shrink-0 font-medium">跳转地址</span>
            <Input value={poster.link} placeholder="/product?id=… 或 /category （可空）" maxLength={200} onChange={(e) => onChange({ ...poster, link: e.target.value })} className="w-72" />
          </div>
        </>
      )}
    </div>
  );
}

/** 楼层条目：图片（brand 前缀，公共可读）+ 标题 + 跳转 */
function ModuleItemRow({ item, disabled, onChange, onRemove, onError }: {
  item: DraftModuleItem; disabled: boolean;
  onChange: (next: DraftModuleItem) => void; onRemove: () => void; onError: (msg: string) => void;
}) {
  const [busy, run] = useBusy();
  const url = useAssetUrl(item.image_key);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className={`grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border bg-muted ${url ? "" : "text-[10px] text-muted-foreground"}`}>
        {url ? <img src={url} alt="" className="size-full object-cover" /> : "方图"}
      </span>
      <label className={`flex cursor-pointer items-center gap-1 text-primary underline ${busy || disabled ? "pointer-events-none opacity-60" : ""}`}>
        {item.image_key ? "换图" : "上传图片"}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void run(async () => {
              try {
                onChange({ ...item, image_key: await uploadImage(file, "brand") });
              } catch (err) {
                onError(errText(err));
              }
            });
          }}
        />
      </label>
      <Input value={item.title} placeholder="标题（可空）" maxLength={60} onChange={(e) => onChange({ ...item, title: e.target.value })} className="w-44" />
      <Input value={item.link} placeholder="/category 或 /product?id=…" maxLength={200} onChange={(e) => onChange({ ...item, link: e.target.value })} className="w-56" />
      <label className="flex items-center gap-1" title="关闭后该条海报不在前台渲染（海报位整体不显示）">
        显示
        <Switch checked={item.enabled} onCheckedChange={(v) => onChange({ ...item, enabled: v })} />
      </label>
      <Button size="sm" variant="outline" disabled={disabled} onClick={onRemove}>删除</Button>
      {busy && <span className="text-xs text-muted-foreground">上传中…</span>}
    </div>
  );
}

/** 楼层编辑器：上下移调顺序、启用开关、标题、内容条目（首页模块与二楼共用同一词表与交互） */
function ModulesEditor({ mods, onChange, busy, onError }: {
  mods: DraftModule[]; onChange: (next: DraftModule[]) => void; busy: boolean; onError: (msg: string) => void;
}) {
  const patchMod = (i: number, next: DraftModule) => onChange(mods.map((m, j) => (i === j ? next : m)));
  const moveMod = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= mods.length) return;
    const next = mods.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <>
      {mods.map((m, i) => {
        const meta = MODULE_META.find((x) => x.module === m.module);
        return (
          <div key={m.module} className={"flex flex-col gap-2 border-t border-border/70 pt-3 " + (m.enabled ? "" : "opacity-60")}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-40 shrink-0 font-medium">{meta?.name ?? m.module}</span>
              <label className="flex items-center gap-1">启用<Switch checked={m.enabled} onCheckedChange={(v) => patchMod(i, { ...m, enabled: v })} /></label>
              <Input value={m.title} placeholder="楼层标题（留空用前台默认）" maxLength={60} onChange={(e) => patchMod(i, { ...m, title: e.target.value })} className="w-56" />
              <Button size="sm" variant="outline" disabled={i === 0} onClick={() => moveMod(i, -1)}>上移</Button>
              <Button size="sm" variant="outline" disabled={i === mods.length - 1} onClick={() => moveMod(i, 1)}>下移</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-40 shrink-0 text-muted-foreground">标题译名（留空＝内置标题自动随语言，改过的中文标题则全语言通用）</span>
              <Input aria-label="英文楼层标题" value={m.title_en} placeholder="English" maxLength={60} onChange={(e) => patchMod(i, { ...m, title_en: e.target.value })} className="w-40" />
              <Input aria-label="日文楼层标题" value={m.title_ja} placeholder="日本語" maxLength={60} onChange={(e) => patchMod(i, { ...m, title_ja: e.target.value })} className="w-36" />
              <Input aria-label="韩文楼层标题" value={m.title_ko} placeholder="한국어" maxLength={60} onChange={(e) => patchMod(i, { ...m, title_ko: e.target.value })} className="w-36" />
              <Input aria-label="西语楼层标题" value={m.title_es} placeholder="Español" maxLength={60} onChange={(e) => patchMod(i, { ...m, title_es: e.target.value })} className="w-36" />
            </div>
            <p className="text-xs text-muted-foreground">{meta?.hint}</p>
            {m.enabled && !meta?.productFloor && (
              <details className="text-sm">
                <summary className="cursor-pointer select-none text-primary">内容条目（{m.items.length}/20）</summary>
                <div className="mt-2 flex flex-col gap-2">
                  {m.items.map((it, j) => (
                    <ModuleItemRow
                      key={`${m.module}-${j}`}
                      item={it}
                      disabled={busy}
                      onChange={(next) => patchMod(i, { ...m, items: m.items.map((x, k) => (j === k ? next : x)) })}
                      onRemove={() => patchMod(i, { ...m, items: m.items.filter((_, k) => k !== j) })}
                      onError={onError}
                    />
                  ))}
                  {m.items.length < 20 && (
                    <div>
                      <Button size="sm" variant="outline" onClick={() => patchMod(i, { ...m, items: [...m.items, { title: "", image_key: null, link: "", enabled: true }] })}>添加一项</Button>
                    </div>
                  )}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </>
  );
}

export default function DecorPage() {
  const { config, refresh } = useSite();
  const { has } = useAdmin();
  const [busy, run] = useBusy();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [brand, setBrand] = useState<DraftBrand>({ site_name: "", logo_key: null, favicon_key: null, hero_bg_key: null });
  const [theme, setTheme] = useState<DraftTheme>({ primary: "#2ECC71", secondary: "#16A085", background: "#F6FAF7", text: "#1F2937", radius: "sm", font: "sans" });
  const [switches, setSwitches] = useState({ register_open: true, order_open: true, maintenance: false, vip_coupon_stack: true, invite_reward_trigger: "register" as "register" | "first_order", coins: false, installment: false });
  // 余额提现门槛（site_config.withdraw，分/本位币）：草稿按「元」录入，保存时转分整键下发（缺字段会被后端默认补，务必发全）
  const [wd, setWd] = useState({ enabled: false, minYuan: "1", maxYuan: "9999999999", daily: "1" });
  const [defaultLang, setDefaultLang] = useState("zh");
  const [nav, setNav] = useState<DraftNav[]>([]);
  const [payTimeout, setPayTimeout] = useState(48);
  const [channels, setChannels] = useState<ChannelDraft[]>([]);
  // 预置渠道删除后的墓碑：保存时随 pay_channels 落库，读时补齐据此不再把它们塞回来
  const [removedMethods, setRemovedMethods] = useState<string[]>([]);
  const [mods, setMods] = useState<DraftModule[]>([]);
  const [sf, setSf] = useState<DraftSecondFloor>({
    enabled: false, title: "", title_en: "", title_ja: "", title_ko: "", title_es: "", startAt: "", endAt: "", background_key: null,
    customTheme: false, theme: { primary: "#2ECC71", secondary: "#16A085", background: "#F6FAF7", text: "#1F2937", radius: "sm", font: "sans" },
    hintText: "", hintIconKey: null, ctaLabel: "", ctaLink: "", modules: [],
  });
  const [service, setService] = useState({
    auto_reply: "", auto_reply_en: "", auto_reply_ja: "", auto_reply_ko: "", auto_reply_es: "",
    working_hours: "", offline_notice: "", contact: "", guest_chat_open: true, guest_ip_limit: 20,
  });

  // —— M5 活动主题/皮肤（TH1–TH4，落 site_config，无迁移）——
  const [themes, setThemes] = useState<ThemePreset[]>([]);
  const [activePtr, setActivePtr] = useState<{ preset_id: string; override: boolean }>({ preset_id: "default", override: false });
  const [effective, setEffective] = useState<CampaignView | null>(null);
  const [editing, setEditing] = useState<DraftPreset | null>(null);
  const [themeError, setThemeError] = useState("");
  const [themeNotice, setThemeNotice] = useState("");
  const canDecor = has("site.decorate");

  // —— D1 配置历史（#277/#278）：current_version 作装修保存的 CAS 基线，历史行可一键回滚 ——
  const [configVersion, setConfigVersion] = useState(0);
  const [history, setHistory] = useState<ConfigHistoryItem[]>([]);
  const [historyError, setHistoryError] = useState("");

  const loadHistory = async () => {
    try {
      const r = await call<{ items: ConfigHistoryItem[]; current_version: number }>("admin/config/history", { token: "admin", query: { limit: 20 } });
      setHistory(r.items);
      setConfigVersion(r.current_version);
      setHistoryError("");
    } catch (e) {
      setHistoryError(errText(e));
    }
  };

  const loadThemes = async () => {
    try {
      const r = await call<ThemesResp>("admin/themes", { token: "admin" });
      setThemes(r.items);
      setActivePtr(r.active_theme);
      setEffective(r.effective);
    } catch (e) {
      setThemeError(errText(e));
    }
  };
  useEffect(() => {
    if (canDecor) { void loadThemes(); void loadHistory(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDecor]);

  const patchEditing = (next: Partial<DraftPreset>) => setEditing((d) => (d ? { ...d, ...next } : d));

  async function savePreset() {
    if (!editing) return;
    if (!editing.name.trim()) { setThemeError("请填写活动名称"); return; }
    setThemeError("");
    setThemeNotice("");
    await riskyPost("admin/theme/save", { preset: presetPayload(editing) }, editing.id ? `保存活动皮肤：${editing.name}` : "新建活动皮肤")
      .then(async () => {
        setThemeNotice("活动皮肤已保存");
        setEditing(null);
        await loadThemes();
        await refresh();
      })
      .catch((e) => { if (!isConfirmCancel(e)) setThemeError(errText(e)); });
  }

  async function applyPreset(id: string, name: string) {
    setThemeError("");
    setThemeNotice("");
    await riskyPost("admin/theme/apply", { preset_id: id }, `设为当前生效皮肤：${name}`)
      .then(async () => { setThemeNotice(`已切换到「${name}」`); await loadThemes(); await refresh(); })
      .catch((e) => { if (!isConfirmCancel(e)) setThemeError(errText(e)); });
  }

  async function cancelOverride() {
    setThemeError("");
    setThemeNotice("");
    await riskyPost("admin/theme/apply", { preset_id: "default" }, "取消手动覆盖，回到排期/默认皮肤")
      .then(async () => { setThemeNotice("已取消手动覆盖"); await loadThemes(); await refresh(); })
      .catch((e) => { if (!isConfirmCancel(e)) setThemeError(errText(e)); });
  }

  async function deletePreset(id: string, name: string) {
    setThemeError("");
    setThemeNotice("");
    await riskyPost("admin/theme/delete", { preset_id: id }, `删除活动皮肤：${name}`)
      .then(async () => { setThemeNotice("已删除"); if (editing?.id === id) setEditing(null); await loadThemes(); await refresh(); })
      .catch((e) => { if (!isConfirmCancel(e)) setThemeError(errText(e)); });
  }

  useEffect(() => {
    if (!config) return;
    setBrand({ ...config.brand });
    setTheme({ ...config.theme });
    setSwitches({
      register_open: config.switches.register_open,
      order_open: config.switches.order_open,
      maintenance: config.switches.maintenance,
      vip_coupon_stack: config.switches.vip_coupon_stack !== false,
      invite_reward_trigger: config.switches.invite_reward_trigger === "first_order" ? "first_order" : "register",
      coins: config.switches.coins === true,
      installment: (config.switches as { installment?: boolean }).installment === true,
    });
    setWd({
      enabled: config.withdraw?.enabled === true,
      minYuan: String((config.withdraw?.min_amount_base ?? 1) / 100),
      maxYuan: String((config.withdraw?.max_amount_base ?? 999999999999) / 100),
      daily: String(config.withdraw?.daily_limit ?? 1),
    });
    setDefaultLang(config.default_lang ?? "zh");
    setNav(config.nav.map((k) => ({ label: k.label, label_en: k.label_i18n?.en ?? "", label_ja: k.label_i18n?.ja ?? "", label_ko: k.label_i18n?.ko ?? "", label_es: k.label_i18n?.es ?? "", target: k.target, visible: k.visible })));
    setPayTimeout(Number.isSafeInteger(config.pay_channels.payment_timeout_hours) ? config.pay_channels.payment_timeout_hours : 48);
    setRemovedMethods(Array.isArray(config.pay_channels.removed_methods) ? [...config.pay_channels.removed_methods] : []);
    setChannels(Object.entries(config.pay_channels)
      .filter(([key, value]) => !NON_METHOD_KEYS.includes(key) && value && typeof value === "object" && !Array.isArray(value))
      .map(([method, value]) => {
        const c = value as PayChannelConfig;
        return {
          method,
          display_name: c.display_name ?? "",
          fulfillment: c.fulfillment === "online" ? "online" as const : "manual" as const,
          enabled: c.enabled === true,
          holder_name: c.holder_name ?? "",
          account_no: c.account_no ?? "",
          pay_link: c.pay_link ?? "",
          account_note: c.account_note ?? "",
          account_note_en: c.account_note_i18n?.en ?? "",
          account_note_ja: c.account_note_i18n?.ja ?? "",
          account_note_ko: c.account_note_i18n?.ko ?? "",
          account_note_es: c.account_note_i18n?.es ?? "",
          image_key: c.image_key ?? null,
          provider: c.provider ?? "custom",
          chains: (c.chains ?? []).map((x) => ({
            symbol: x.symbol ?? "", network: x.network ?? "", address: x.address ?? "", note: x.note ?? "",
            note_en: x.note_i18n?.en ?? "", note_ja: x.note_i18n?.ja ?? "", note_ko: x.note_i18n?.ko ?? "", note_es: x.note_i18n?.es ?? "",
            // 汇率库里存本位币「分」，录入框按「元」显示；0 显示为空 = 店主未设该币汇率
            rate: x.rate_base_per_coin ? String(Number(x.rate_base_per_coin) / 100) : "",
            decimals: String(x.decimals ?? 2),
            image_key: x.image_key ?? null,
          })),
        };
      }));
    setService({
      auto_reply: config.service?.auto_reply ?? "",
      auto_reply_en: config.service?.auto_reply_i18n?.en ?? "",
      auto_reply_ja: config.service?.auto_reply_i18n?.ja ?? "",
      auto_reply_ko: config.service?.auto_reply_i18n?.ko ?? "",
      auto_reply_es: config.service?.auto_reply_i18n?.es ?? "",
      working_hours: config.service?.working_hours ?? "",
      offline_notice: config.service?.offline_notice ?? "",
      contact: config.service?.contact ?? "",
      // 客服配置是整键替换保存，缺省值必须与函数侧 config.mjs 的 service 默认一致，否则保存一次就把访客咨询打开/关错
      guest_chat_open: config.service?.guest_chat_open ?? true,
      guest_ip_limit: config.service?.guest_ip_limit ?? 20,
    });
    setMods(modsFrom(config.home_modules, (i) => i < 4));
    const src = config.second_floor;
    setSf({
      enabled: src?.enabled ?? false,
      title: src?.title ?? "",
      title_en: src?.title_i18n?.en ?? "",
      title_ja: src?.title_i18n?.ja ?? "",
      title_ko: src?.title_i18n?.ko ?? "",
      title_es: src?.title_i18n?.es ?? "",
      startAt: localOf(src?.start_at ?? null),
      endAt: localOf(src?.end_at ?? null),
      background_key: src?.background_key ?? null,
      customTheme: !!src?.theme,
      theme: src?.theme ? ({ ...src.theme } as unknown as DraftTheme) : { primary: "#2ECC71", secondary: "#16A085", background: "#F6FAF7", text: "#1F2937", radius: "sm", font: "sans" },
      hintText: src?.trigger_hint?.text ?? "",
      hintIconKey: src?.trigger_hint?.icon_key ?? null,
      ctaLabel: src?.cta?.label ?? "",
      ctaLink: src?.cta?.link ?? "",
      modules: modsFrom(src?.modules, () => false),
    });
  }, [config]);

  const patchSf = (next: Partial<DraftSecondFloor>) => setSf((d) => ({ ...d, ...next }));

  // 删除渠道：非自建项（默认预置）删掉后必须写墓碑，否则读时补齐会立刻把它补回来
  function deleteChannel(i: number) {
    const method = channels[i]?.method.trim().toUpperCase();
    if (method) setRemovedMethods((rs) => (rs.includes(method) ? rs : [...rs, method]));
    setChannels((cs) => cs.filter((_, j) => j !== i));
  }

  // 恢复被误删的默认渠道：撤销墓碑即可，补齐后条目按默认值重新出现
  function restoreChannel(method: string) {
    setRemovedMethods((rs) => rs.filter((m) => m !== method));
  }

  // 渠道草稿数组 → 后端 pay_channels 注册表对象（payment_timeout_hours 全局键 + removed_methods 墓碑 + 各 method 条目；manual 带收款码/说明，online 带 provider）
  function buildPayChannels(): Record<string, unknown> {
    const live = channels.map((c) => c.method.trim().toUpperCase()).filter(Boolean);
    // 墓碑只保留「当前草稿里没有」的码：重新录入同名渠道即撤销删除
    const out: Record<string, unknown> = {
      payment_timeout_hours: payTimeout,
      removed_methods: removedMethods.filter((m) => !live.includes(m)),
    };
    for (const c of channels) {
      const method = c.method.trim().toUpperCase();
      if (!method) continue;
      const entry: Record<string, unknown> = { enabled: c.enabled, fulfillment: c.fulfillment, display_name: c.display_name.trim() || method };
      if (c.fulfillment === "manual") {
        entry.image_key = c.image_key;
        entry.holder_name = c.holder_name;
        entry.account_no = c.account_no;
        entry.pay_link = c.pay_link;
        entry.account_note = c.account_note;
        entry.account_note_i18n = textI18n(c.account_note_en, c.account_note_ja, c.account_note_ko, c.account_note_es);
        // 仅保留填了收款地址的行；symbol 必填由后端校验，这里过滤空地址避免脏数据
        entry.chains = c.chains
          .filter((x) => x.address.trim() && x.symbol.trim())
          .map((x) => ({
            symbol: x.symbol.trim(), network: x.network.trim(), address: x.address.trim(),
            note: x.note.trim(), note_i18n: textI18n(x.note_en, x.note_ja, x.note_ko, x.note_es),
            // 文档L：汇率按「元」录入、落库为本位币「分」；留空或填 0 = 未设汇率 ⇒ 购物端该币种置灰
            rate_base_per_coin: yuanToCents(x.rate) ?? 0,
            decimals: Math.max(1, Math.min(8, Math.trunc(Number(x.decimals)) || 2)),
            image_key: x.image_key,
          }));
      } else { entry.provider = c.provider || "custom"; }
      out[method] = entry;
    }
    return out;
  }

  /** 客服配置整键替换保存：四语译文合成一个 map，auto_reply 仍是给中文访客的原文 */
  function buildService(): Record<string, unknown> {
    return {
      auto_reply: service.auto_reply,
      auto_reply_i18n: textI18n(service.auto_reply_en, service.auto_reply_ja, service.auto_reply_ko, service.auto_reply_es),
      working_hours: service.working_hours,
      offline_notice: service.offline_notice,
      contact: service.contact,
      guest_chat_open: service.guest_chat_open,
      guest_ip_limit: service.guest_ip_limit,
    };
  }

  async function save(section: string, key: string, payload: unknown, action: string) {
    if (!has(action)) { setError(`缺少权限点 ${action}`); return; }
    setError("");
    setNotice("");
    // 带 expected_config_version 做乐观锁：别人先保存过就 409，避免多管理员互相整片覆盖（configVersion=0 表示历史未载入，退回不做 CAS）
    const cas = configVersion > 0 ? { expected_config_version: configVersion } : {};
    await riskyPost<{ removed_images?: string[] }>("admin/decor/save", { config: { [key]: payload }, ...cas }, `保存装修配置：${section}`)
      .then(async (res) => {
        // 收款码换图后旧对象会被当场删掉，这里把删除数量说出来，免得他以为旧码还留着
        const n = res?.removed_images?.length ?? 0;
        setNotice(`${section} 已保存并立即生效${n ? `，旧收款码图已删除 ${n} 张` : ""}`);
        await Promise.all([refresh(), loadHistory()]);
      })
      .catch(async (e) => {
        if (isConfirmCancel(e)) return;
        if (e instanceof ApiError && e.code === "config_version_conflict") {
          setError("配置已被其他管理员更新，已为你载入最新版本，请核对后重新保存。");
          await Promise.all([refresh(), loadHistory()]);
          return;
        }
        setError(errText(e));
      });
  }

  async function rollback(version: number) {
    setHistoryError("");
    await riskyPost("admin/config/rollback", { version }, `回滚配置到 v${version}（将覆盖当前全部装修配置）`)
      .then(async () => {
        setNotice(`已回滚到 v${version}，并作为新版本保存，前台立即生效。`);
        await Promise.all([refresh(), loadHistory()]);
      })
      .catch((e) => { if (!isConfirmCancel(e)) setHistoryError(errText(e)); });
  }

  if (!config) return <p className="text-sm text-muted-foreground">站点配置加载中（本地预览时后端不可用，发布后可在此编辑）…</p>;

  const unit = baseUnit();
  // CEX 支付拆到下方独立设置栏编辑；草稿里没有了（被删）时 -1，通用列表照旧渲染全部渠道
  const cryptoIdx = channels.findIndex((c) => c.method.trim().toUpperCase() === CRYPTO_METHOD);

  const patchChannel = (i: number, patch: Record<string, unknown>) =>
    setChannels((cs) => cs.map((x, j) => (j === i ? ({ ...x, ...patch } as ChannelDraft) : x)));
  const patchChain = (i: number, k: number, patch: Record<string, unknown>) =>
    setChannels((cs) => cs.map((x, j) => (j === i ? { ...x, chains: x.chains.map((y, m) => (m === k ? { ...y, ...patch } as ChainRowDraft : y)) } : x)));

  /** 收款码选择器（渠道级与币种级共用）：同一 paycodes 前缀，换图后旧对象由后端当场删掉 */
  function paycodePicker(id: string, label: string, value: string | null, hint: string, onKey: (key: string) => void) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">{label}</Label>
        <label htmlFor={id} className="inline-flex h-9 w-max cursor-pointer items-center border bg-background px-2 text-sm hover:bg-accent">选择图片</label>
        {/* 裸 input type=file 的控件文案跟访客浏览器语言走，且自绘按钮在窄屏更好控宽 */}
        <input
          id={id} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void run(async () => {
              try { onKey(await uploadImage(file, "paycodes")); setError(""); } catch (err) { setError(errText(err)); }
            });
          }}
        />
        <span className="max-w-56 truncate text-xs text-muted-foreground">{value ?? hint}</span>
      </div>
    );
  }

  // 币种地址子表（文档L 六列）：通用渠道列表与「CEX 支付」独立栏共用，两处字段口径必须完全一致
  function chainEditor(c: ChannelDraft, i: number) {
    return (
      <div className="flex flex-col gap-2 border-t pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">加密货币 / 多币种收款地址</span>
          <span className="text-xs text-muted-foreground">顾客在收款页按币种切换：应付金额、收款地址、收款码三处同步跟随，≤8 条</span>
        </div>
        {!c.chains.length && <p className="text-xs text-muted-foreground">尚未添加币种，顾客只看到上方的渠道级收款信息。</p>}
        {c.chains.map((ch, k) => (
          <div key={k} className="flex min-w-0 flex-col gap-2 border-l pl-3">
            <div className="grid grid-cols-2 items-start gap-2 xl:grid-cols-4">
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor={`ch-symbol-${i}-${k}`} className="text-xs font-normal text-muted-foreground">币种符号（必填）</Label>
                <Input id={`ch-symbol-${i}-${k}`} className="h-9 min-w-0" placeholder="USDT" maxLength={12} value={ch.symbol}
                  onChange={(e) => patchChain(i, k, { symbol: e.target.value })} />
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor={`ch-network-${i}-${k}`} className="text-xs font-normal text-muted-foreground">网络 / 链（选填）</Label>
                <Input id={`ch-network-${i}-${k}`} className="h-9 min-w-0" placeholder="TRC20" maxLength={24} value={ch.network}
                  onChange={(e) => patchChain(i, k, { network: e.target.value })} />
              </div>
              <div className="col-span-2 flex min-w-0 flex-col gap-1">
                <Label htmlFor={`ch-address-${i}-${k}`} className="text-xs font-normal text-muted-foreground">收款地址（必填）</Label>
                <Input id={`ch-address-${i}-${k}`} className="h-9 min-w-0" placeholder="TQn9… 或 0x8f3C…" maxLength={160} value={ch.address}
                  onChange={(e) => patchChain(i, k, { address: e.target.value })} />
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor={`ch-rate-${i}-${k}`} className="text-xs font-normal text-muted-foreground">1 {ch.symbol || "币"} = ？ {unit}</Label>
                <Input id={`ch-rate-${i}-${k}`} className="h-9 min-w-0" type="number" min={0} step="0.000001" inputMode="decimal"
                  placeholder="留空 = 未设汇率" value={ch.rate} onChange={(e) => patchChain(i, k, { rate: e.target.value })} />
                <p className="text-xs text-muted-foreground">未填汇率的币种，顾客端会置灰且选不了（防止拿 {unit} 数字去转币）。</p>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor={`ch-decimals-${i}-${k}`} className="text-xs font-normal text-muted-foreground">小数位（1–8）</Label>
                <Input id={`ch-decimals-${i}-${k}`} className="h-9 min-w-0" type="number" min={1} max={8} step={1} inputMode="numeric"
                  placeholder="2" value={ch.decimals} onChange={(e) => patchChain(i, k, { decimals: e.target.value })} />
                <p className="text-xs text-muted-foreground">USDT／USDC 常用 6，BTC／ETH 常用 8。</p>
              </div>
              {paycodePicker(`ch-img-${i}-${k}`, "该币收款码（选填）", ch.image_key, "留空 = 用上方渠道级收款码", (key) => patchChain(i, k, { image_key: key }))}
              <div className="col-span-2 flex min-w-0 items-end gap-2 xl:col-span-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Label htmlFor={`ch-note-${i}-${k}`} className="text-xs font-normal text-muted-foreground">该币种备注（选填，顾客可见）</Label>
                  <Input id={`ch-note-${i}-${k}`} className="h-9 min-w-0" maxLength={120} value={ch.note}
                    onChange={(e) => patchChain(i, k, { note: e.target.value })} />
                </div>
                <Button size="sm" variant="ghost" className="shrink-0 text-destructive"
                  onClick={() => setChannels((cs) => cs.map((x, j) => (j === i ? { ...x, chains: x.chains.filter((_, m) => m !== k) } : x)))}>删除币种</Button>
              </div>
            </div>
            <NoteI18nFields
              idPrefix={`chain-note-${i}-${k}`}
              field="币种备注"
              max={120}
              values={{ en: ch.note_en, ja: ch.note_ja, ko: ch.note_ko, es: ch.note_es }}
              onChange={(lang, text) => patchChain(i, k, { [`note_${lang}`]: text })}
            />
          </div>
        ))}
        {c.chains.length < 8 && (
          <Button size="sm" variant="outline" className="w-max"
            onClick={() => setChannels((cs) => cs.map((x, j) => (j === i ? { ...x, chains: [...x.chains, { ...CHAIN_BLANK }] } : x)))}>新增币种</Button>
        )}
      </div>
    );
  }

  // 人工收款渠道的收款信息（户名/账号/链接/渠道级收款码/收款说明四语 + 币种子表），两处渲染共用
  function manualBody(c: ChannelDraft, i: number) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <Input className="h-9 max-w-40" placeholder="收款户名（选填）" value={c.holder_name}
            onChange={(e) => patchChannel(i, { holder_name: e.target.value })} />
          <Input className="h-9 max-w-52" placeholder="收款账号 / 邮箱 / 收款ID" value={c.account_no}
            onChange={(e) => patchChannel(i, { account_no: e.target.value })} />
          <Input className="h-9 max-w-52" placeholder="收款链接（选填）" value={c.pay_link}
            onChange={(e) => patchChannel(i, { pay_link: e.target.value })} />
          {paycodePicker(`chan-img-${i}`, "渠道级收款码", c.image_key, "未上传收款码", (key) => patchChannel(i, { image_key: key }))}
        </div>
        <textarea
          className="min-h-16 w-full border bg-background px-2 py-1 text-sm"
          placeholder="付款备注 / 须知（多行，顾客在收款页可见）"
          maxLength={300}
          value={c.account_note}
          onChange={(e) => patchChannel(i, { account_note: e.target.value })}
        />
        <NoteI18nFields
          idPrefix={`acct-note-${i}`}
          field="收款说明"
          max={300}
          multiline
          values={{ en: c.account_note_en, ja: c.account_note_ja, ko: c.account_note_ko, es: c.account_note_es }}
          onChange={(lang, text) => patchChannel(i, { [`account_note_${lang}`]: text })}
        />
        {chainEditor(c, i)}
      </div>
    );
  }

  // 需求④：CEX 支付（加密货币）专设一栏——汇率与每币收款码在这里录入，保存仍走整键 pay_channels
  function cryptoCard() {
    if (cryptoIdx < 0) return null;
    const cc = channels[cryptoIdx];
    return (
      <Card>
        <CardHeader><CardTitle>CEX 支付（加密货币）</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-xs text-muted-foreground">
            本渠道收 USDT 等虚拟货币。顾客在付款页选中「CEX 支付」后，应付金额按他所选的币种显示（例如 12.50 USDT），收款地址与该币种的收款码同步切换；选其他收款方式时仍按账户币种（{unit}）显示。
            每个币种都要填「1 币 = 多少 {unit}」的参考汇率（后台手填，不接行情），没填的币种顾客端会置灰、选不了。换算按币种小数位向上取整，保证到账不少于应付。
          </p>
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <span className="font-mono text-sm">{cc.method}</span>
            <Input
              className="h-9 w-40" placeholder="展示名 如 CEX支付" aria-label="CEX 支付展示名"
              value={cc.display_name}
              onChange={(e) => patchChannel(cryptoIdx, { display_name: e.target.value })}
            />
            <label className="flex items-center gap-1">
              显示
              <Switch checked={cc.enabled} onCheckedChange={(v) => patchChannel(cryptoIdx, { enabled: v })} />
            </label>
            <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => deleteChannel(cryptoIdx)}>删除本渠道</Button>
          </div>
          {manualBody(cc, cryptoIdx)}
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button disabled={busy} onClick={() => void save("CEX 支付", "pay_channels", buildPayChannels(), "site.pay_config")}>保存 CEX 支付设置</Button>
            <span className="text-xs text-muted-foreground">与上方「保存收款配置」写同一份渠道配置，任一处保存都会整份生效。</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="站点装修" desc="保存即生效：前台通过 60 秒心跳轮询同步（本页保存后立即可见）。" />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && <p className="text-sm text-primary">{notice}</p>}

      <Card>
        <CardHeader><CardTitle>品牌</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="dc-name">站点名称</Label>
              <Input id="dc-name" value={brand.site_name} onChange={(e) => setBrand({ ...brand, site_name: e.target.value })} maxLength={60} className="max-w-64" />
            </div>
          </div>
          <BrandAssetRow
            label="站点 Logo"
            hint="建议 512×512 png/webp，用于顶栏、开屏动画与登录页"
            value={brand.logo_key}
            disabled={busy}
            canDelete={has("site.decorate")}
            onChange={(k) => setBrand((b) => ({ ...b, logo_key: k }))}
            onError={setError}
          />
          <BrandAssetRow
            label="Favicon"
            hint="建议 256×256，留空则复用站点 Logo"
            value={brand.favicon_key}
            disabled={busy}
            canDelete={has("site.decorate")}
            onChange={(k) => setBrand((b) => ({ ...b, favicon_key: k }))}
            onError={setError}
          />
          <BrandAssetRow
            label="首页背景"
            hint="节日氛围图，建议 1600×120 长条横图（png/webp/jpg）；铺在首页顶部 Logo／搜索栏这一行背后，留空则只保留动态商品图标"
            value={brand.hero_bg_key}
            disabled={busy}
            canDelete={has("site.decorate")}
            onChange={(k) => setBrand((b) => ({ ...b, hero_bg_key: k }))}
            onError={setError}
          />
          <div>
            <Button disabled={busy} onClick={() => void save("品牌", "brand", brand, "site.decorate")}>保存品牌</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>主题配色（CSS 变量注入）</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          {([["主色", "primary"], ["辅助色", "secondary"], ["背景", "background"], ["文字", "text"]] as const).map(([label, key]) => (
            <div key={key} className="flex flex-col gap-1">
              <Label htmlFor={`dc-${key}`}>{label}</Label>
              <div className="flex items-center gap-2">
                <input
                  id={`dc-${key}-pick`}
                  type="color"
                  aria-label={`${label}取色器`}
                  value={/^#[0-9a-fA-F]{6}$/.test(theme[key]) ? theme[key] : "#000000"}
                  onChange={(e) => setTheme({ ...theme, [key]: e.target.value.toUpperCase() })}
                  className="size-9 cursor-pointer rounded border bg-background"
                />
                <Input value={theme[key]} onChange={(e) => setTheme({ ...theme, [key]: e.target.value })} className="w-28 font-mono text-xs" />
              </div>
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <Label htmlFor="dc-radius">圆角</Label>
            <select id="dc-radius" className="h-9 rounded-md border bg-background px-2 text-sm" value={theme.radius} onChange={(e) => setTheme({ ...theme, radius: e.target.value })}>
              {([["sm", "sm · 直角（默认）"], ["md", "md · 小圆角"], ["lg", "lg · 中圆角"], ["xl", "xl · 大圆角"]] as const).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="dc-font">字体</Label>
            <select id="dc-font" className="h-9 rounded-md border bg-background px-2 text-sm" value={theme.font} onChange={(e) => setTheme({ ...theme, font: e.target.value })}>
              {["sans", "serif", "display"].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <Button disabled={busy} onClick={() => void save("主题", "theme", theme, "site.decorate")}>保存主题</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>开关</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex items-center gap-3 text-sm">开放注册 <Switch checked={switches.register_open} onCheckedChange={(v) => setSwitches({ ...switches, register_open: v })} /></label>
          <label className="flex items-center gap-3 text-sm">开放下单 <Switch checked={switches.order_open} onCheckedChange={(v) => setSwitches({ ...switches, order_open: v })} /></label>
          <label className="flex items-center gap-3 text-sm">维护模式 <Switch checked={switches.maintenance} onCheckedChange={(v) => setSwitches({ ...switches, maintenance: v })} /></label>
          <label className="flex items-center gap-3 text-sm">
            会员折扣与优惠券叠加
            <Switch checked={switches.vip_coupon_stack} onCheckedChange={(v) => setSwitches({ ...switches, vip_coupon_stack: v })} />
          </label>
          <p className="text-xs text-muted-foreground">
            关闭后，用券的订单不再叠加会员折扣（会员不选券时折扣照常）；结算页会提示让位原因。
          </p>
          <label className="flex flex-wrap items-center gap-3 text-sm">
            邀请奖励发放时机
            <select
              className="h-8 min-w-0 border bg-background px-2 text-sm"
              value={switches.invite_reward_trigger}
              onChange={(e) => setSwitches({ ...switches, invite_reward_trigger: e.target.value as "register" | "first_order" })}
            >
              <option value="register">注册即发放（默认）</option>
              <option value="first_order">首单支付后发放（防批量注册囤奖励）</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            选「首单支付后发放」时，被邀请人的 welcome 券与邀请人的注册奖励都推迟到该用户第一笔已支付订单，只影响之后的注册。
          </p>
          <label className="flex items-center gap-3 text-sm">
            金币商城
            <Switch checked={switches.coins} onCheckedChange={(v) => setSwitches({ ...switches, coins: v })} />
          </label>
          <p className="text-xs text-muted-foreground">
            开启后，前台才会出现「金币中心」入口（签到攒币、兑换专区）；关闭时隐藏入口，已发放的金币余额与兑换记录保留不动。规则与目录在「营销 · 金币商城」里配置。
          </p>
          <label className="flex items-center gap-3 text-sm">
            分期付款专区
            <Switch checked={switches.installment} onCheckedChange={(v) => setSwitches({ ...switches, installment: v })} />
          </label>
          <p className="text-xs text-muted-foreground">
            开启后，前台才会出现「分期专区」入口、海报入口，结算页才会让买家选期（首付 30% 到账即发货、尾款按月 0 息）；关闭时隐藏专区与选期，已在途的分期订单仍可正常逐期支付。单个商品是否可分期在「商品」里勾选。
          </p>
          <div className="flex flex-wrap items-center gap-4 border-t pt-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="w-28 shrink-0 font-medium">新用户默认语言</span>
              <select
                className="h-8 min-w-0 border bg-background px-2 text-sm"
                value={defaultLang}
                onChange={(e) => setDefaultLang(e.target.value)}
              >
                <option value="zh">简体中文</option>
                <option value="en">English</option>
                <option value="ja">日本語</option>
                <option value="ko">한국어</option>
                <option value="es">Español</option>
              </select>
            </label>
            <Button disabled={busy} variant="outline" onClick={() => void save("默认语言", "default_lang", defaultLang, "site.decorate")}>保存默认语言</Button>
          </div>
          <p className="text-xs text-muted-foreground">切换后新注册用户按此语言初始化界面;已注册用户的个人语言设置不受影响。</p>
          <div>
            <Button disabled={busy} onClick={() => void save("开关", "switches", switches, "site.decorate")}>保存开关</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>余额提现</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex items-center gap-3 text-sm">
            开放提现
            <Switch checked={wd.enabled} onCheckedChange={(v) => setWd({ ...wd, enabled: v })} />
          </label>
          <p className="text-xs text-muted-foreground">
            关闭时前台不显示「余额提现」入口；提现＝平台把钱付给用户，系统不自动打款，买家申请即扣余额建单，客服线下打款后在「交易 · 余额提现」里确认到账或驳回退余额。不收手续费。
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <span className="flex flex-col gap-1">
              <Label htmlFor="wd-min">最低提现额（{baseUnit()}）</Label>
              <Input id="wd-min" className="w-32" value={wd.minYuan} onChange={(e) => setWd({ ...wd, minYuan: e.target.value })} placeholder="1" />
            </span>
            <span className="flex flex-col gap-1">
              <Label htmlFor="wd-max">单笔上限（{baseUnit()}）</Label>
              <Input id="wd-max" className="w-40" value={wd.maxYuan} onChange={(e) => setWd({ ...wd, maxYuan: e.target.value })} placeholder="9999999999" />
            </span>
            <span className="flex flex-col gap-1">
              <Label htmlFor="wd-daily">每人每日最多</Label>
              <Input id="wd-daily" className="w-20" inputMode="numeric" value={wd.daily} onChange={(e) => setWd({ ...wd, daily: e.target.value })} placeholder="1" />
            </span>
            <Button disabled={busy} onClick={() => {
              const min = yuanToCents(wd.minYuan); const max = yuanToCents(wd.maxYuan);
              if (min === null || min < 1) { setError("最低提现额至少 1 分（0.01 元）"); return; }
              if (max === null || max < min) { setError("单笔上限不能低于最低提现额"); return; }
              const payload = { enabled: wd.enabled, min_amount_base: min, max_amount_base: max, daily_limit: Math.min(100, Math.max(1, Number(wd.daily) || 1)) };
              void save("余额提现", "withdraw", payload, "site.decorate");
            }}>保存提现设置</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            每日次数按滚动 24 小时计（同一用户当日已有提现单则拒绝新申请）；同人同时仅允许一笔待审核。金额按本位币记账，线下实际付哪种币由客服约定。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>导航（≤20 项）</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {nav.map((item, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              <Input value={item.label} placeholder="名称" onChange={(e) => setNav(nav.map((n, j) => (i === j ? { ...n, label: e.target.value } : n)))} className="w-28" />
              <Input value={item.label_en} placeholder="English" aria-label="英文导航名称" onChange={(e) => setNav(nav.map((n, j) => (i === j ? { ...n, label_en: e.target.value } : n)))} className="w-28" />
              <Input value={item.label_ja} placeholder="日本語" aria-label="日文导航名称" onChange={(e) => setNav(nav.map((n, j) => (i === j ? { ...n, label_ja: e.target.value } : n)))} className="w-28" />
              <Input value={item.label_ko} placeholder="한국어" aria-label="韩文导航名称" onChange={(e) => setNav(nav.map((n, j) => (i === j ? { ...n, label_ko: e.target.value } : n)))} className="w-28" />
              <Input value={item.label_es} placeholder="Español" aria-label="西语导航名称" onChange={(e) => setNav(nav.map((n, j) => (i === j ? { ...n, label_es: e.target.value } : n)))} className="w-28" />
              <Input value={item.target} placeholder="/path" onChange={(e) => setNav(nav.map((n, j) => (i === j ? { ...n, target: e.target.value } : n)))} className="w-36" />
              <label className="flex items-center gap-1">显示<Switch checked={item.visible} onCheckedChange={(v) => setNav(nav.map((n, j) => (i === j ? { ...n, visible: v } : n)))} /></label>
              <Button size="sm" variant="outline" onClick={() => setNav(nav.filter((_, j) => j !== i))}>删除</Button>
            </div>
          ))}
          {nav.length < 20 && (
            <div>
              <Button size="sm" variant="outline" onClick={() => setNav([...nav, { label: "新页面", label_en: "", label_ja: "", label_ko: "", label_es: "", target: "/", visible: true }])}>添加一项</Button>
            </div>
          )}
          <div>
            <Button disabled={busy} onClick={() => void save("导航", "nav", nav.map((n) => ({ label: n.label, label_i18n: navI18n(n), target: n.target, visible: n.visible })), "site.decorate")}>
              保存导航
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>首页模块（上下箭头即楼层顺序）</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ModulesEditor mods={mods} onChange={setMods} busy={busy} onError={setError} />
          <div>
            <Button disabled={busy} onClick={() => void save("首页模块", "home_modules", toHomeModulesPayload(mods), "site.decorate")}>
              保存首页模块
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>商城二楼（下拉活动会场）</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            活动期把首页做成「下拉进入会场」：仅当下方开关打开、且当前时间落在起止区间内，前台首页顶部才会浮现下拉手势与入口条，进入 /activity 展示这里的楼层与配色。区间外或关闭时，首页行为完全不变。楼层沿用首页模块编辑器，不含秒杀。
          </p>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2 font-medium">
              启用二楼
              <Switch checked={sf.enabled} onCheckedChange={(v) => patchSf({ enabled: v })} />
            </label>
          </div>

          <div className="flex flex-wrap items-end gap-3 text-sm">
            <div className="flex flex-col gap-1">
              <Label htmlFor="sf-title">会场标题</Label>
              <Input id="sf-title" value={sf.title} maxLength={60} placeholder="如 双十一狂欢会场" onChange={(e) => patchSf({ title: e.target.value })} className="w-56" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="sf-title-en">英文标题（可空）</Label>
              <Input id="sf-title-en" value={sf.title_en} maxLength={60} onChange={(e) => patchSf({ title_en: e.target.value })} className="w-56" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="sf-title-ja">日本語タイトル（空可）</Label>
              <Input id="sf-title-ja" value={sf.title_ja} maxLength={60} onChange={(e) => patchSf({ title_ja: e.target.value })} className="w-56" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="sf-title-ko">한국어 제목（선택）</Label>
              <Input id="sf-title-ko" value={sf.title_ko} maxLength={60} onChange={(e) => patchSf({ title_ko: e.target.value })} className="w-56" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="sf-title-es">Título en español (opcional)</Label>
              <Input id="sf-title-es" value={sf.title_es} maxLength={60} onChange={(e) => patchSf({ title_es: e.target.value })} className="w-56" />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3 text-sm">
            <div className="flex flex-col gap-1">
              <Label>生效开始（留空 = 立即/常驻，按 UTC）</Label>
              <input type="datetime-local" value={sf.startAt} onChange={(e) => patchSf({ startAt: e.target.value })} className="h-9 rounded-md border bg-background px-2 text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              <Label>生效结束（留空 = 不自动结束，按 UTC）</Label>
              <input type="datetime-local" value={sf.endAt} onChange={(e) => patchSf({ endAt: e.target.value })} className="h-9 rounded-md border bg-background px-2 text-sm" />
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-border/70 pt-3">
            <BrandAssetRow
              label="会场背景"
              hint="铺在会场顶部 Banner 区背后的活动底色图，建议 1600×900；留空则回落品牌渐变"
              value={sf.background_key}
              disabled={busy}
              canDelete={false}
              onChange={(k) => patchSf({ background_key: k })}
              onError={setError}
            />
          </div>

          <div className="flex flex-col gap-3 border-t border-border/70 pt-3">
            <label className="flex items-center gap-2 text-sm">
              独立配色
              <Switch checked={sf.customTheme} onCheckedChange={(v) => patchSf({ customTheme: v })} />
              <span className="text-xs text-muted-foreground">关闭时会场沿用当前生效皮肤；开启后可单独配色</span>
            </label>
            {sf.customTheme && (
              <div className="flex flex-wrap items-end gap-4">
                {([["主色", "primary"], ["辅助色", "secondary"], ["背景", "background"], ["文字", "text"]] as const).map(([label, key]) => (
                  <div key={key} className="flex flex-col gap-1">
                    <Label>{label}</Label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        aria-label={`${label}取色器`}
                        value={/^#[0-9a-fA-F]{6}$/.test(sf.theme[key]) ? sf.theme[key] : "#000000"}
                        onChange={(e) => patchSf({ theme: { ...sf.theme, [key]: e.target.value.toUpperCase() } })}
                        className="size-9 cursor-pointer rounded border bg-background"
                      />
                      <Input value={sf.theme[key]} onChange={(e) => patchSf({ theme: { ...sf.theme, [key]: e.target.value } })} className="w-24 font-mono text-xs" />
                    </div>
                  </div>
                ))}
                <div className="flex flex-col gap-1">
                  <Label>圆角</Label>
                  <select className="h-9 rounded-md border bg-background px-2 text-sm" value={sf.theme.radius} onChange={(e) => patchSf({ theme: { ...sf.theme, radius: e.target.value } })}>
                    {([["sm", "sm · 直角"], ["md", "md · 小圆角"], ["lg", "lg · 中圆角"], ["xl", "xl · 大圆角"]] as const).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label>字体</Label>
                  <select className="h-9 rounded-md border bg-background px-2 text-sm" value={sf.theme.font} onChange={(e) => patchSf({ theme: { ...sf.theme, font: e.target.value } })}>
                    {["sans", "serif", "display"].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 border-t border-border/70 pt-3">
            <p className="text-xs text-muted-foreground">下拉提示：顶部随手势浮现的文字（≤30 字），可选一枚小图标；入口条与手势共用。</p>
            <div className="flex flex-wrap items-end gap-3 text-sm">
              <div className="flex flex-col gap-1">
                <Label htmlFor="sf-hint">提示文案</Label>
                <Input id="sf-hint" value={sf.hintText} maxLength={30} placeholder="下拉进入活动会场" onChange={(e) => patchSf({ hintText: e.target.value })} className="w-64" />
              </div>
            </div>
            <BrandAssetRow
              label="提示图标"
              hint="下拉浮层左侧的小图标，建议 48×48；留空则只显示文字"
              value={sf.hintIconKey}
              disabled={busy}
              canDelete={false}
              onChange={(k) => patchSf({ hintIconKey: k })}
              onError={setError}
            />
            <div className="flex flex-wrap items-end gap-3 text-sm">
              <div className="flex flex-col gap-1">
                <Label htmlFor="sf-cta-label">底部按钮文案</Label>
                <Input id="sf-cta-label" value={sf.ctaLabel} maxLength={30} placeholder="立即抢购（可空则不显示按钮）" onChange={(e) => patchSf({ ctaLabel: e.target.value })} className="w-64" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="sf-cta-link">按钮跳转</Label>
                <Input id="sf-cta-link" value={sf.ctaLink} maxLength={200} placeholder="/category 或 /product?id=…" onChange={(e) => patchSf({ ctaLink: e.target.value })} className="w-64" />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-border/70 pt-3">
            <p className="text-sm font-medium">会场楼层（复用首页模块编辑器；开关决定该模块是否在会场出现）</p>
            <ModulesEditor mods={sf.modules} onChange={(m) => patchSf({ modules: m })} busy={busy} onError={setError} />
          </div>

          <div>
            <Button disabled={busy} onClick={() => void save("商城二楼", "second_floor", buildSfPayload(sf), "site.decorate")}>保存二楼</Button>
          </div>
        </CardContent>
      </Card>

      {canDecor && (
        <Card>
          <CardHeader><CardTitle>活动主题 / 皮肤（换肤 + 海报）</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-xs text-muted-foreground">
              为节日/活动做一整套「皮肤」：配色 + 首页楼层快照 + 开屏/每日弹窗/顶部氛围/整页背景海报。可排期自动生效，或一键手动切换。皮肤只影响购物端展示，不改动后台默认装修。
            </p>
            {themeError && <p className="text-sm text-destructive">{themeError}</p>}
            {themeNotice && <p className="text-sm text-primary">{themeNotice}</p>}

            {(() => {
              const modeLabel = { manual: "手动指定", scheduled: "排期自动", default: "默认皮肤" }[effective?.mode ?? "default"];
              const activeName = effective?.active_theme_id
                ? (themes.find((t) => t.id === effective.active_theme_id)?.name ?? "（预设已删除）")
                : "默认皮肤";
              return (
                <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3 text-sm">
                  <span className="font-medium">当前生效：</span>
                  <span className="bg-primary px-1.5 py-0.5 text-xs text-white">{modeLabel}</span>
                  <span>{activeName}</span>
                  {activePtr.override && (
                    <Button size="sm" variant="outline" onClick={() => void cancelOverride()}>取消手动覆盖</Button>
                  )}
                  <Button size="sm" className="ml-auto" onClick={() => { setThemeError(""); setEditing(blankPreset(theme, mods)); }}>＋ 新建活动皮肤</Button>
                </div>
              );
            })()}

            {themes.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有活动皮肤：点「＋ 新建活动皮肤」，先抓一份当前首页模块做楼层快照，再调配色和海报。</p>
            ) : (
              <div className="flex flex-col divide-y divide-border/70">
                {themes.map((p) => {
                  const st = STATUS_META[p.status ?? "standby"];
                  const isManual = activePtr.override && activePtr.preset_id === p.id;
                  const range = p.start_at || p.end_at
                    ? `${p.start_at ? p.start_at.replace("T", " ") : "起"} ~ ${p.end_at ? p.end_at.replace("T", " ") : "止"}`
                    : "常驻";
                  return (
                    <div key={p.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                      <span className="w-36 shrink-0 truncate font-medium" title={p.name}>{p.name}</span>
                      <span className={`px-1.5 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                      <span className="text-xs text-muted-foreground">{p.enabled ? "已启用" : "已停用"} · {range}</span>
                      <div className="ml-auto flex gap-1">
                        <Button size="sm" variant="outline" onClick={() => { setThemeError(""); setEditing(presetToDraft(p)); }}>编辑</Button>
                        {!isManual && <Button size="sm" onClick={() => void applyPreset(p.id, p.name)}>应用</Button>}
                        <Button size="sm" variant="outline" onClick={() => void deletePreset(p.id, p.name)}>删除</Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {editing && (
              <div className="flex flex-col gap-4 border-t-2 border-primary/40 pt-3">
                <p className="font-medium">{editing.id ? `编辑：${editing.name || "（未命名）"}` : "新建活动皮肤"}</p>

                <div className="flex flex-wrap items-end gap-4">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="tp-name">活动名称</Label>
                    <Input id="tp-name" value={editing.name} maxLength={30} placeholder="如 双十一狂欢" onChange={(e) => patchEditing({ name: e.target.value })} className="w-52" />
                  </div>
                  <label className="flex items-center gap-2 pb-1 text-sm">启用皮肤<Switch checked={editing.enabled} onCheckedChange={(v) => patchEditing({ enabled: v })} /></label>
                </div>

                <div className="flex flex-wrap items-end gap-4">
                  {([["主色", "primary"], ["辅助色", "secondary"], ["背景", "background"], ["文字", "text"]] as const).map(([label, key]) => (
                    <div key={key} className="flex flex-col gap-1">
                      <Label>{label}</Label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          aria-label={`${label}取色器`}
                          value={/^#[0-9a-fA-F]{6}$/.test(editing.theme[key]) ? editing.theme[key] : "#000000"}
                          onChange={(e) => patchEditing({ theme: { ...editing.theme, [key]: e.target.value.toUpperCase() } })}
                          className="size-9 cursor-pointer rounded border bg-background"
                        />
                        <Input value={editing.theme[key]} onChange={(e) => patchEditing({ theme: { ...editing.theme, [key]: e.target.value } })} className="w-24 font-mono text-xs" />
                      </div>
                    </div>
                  ))}
                  <div className="flex flex-col gap-1">
                    <Label>圆角</Label>
                    <select className="h-9 rounded-md border bg-background px-2 text-sm" value={editing.theme.radius} onChange={(e) => patchEditing({ theme: { ...editing.theme, radius: e.target.value } })}>
                      {([["sm", "sm · 直角"], ["md", "md · 小圆角"], ["lg", "lg · 中圆角"], ["xl", "xl · 大圆角"]] as const).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>字体</Label>
                    <select className="h-9 rounded-md border bg-background px-2 text-sm" value={editing.theme.font} onChange={(e) => patchEditing({ theme: { ...editing.theme, font: e.target.value } })}>
                      {["sans", "serif", "display"].map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">首页楼层快照</span>
                  <Button size="sm" variant="outline" onClick={() => patchEditing({ home: snapshotMods(mods) })}>抓取当前首页模块</Button>
                  <span className="text-xs text-muted-foreground">
                    {editing.home.filter((m) => m.enabled).length} 个启用楼层 · {editing.home.reduce((n, m) => n + m.items.length, 0)} 条海报（含条目级开关）
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  <PosterBlock
                    title="开屏海报" note="关闭则进入站点不弹开屏；开启后整屏显示该图"
                    poster={editing.splash} busy={busy}
                    hint="建议 9:16 竖图（750×1334 或 1024×1792），整屏裁切显示，四周留安全边距"
                    onChange={(next) => patchEditing({ splash: next })} onError={setThemeError}
                  />
                  <PosterBlock
                    title="每日弹窗海报" note="关闭则首页不弹；开启后每人每天最多弹一次"
                    poster={editing.popup} busy={busy}
                    hint="建议 3:4（600×800 或 768×1024），居中弹窗等比完整显示不裁切"
                    onChange={(next) => patchEditing({ popup: next })} onError={setThemeError}
                  />
                  <div className="border-t border-border/70 pt-2">
                    <BrandAssetRow
                      label="顶部氛围"
                      hint="首页顶部一行背后的长条氛围图，建议 1600×120；留空回落品牌默认"
                      value={editing.hero_bg_key} disabled={busy} canDelete={false}
                      onChange={(k) => patchEditing({ hero_bg_key: k })} onError={setThemeError}
                    />
                    <BrandAssetRow
                      label="整页背景"
                      hint="铺在页面内容背后的活动底色图；留空则无整页背景"
                      value={editing.page_bg_key} disabled={busy} canDelete={false}
                      onChange={(k) => patchEditing({ page_bg_key: k })} onError={setThemeError}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-end gap-3 text-sm">
                  <div className="flex flex-col gap-1">
                    <Label>开始时间（留空 = 常驻）</Label>
                    <input type="datetime-local" value={editing.startAt} onChange={(e) => patchEditing({ startAt: e.target.value })} className="h-9 rounded-md border bg-background px-2 text-sm" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>结束时间（留空 = 不自动结束）</Label>
                    <input type="datetime-local" value={editing.endAt} onChange={(e) => patchEditing({ endAt: e.target.value })} className="h-9 rounded-md border bg-background px-2 text-sm" />
                  </div>
                  <p className="max-w-60 text-xs text-muted-foreground">排期到点自动生效/失效（读时判定，无需任务）；手动「应用」会临时覆盖排期。</p>
                </div>

                <div className="flex gap-2">
                  <Button disabled={busy} onClick={() => void savePreset()}>保存活动皮肤</Button>
                  <Button variant="outline" onClick={() => setEditing(null)}>取消</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>收款渠道</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            出厂默认展示四项收款方式：微信转账 / 支付宝转账 / PayPal / CEX 支付（加密货币）。「显示」开关直接决定购物端付款时能否看到该渠道；关闭只是隐藏，配置与收款码保留。可增删渠道，到账方式分「人工收款码」（上传收款码、后台审核凭证）与「线上回调」（远程支付自动到账；本期仅占位、收款未开放）。余额支付为站内即时，不在此配置。
            <b>CEX 支付（加密货币）不在这里编辑，见下方独立设置栏。</b>
          </p>
          <label className="flex items-center gap-2 text-sm">
            <span className="w-40 text-muted-foreground">扫码支付超时（小时，1–720）</span>
            <Input
              type="number" min={1} max={720} className="h-9 w-24"
              value={String(payTimeout)}
              onChange={(e) => setPayTimeout(Math.max(1, Math.min(720, Math.trunc(Number(e.target.value)) || 48)))}
            />
          </label>

          {!channels.length && <p className="text-sm text-muted-foreground">尚未配置任何收款渠道。</p>}
          {channels.map((c, i) => {
            // CEX 支付（加密货币）在下面独立设置栏编辑，这里跳过，免得同一渠道两处录入
            if (i === cryptoIdx) return null;
            return (
              <div key={i} className="flex flex-col gap-2 border-t pt-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="h-9 w-44 font-mono" placeholder="渠道代码 如 BANK_TRANSFER"
                    value={c.method}
                    onChange={(e) => patchChannel(i, { method: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 32) })}
                  />
                  <Input
                    className="h-9 w-40" placeholder="展示名 如 银行转账"
                    value={c.display_name}
                    onChange={(e) => patchChannel(i, { display_name: e.target.value })}
                  />
                  <select
                    aria-label="到账方式"
                    className="h-9 border bg-background px-2 text-sm"
                    value={c.fulfillment}
                    onChange={(e) => patchChannel(i, { fulfillment: e.target.value as "manual" | "online" })}
                  >
                    <option value="manual">人工收款码</option>
                    <option value="online">线上回调</option>
                  </select>
                  <label className="flex items-center gap-1">
                    显示
                    <Switch checked={c.enabled} onCheckedChange={(v) => patchChannel(i, { enabled: v })} />
                  </label>
                  {c.fulfillment === "online" && <span className="text-xs text-muted-foreground">（收款未开放，购物端选择该渠道将提示「尚未开放」）</span>}
                  <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => deleteChannel(i)}>删除</Button>
                </div>
                {c.fulfillment === "manual" ? manualBody(c, i) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">线上支付服务商</span>
                    <select
                      aria-label="服务商"
                      className="h-9 border bg-background px-2 text-sm"
                      value={c.provider}
                      onChange={(e) => patchChannel(i, { provider: e.target.value })}
                    >
                      <option value="custom">自定义</option>
                      <option value="stripe">Stripe</option>
                      <option value="wechat_pay">微信支付</option>
                      <option value="alipay">支付宝</option>
                    </select>
                  </div>
                )}
              </div>
            );
          })}

          {!!removedMethods.length && (
            <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
              <span>已删除的渠道（默认项不会自动补回，保存后前台也不再显示；点「恢复」可还原为默认配置）：</span>
              {removedMethods.map((m) => (
                <span key={m} className="flex items-center gap-1 border px-1.5 py-0.5 font-mono">
                  {m}
                  <button type="button" className="text-primary hover:underline" onClick={() => restoreChannel(m)}>恢复</button>
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button
              size="sm" variant="outline"
              onClick={() => setChannels([...channels, { method: "", display_name: "", fulfillment: "manual", enabled: false, holder_name: "", account_no: "", pay_link: "", account_note: "", account_note_en: "", account_note_ja: "", account_note_ko: "", account_note_es: "", image_key: null, provider: "custom", chains: [] }])}
            >新增渠道</Button>
            <Button disabled={busy} onClick={() => void save("收款渠道", "pay_channels", buildPayChannels(), "site.pay_config")}>保存收款配置</Button>
          </div>
        </CardContent>
      </Card>

      {cryptoCard()}

      <Card>
        <CardHeader><CardTitle>客服服务时段与自动回复</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            购物端进入客服中心时按此时段判定是否在线（按 UTC 比较，与全站时间口径一致）；离线时落一条系统自动回复，客服接入后照常对话。自动回复按顾客界面语言发送，中文那句只发给中文访客。
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="svc-hours">服务时段（留空 = 全天候在线）</Label>
              <Input id="svc-hours" maxLength={100} placeholder="09:00-18:00" value={service.working_hours}
                onChange={(e) => setService((s) => ({ ...s, working_hours: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="svc-reply">离线自动回复（中文访客）</Label>
              <Input id="svc-reply" maxLength={1000} placeholder="客服暂时离线，留言后会尽快回复。" value={service.auto_reply}
                onChange={(e) => setService((s) => ({ ...s, auto_reply: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="svc-notice">离线说明（自动回复留空时使用）</Label>
              <Input id="svc-notice" maxLength={500} value={service.offline_notice}
                onChange={(e) => setService((s) => ({ ...s, offline_notice: e.target.value }))} />
            </div>
          </div>
          <NoteI18nFields
            idPrefix="svc-reply"
            field="自动回复"
            max={1000}
            blankHint="留空则用系统内置的该语种话术"
            values={{ en: service.auto_reply_en, ja: service.auto_reply_ja, ko: service.auto_reply_ko, es: service.auto_reply_es }}
            onChange={(lang, text) => setService((s) => ({ ...s, [`auto_reply_${lang}`]: text }))}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="svc-contact">公开客服联系方式（登录页「忘记密码」显示，无需登录即可见）</Label>
            <textarea
              id="svc-contact" className="min-h-16 w-full border bg-background px-2 py-1 text-sm" maxLength={500}
              placeholder="例如：客服邮箱 support@example.com&#10;微信 / QQ / 电话（顾客忘记密码时在此联系人工重置）"
              value={service.contact}
              onChange={(e) => setService((s) => ({ ...s, contact: e.target.value }))} />
            <p className="text-xs text-muted-foreground">留空则登录页仅提示「请联系客服」，不显示具体号码。</p>
          </div>
          <div className="flex flex-wrap items-center gap-4 border-t pt-3">
            <label className="flex items-center gap-3 text-sm">
              允许访客咨询（免注册联系客服）
              <Switch checked={service.guest_chat_open} onCheckedChange={(v) => setService((s) => ({ ...s, guest_chat_open: v }))} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              同一访客 IP 每小时可开会话数
              <Input
                type="number" min={1} max={1000} className="h-8 w-24"
                value={service.guest_ip_limit}
                onChange={(e) => setService((s) => ({ ...s, guest_ip_limit: Number(e.target.value) || 0 }))} />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            关闭后未登录顾客进入客服中心会被拒绝接入（已登录顾客不受影响）；后台客服队列里访客显示为「未注册」。次数上限用于挡住批量刷会话的匿名访客。
          </p>
          <div>
            <Button disabled={busy} onClick={() => void save("客服设置", "service", buildService(), "site.decorate")}>保存客服设置</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>配置历史 / 回滚</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            每次保存装修都会留存一份完整配置快照（当前版本 v{configVersion}）。若某次保存改坏了，可在此选择历史版本一键回滚——回滚会把该快照作为新版本追加，不会删除任何既有历史，前台立即生效。
          </p>
          {historyError && <p className="text-sm text-destructive">{historyError}</p>}
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无历史记录（尚未保存过装修配置）。</p>
          ) : (
            <div className="flex flex-col divide-y divide-border/70 border border-border/70">
              {history.map((h) => (
                <div key={h.version} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium">v{h.version}{h.version === configVersion ? "（当前）" : ""}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {new Date(h.created_at).toLocaleString()} · {h.note || "（无备注）"}
                    </span>
                  </div>
                  <Button
                    variant="outline" size="sm" disabled={busy || h.version === configVersion}
                    onClick={() => void rollback(h.version)}
                  >回滚到此版本</Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
