// 站点上下文：bootstrap 轮询（保存即生效）+ 主题注入 + 语言包
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, call, newIdem, tokenStore } from "./api";
import { announceCatalogChange } from "./catalog";
import { setBaseCurrency } from "./const";
import { MESSAGES, setTextResolver } from "./i18n";

export interface ThemeConfig {
  primary: string;
  secondary: string;
  background: string;
  text: string;
  radius: "sm" | "md" | "lg" | "xl";
  font: "sans" | "serif" | "display";
}
export interface NavItem { label: string; label_i18n?: Record<string, string> | null; target: string; visible: boolean }
export interface HomeModuleItem { title: string | null; image_key: string | null; link: string | null; enabled: boolean }
export interface HomeModule { module: string; enabled: boolean; sort: number; title: string | null; title_i18n?: Record<string, string> | null; items: HomeModuleItem[] }
/** 海报位（开屏/每日弹窗）：enabled=false 时前台完全不渲染 */
export interface Poster { enabled: boolean; image_key: string | null; link: string | null; once_per_day?: boolean }
export interface CampaignPosters {
  hero_bg_key: string | null;
  page_bg_key: string | null;
  splash_poster: Poster;
  daily_popup: Poster;
}
/** 主题预设（后台编辑源）：status 仅在 admin/themes 列表响应中出现 */
export interface ThemePreset {
  id: string; name: string; theme: ThemeConfig; home_modules: HomeModule[];
  hero_bg_key: string | null; page_bg_key: string | null;
  splash_poster: Poster; daily_popup: Poster;
  start_at: string | null; end_at: string | null; enabled: boolean; sort: number;
  status?: "manual" | "scheduled" | "active" | "standby" | "expired" | "disabled";
}
/** 生效皮肤视图（购物端渲染源）：由后端读时解析，已过滤未启用模块/条目 */
export interface CampaignView {
  mode: "manual" | "scheduled" | "default";
  theme: ThemeConfig;
  home_modules: HomeModule[];
  posters: CampaignPosters;
  active_theme_id: string | null;
}
/** 二楼原始配置（后台编辑源，落 site_config 键 second_floor，文档G） */
export interface SecondFloorConfig {
  enabled: boolean;
  start_at: string | null;
  end_at: string | null;
  title: string;
  title_i18n: Record<string, string> | null;
  background_key: string | null;
  theme: ThemeConfig | null;
  trigger_hint: { text: string; icon_key: string | null };
  cta: { label: string; link: string };
  modules: HomeModule[];
}
/** 二楼生效视图（购物端下拉渲染源）：present=false 时前端不挂下拉手势；后端保证 present 时 theme 已回落为具体值 */
export type SecondFloorView =
  | { present: false }
  | ({ present: true; theme: ThemeConfig } & Omit<SecondFloorConfig, "enabled" | "start_at" | "end_at" | "theme">);
export interface InviteTriggerRule {
  enabled: boolean;
  /** coin 类型的到账数额不取本表的 reward_value_base，一律读「金币规则 → 邀请人得金币」 */
  reward_type: "balance" | "coupon" | "coin";
  reward_value_base: number;
  coupon_template_id: string | null;
  delay_minutes: number;
  basis?: "paid" | "completed";
  min_amount_base?: number;
}
export interface InviteRulesConfig {
  first_register: InviteTriggerRule;
  first_order: InviteTriggerRule;
  first_recharge: InviteTriggerRule;
  invitee_coupon_template_id: string | null;
  caps: { per_inviter_total: number; per_inviter_daily: number };
  note: string;
}
/** 收款渠道条目（文档H 通用注册表；payment_timeout_hours 为同表内全局数值键，非渠道） */
export interface PayChannelConfig {
  enabled: boolean;
  fulfillment?: "manual" | "online";
  display_name?: string;
  image_key?: string | null;
  holder_name?: string;
  account_no?: string;
  pay_link?: string;
  account_note?: string;
  /** 收款说明译文（只装非空语种，缺语回落 account_note 原文，同 #204 商品译文口径） */
  account_note_i18n?: Record<string, string> | null;
  provider?: string | null;
  /** 币种地址（文档L：rate_base_per_coin 为店主手填的 1 币折本位币「分」，0=未设汇率；decimals 展示小数位；image_key 该币专属收款码） */
  chains?: {
    symbol: string; network?: string; address: string; note?: string; note_i18n?: Record<string, string> | null;
    rate_base_per_coin?: number; decimals?: number; image_key?: string | null;
  }[];
}
export interface PayChannelsConfig {
  payment_timeout_hours: number;
  /** 墓碑：后台删掉的默认渠道码，读时补齐据此跳过（functions/config.mjs mergePayChannels 总是下发该数组） */
  removed_methods: string[];
  [method: string]: PayChannelConfig | number | string[];
}
/** pay_channels 里不是渠道的键：全局超时数值 + 删除墓碑；前后端/后台读取渠道时一律跳过 */
export const NON_METHOD_KEYS = ["payment_timeout_hours", "removed_methods"];
export interface SiteConfig {
  brand: { site_name: string; logo_key: string | null; favicon_key: string | null; hero_bg_key: string | null };
  theme: ThemeConfig;
  nav: NavItem[];
  home_modules: HomeModule[];
  pay_channels: PayChannelsConfig;
  /** 站点本位币（记账币种）：base=ISO 码，由后台 AN4 配置。前端据此解析记账金额的展示符号，不假设任何币种 */
  currency?: { base: string };
  /** 新用户默认 语言：zh/en/ja/ko/es，由后台装修页配置 */
  default_lang?: string;
  service: { auto_reply: string; auto_reply_i18n?: Record<string, string> | null; working_hours: string; offline_notice: string; contact: string; guest_chat_open?: boolean; guest_ip_limit?: number };
  switches: { register_open: boolean; order_open: boolean; maintenance: boolean; vip_coupon_stack?: boolean; invite_reward_trigger?: "register" | "first_order"; coins?: boolean; installment?: boolean };
  invite_rules: InviteRulesConfig;
  second_floor?: SecondFloorConfig;
  pages?: Record<string, StaticPage>;
  /** 余额提现门槛（文档O，site_config 整键，零迁移）：金额单位为分（本位币）；缺省=关闭 */
  withdraw?: { enabled: boolean; min_amount_base: number; max_amount_base: number; daily_limit: number };
}
/** A5 静态内容页（site_config "pages"；正文为纯文本，前端按行渲染，不解析 HTML） */
export interface StaticPage {
  title: string;
  title_i18n: Record<string, string> | null;
  body: string;
  body_i18n: Record<string, string> | null;
  updated_at: string | null;
}
export interface UserInfo {
  id: string; username: string; nickname: string; avatar_key: string | null;
  email: string | null; phone: string | null; has_payment_password: boolean;
  language: string; currency_code: string; balance: number; invite_code: string;
  status: string; created_at: string;
}
export interface CurrencyItem { code: string; symbol: string; name_i18n: Record<string, string>; rate_scaled: number; status: string }
/** 公告（文档A §27；banner/popup 走首页投放，user/vip 走消息中心） */
export interface AnnouncementItem {
  announcement_id: string;
  scope: "banner" | "popup" | "user" | "vip";
  status: string;
  target_user_id: string | null;
  title: string;
  content: string;
  title_i18n: Record<string, string>;
  content_i18n: Record<string, string>;
  publish_at: string;
  expire_at: string | null;
}
export interface Announcements { banner: AnnouncementItem[]; popup: AnnouncementItem[] }

interface BootstrapResult {
  config: SiteConfig;
  campaign: CampaignView;
  second_floor: SecondFloorView;
  currencies: CurrencyItem[];
  config_version: string;
  /** 商品/分类/SKU 指纹；缺失表示函数侧读失败，前端保持当前目录不动 */
  catalog_version?: string | null;
  server_time: string;
  me: ({ type: "user" } & UserInfo) | { type: "admin"; id: string } | null;
  announcements?: Announcements;
}

/** 装修「圆角」档位 → --radius；sm 即直角（全站默认） */
const RADIUS = { sm: "0rem", md: "0.25rem", lg: "0.5rem", xl: "0.75rem" } as const;
const FONTS: Record<ThemeConfig["font"], string> = {
  sans: "ui-sans-serif, system-ui, sans-serif",
  serif: "ui-serif, Georgia, serif",
  display: '"Trebuchet MS", ui-sans-serif, system-ui, sans-serif',
};

interface SiteContextValue {
  config: SiteConfig | null;
  campaign: CampaignView | null;
  secondFloor: SecondFloorView | null;
  currencies: CurrencyItem[];
  user: UserInfo | null;
  announcements: Announcements;
  strings: Record<string, string>;
  lang: string;
  setLang: (l: string) => void;
  ready: boolean;
  failed: boolean;
  t: (key: string, fallback?: string) => string;
  tf: (key: string, vars: Record<string, string | number>, fallback?: string) => string;
  refresh: () => Promise<void>;
}

const SiteContext = createContext<SiteContextValue | null>(null);

const EMPTY_ANNOUNCEMENTS: Announcements = { banner: [], popup: [] };

// html lang 跟随界面语言（index.html 里写死的 zh-CN 只是首屏兜底）
const HTML_LANG: Record<string, string> = { zh: "zh-CN", en: "en", ja: "ja", ko: "ko", es: "es" };

export function useSite(): SiteContextValue {
  const ctx = useContext(SiteContext);
  if (!ctx) throw new Error("useSite outside provider");
  return ctx;
}

/** 主题 → CSS 变量映射，供全局换肤与二楼局部换肤共用（局部注入到容器 style 即可只影响子树） */
export function themeVars(theme: ThemeConfig): Record<string, string> {
  return {
    "--primary": theme.primary,
    "--primary-foreground": "#ffffff",
    "--ring": theme.primary,
    "--secondary": theme.secondary,
    "--secondary-foreground": "#ffffff",
    "--background": theme.background,
    "--foreground": theme.text,
    "--radius": RADIUS[theme.radius] ?? "0rem",
    "--font-sans": FONTS[theme.font] ?? FONTS.sans,
  };
}

function applyTheme(config: SiteConfig | null, campaign?: CampaignView | null) {
  const root = document.documentElement;
  if (!config) return;
  // 换肤：优先用生效皮肤的 theme（活动预设），回落默认皮肤
  const { brand } = config;
  const theme = campaign?.theme ?? config.theme;
  const vars = themeVars(theme);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  document.title = brand.site_name;
}

/** 记账本位币解析：config.currency.base → 命中币种表的符号；币种未开通时符号回落币种码 */
function applyBaseCurrency(config: SiteConfig, currencies: CurrencyItem[]) {
  const base = config.currency?.base ?? "";
  const hit = base ? currencies.find((c) => c.code === base) : null;
  setBaseCurrency(base, hit?.symbol ?? base);
}

export function SiteProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ data: BootstrapResult | null; failed: boolean }>({ data: null, failed: false });
  const [lang, setLangState] = useState(() => localStorage.getItem("mall.lang") || "");
  const [strings, setStrings] = useState<Record<string, string>>({});
  const versionRef = useRef<string>("");
  const catalogRef = useRef<string>("");
  const langSeededRef = useRef<boolean>(Boolean(localStorage.getItem("mall.lang")));

  // 等 bootstrap 返回 config 后，如果用户没选过语言，用后台配置的默认值
  useEffect(() => {
    if (!lang && state.data?.config?.default_lang) {
      const def = state.data.config.default_lang;
      setLangState(def);
    }
  }, [lang, state.data?.config?.default_lang]);

  /** 目录指纹变化 → 广播，让已打开的分类/商品/品牌列表自己重取（后台上架无需刷新页面） */
  const noteCatalog = useCallback((v?: string | null) => {
    if (!v) return;
    if (catalogRef.current && v !== catalogRef.current) announceCatalogChange();
    catalogRef.current = v;
  }, []);

  // 公告等随语言取词，切换语言时重新拉一次 bootstrap
  const refresh = useCallback(async () => {
    try {
      const data = await call<BootstrapResult>("site/bootstrap", { token: "user", query: { lang } });
      versionRef.current = data.config_version;
      noteCatalog(data.catalog_version);
      applyTheme(data.config, data.campaign);
      applyBaseCurrency(data.config, data.currencies ?? []);
      setState({ data, failed: false });
      // 账号语言种子：本机未主动选过语言时，以账号偏好为准（不写 localStorage，保持跟随账号）
      if (!langSeededRef.current && data.me?.type === "user" && data.me.language) {
        langSeededRef.current = true;
        if (data.me.language !== lang) setLangState(data.me.language);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "account_disabled") {
        tokenStore.user.set(null);
        const data = await call<BootstrapResult>("site/bootstrap", { query: { lang } });
        applyTheme(data.config, data.campaign);
        applyBaseCurrency(data.config, data.currencies ?? []);
        noteCatalog(data.catalog_version);
        setState({ data, failed: false });
        return;
      }
      setState((prev) => ({ data: prev.data, failed: true }));
    }
  }, [lang, noteCatalog]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 60000);
    // 浏览器会把不可见标签页的定时器限流到约每分钟一次：切回来立刻补一次，配置/目录不再滞后
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    call<{ lang: string; strings: Record<string, string> }>("site/strings", { query: { lang } })
      .then((r) => setStrings(r.strings))
      .catch(() => setStrings({}));
  }, [lang]);

  useEffect(() => {
    document.documentElement.lang = HTML_LANG[lang] ?? lang;
  }, [lang]);

  const setLang = useCallback((l: string) => {
    localStorage.setItem("mall.lang", l);
    setLangState(l);
    // 已登录：偏好同步到账号（下次换设备登录自动跟随；失败静默，不打断本地切换）
    if (tokenStore.user.get()) {
      call("auth/profile", { method: "POST", token: "user", idem: newIdem(), body: { language: l } }).catch(() => {});
    }
  }, []);

  // 取词链：ui_strings(后台覆盖) → 内置语言包 MESSAGES[lang] → 内置中文兜底 → 传入 fallback → key
  const pick = useCallback(
    (key: string, fallback?: string) =>
      strings[key] ?? MESSAGES[lang]?.[key] ?? MESSAGES.zh[key] ?? fallback ?? key,
    [strings, lang],
  );
  const t = useCallback((key: string, fallback?: string) => pick(key, fallback), [pick]);
  const tf = useCallback(
    (key: string, vars: Record<string, string | number>, fallback?: string) =>
      pick(key, fallback).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "")),
    [pick],
  );

  // 数据模块里的纯函数（错误文案、倒计时、规则串）不在 React 树内，经 i18n.text() 反向取词
  useEffect(() => {
    setTextResolver((key, vars, fallback) =>
      Object.keys(vars).length ? tf(key, vars, fallback) : t(key, fallback));
  }, [t, tf]);

  const value = useMemo<SiteContextValue>(() => ({
    config: state.data?.config ?? null,
    campaign: state.data?.campaign ?? null,
    secondFloor: state.data?.second_floor ?? null,
    currencies: state.data?.currencies ?? [],
    user: state.data?.me?.type === "user" ? (state.data.me as UserInfo & { type: "user" }) : null,
    announcements: state.data?.announcements ?? EMPTY_ANNOUNCEMENTS,
    strings,
    lang,
    setLang,
    ready: state.data !== null,
    failed: state.failed,
    t,
    tf,
    refresh,
  }), [state, strings, lang, setLang, t, tf, refresh]);

  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>;
}
