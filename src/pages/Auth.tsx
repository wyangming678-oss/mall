import { useState, type FormEvent, type ReactNode } from "react";
import { call, ApiError, newIdem, tokenStore } from "../api";
import { navigate, Link, useQuery } from "../router";
import { useSite } from "../site";
import { BrandMark } from "../components/BrandMark";
import { LanguagePicker } from "../components/LanguagePicker";
import { CaptchaRow, captchaBody, useCaptchaChallenge } from "../components/CaptchaField";
import { DialPhoneInput } from "../components/DialPhoneInput";
import { DiffuseField } from "../components/DiffuseField";
import { buildE164, intentCurrencyForDial, dialLabel } from "../phone";
import { SUPPORT_EMAIL } from "../const";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// 客服联系方式里的邮箱自动变成可点 mailto；其余（微信/QQ/电话）原样保留，换行也保留
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function ContactText({ value }: { value: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(value)) !== null) {
    if (m.index > last) parts.push(value.slice(last, m.index));
    parts.push(
      <a key={`e${m.index}`} href={`mailto:${m[0]}`} className="font-semibold text-primary underline-offset-2 hover:underline">{m[0]}</a>,
    );
    last = m.index + m[0].length;
  }
  if (last < value.length) parts.push(value.slice(last));
  return <span className="mt-1 block whitespace-pre-line font-medium text-foreground">{parts}</span>;
}

interface AuthResult {
  token: string;
  user: UserInfoLike;
  invited?: boolean;
}
type UserInfoLike = { id: string; nickname: string };

// 后端只回中文 message，直接显示会把中文漏进其他语言界面 ⇒ 登录/注册错误一律按 code 取词跟随界面语言，
// 只有映射表里没有的 code 才回落原始 message。
const AUTH_ERR: Record<string, { key: string; zh: string }> = { /* i18n-fallback */
  unauthenticated: { key: "auth.err_unauthenticated", zh: "用户名或密码错误" },
  login_locked: { key: "auth.err_login_locked", zh: "失败次数过多，请稍后再试" },
  account_disabled: { key: "auth.err_account_disabled", zh: "账号已被禁用" },
  permission_denied: { key: "auth.err_register_closed", zh: "注册通道已关闭" },
  phone_taken: { key: "auth.err_phone_taken", zh: "该手机号已被注册" },
  claim_conflict: { key: "auth.err_claim_conflict", zh: "该用户名或邮箱已被注册" },
  contact_required: { key: "auth.contact_required", zh: "手机号和邮箱至少填写一项" },
  invalid_request: { key: "auth.err_invalid_request", zh: "填写内容有误，请检查后重试" },
  captcha_required: { key: "auth.err_captcha_required", zh: "请先完成人机验证" },
  captcha_wrong: { key: "auth.err_captcha_wrong", zh: "数字填错了，请重新输入" },
  captcha_invalid: { key: "auth.err_captcha_invalid", zh: "验证题已失效，请点击图片换一张" },
  captcha_too_fast: { key: "auth.err_captcha_too_fast", zh: "操作太快了，请稍等几秒再提交" },
  service_unavailable: { key: "auth.err_service_unavailable", zh: "服务暂时不可用，请稍后重试" },
  internal_error: { key: "auth.err_server", zh: "服务器繁忙，请稍后重试" },
};

function authErr(err: ApiError, t: (key: string, fallback?: string) => string): string {
  const hit = AUTH_ERR[err.code];
  if (hit) return t(hit.key, hit.zh);
  return err.message || `${t("auth.error_prefix", "错误：")}${err.code}`;
}

const BENEFITS = [ /* i18n-fallback */
  { titleKey: "auth.benefit1_title", title: "全场好物", descKey: "auth.benefit1_desc", desc: "精选商品，持续上新" },
  { titleKey: "auth.benefit2_title", title: "安全支付", descKey: "auth.benefit2_desc", desc: "微信 / 支付宝收款保障" },
  { titleKey: "auth.benefit3_title", title: "邀请有礼", descKey: "auth.benefit3_desc", desc: "好友下单，奖励不断" },
];

function AuthShell({ title, subTitle, children }: { title: string; subTitle: string; children: ReactNode }) {
  const { config, t } = useSite();
  const name = config?.brand?.site_name ?? "ChicCart";
  return (
    <div className="relative mx-auto flex min-h-[calc(100dvh-8rem)] w-full max-w-5xl flex-col justify-center gap-3 px-4 py-6">
      {/* 动态背景层：登录/注册是两条路由，切页即重挂载 → 入场动画每次切换都重播一遍 */}
      <div className="auth-field pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <span className="auth-wash absolute -left-[8%] -top-[10%] size-[42vh] rounded-full bg-primary/25 blur-[70px]" />
        <span className="auth-wash absolute -right-[10%] top-[26%] size-[38vh] rounded-full bg-secondary/25 blur-[80px] [animation-delay:-7s]" />
        <span className="auth-wash absolute -bottom-[12%] left-[36%] size-[34vh] rounded-full bg-primary/20 blur-[70px] [animation-delay:-11s]" />
        <DiffuseField count={12} axis="radial" />
      </div>
      {/* 未登录时这里是唯一的语言入口（登录用户在个人主页「设置」里切换）；顶栏不渲染，品牌由卡片顶部条承载 */}
      <div className="relative flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Link to="/" className="hidden items-center gap-2 md:flex">
          <BrandMark size="sm" logoKey={config?.brand?.logo_key} siteName={name} />
          <span className="text-sm font-semibold text-foreground">{name}</span>
        </Link>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("auth.ui_language", "界面语言")}</span>
          <LanguagePicker />
        </span>
      </div>
      <div className="relative grid w-full overflow-hidden rounded-3xl bg-card shadow-xl ring-1 ring-black/5 md:grid-cols-[5fr_6fr]">
        {/* 品牌视觉区：手机压成顶部一条动态品牌带，桌面保留大图 + 权益列表 */}
        <div className="relative flex flex-col justify-between overflow-hidden brand-gradient p-4 md:p-8">
          <span className="pointer-events-none absolute -left-8 -top-10 size-36 rounded-full bg-white/15 animate-float-slow" />
          <span className="pointer-events-none absolute bottom-14 right-[-2rem] hidden size-44 rounded-full bg-white/10 animate-float-slow [animation-delay:1.4s] md:block" />
          {/* 手机带只有一行、桌面面板文字靠左，图标场统一让到右半边，不从文字底下穿过去 */}
          <DiffuseField count={9} axis="y" tone="light" className="ml-[46%] md:ml-[50%]" />
          <span className="auth-sheen pointer-events-none absolute inset-y-[-20%] left-0 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent" />
          {/* 手机端：品牌带本身可点回首页（顶栏不在，链接只能放这里）；桌面端保持大图 + 标语 */}
          <Link to="/" className="relative flex items-center gap-2.5 animate-fade-up md:hidden">
            <BrandMark size="sm" plain logoKey={config?.brand?.logo_key} siteName={name} />
            <p className="text-sm font-bold text-white">{name}</p>
          </Link>
          <div className="hidden animate-fade-up md:block">
            <BrandMark size="lg" plain logoKey={config?.brand?.logo_key} siteName={name} />
            <h2 className="mt-6 text-2xl font-bold leading-snug text-white">{name}</h2>
            <p className="mt-1 text-sm text-white/85">{t("auth.tagline", "好物，从这里开始")}</p>
          </div>
          <ul className="relative mt-8 hidden flex-col gap-4 md:flex">
            {BENEFITS.map((b, i) => (
              <li key={b.title} className="flex items-center gap-3 text-white animate-fade-up" style={{ animationDelay: `${0.25 + i * 0.15}s` }}>
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/20 text-sm font-bold">{i + 1}</span>
                <div>
                  <p className="text-sm font-semibold">{t(b.titleKey, b.title)}</p>
                  <p className="text-xs text-white/75">{t(b.descKey, b.desc)}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* 表单区 */}
        <div className="flex flex-col justify-center px-6 py-8 sm:px-10">
          <div className="mx-auto w-full max-w-sm animate-fade-up [animation-delay:0.1s]">
            <h1 className="text-2xl font-bold text-foreground">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{subTitle}</p>
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { refresh, config, t, tf, lang } = useSite();
  const [mode, setMode] = useState<"username" | "phone">("username");
  const [username, setUsername] = useState("");
  const [dial, setDial] = useState("86");
  const [national, setNational] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 失败 2 次起服务端要求答题（401 details.captcha_required）
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const cap = useCaptchaChallenge("user_login", needCaptcha);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    let ident: Record<string, string>;
    if (mode === "phone") {
      const built = buildE164(dial, national);
      if (built.error) { setError(built.errorKey ? tf(built.errorKey, { label: dialLabel(dial, lang) }, built.error) : built.error); return; }
      ident = { phone_dial_code: dial, phone_national: national };
    } else {
      if (!username.trim()) { setError(t("auth.username_required", "请输入用户名")); return; }
      ident = { username: username.trim() };
    }
    setBusy(true);
    setError("");
    try {
      const r = await call<AuthResult>("auth/login", {
        method: "POST", body: { ...ident, password, ...(needCaptcha ? captchaBody(cap) : {}) },
      });
      tokenStore.user.set(r.token);
      await refresh();
      navigate("/me");
    } catch (err) {
      if (err instanceof ApiError) {
        const d = err.details as { captcha_required?: boolean } | undefined;
        if (d?.captcha_required || err.code === "captcha_required") setNeedCaptcha(true);
        // 提交即消耗题目（哪怕 401 密码错），too_fast 是唯一未消耗的错误 → 其余错误一律换题
        if (err.code !== "captcha_too_fast") void cap.refresh();
        setError(authErr(err, t));
      } else setError(t("auth.login_failed", "登录失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t("auth.welcome_title", "欢迎回来")} subTitle={t("auth.welcome_sub", "登录后即可下单、查看余额与邀请好友")}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex rounded-xl border p-0.5 text-sm">
          {(["username", "phone"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`h-9 flex-1 rounded-lg font-medium transition ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            >
              {m === "username" ? t("auth.mode_username", "用户名登录") : t("auth.mode_phone", "手机号登录")}
            </button>
          ))}
        </div>
        {mode === "username" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lg-u">{t("auth.username", "用户名")}</Label>
            <Input id="lg-u" className="h-10" placeholder={t("auth.username_ph", "请输入用户名")} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label>{t("auth.phone", "手机号")}</Label>
            <DialPhoneInput idNum="lg-pn" dial={dial} national={national} onDial={setDial} onNational={setNational} required />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lg-p">{t("auth.password", "密码")}</Label>
          <Input id="lg-p" className="h-10" type="password" placeholder={t("auth.password_ph", "请输入密码")} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        {needCaptcha && <CaptchaRow cap={cap} />}
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">{error}</p>
        )}
        <Button type="submit" disabled={busy || (needCaptcha && !cap.challenge)} className="mt-1 h-10 rounded-xl text-base shadow-md shadow-primary/30">
          {busy ? t("auth.logging_in", "登录中…") : t("auth.login_btn", "登 录")}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          {t("auth.no_account", "还没有账号？")}<Link to="/register" className="font-semibold text-primary underline-offset-2 hover:underline">{t("auth.register_now", "立即注册")}</Link>
        </p>
        <p className="text-center text-xs text-muted-foreground">
          {/* 文档J §2.2：客服免注册可用，所以这里直接给访客一条入口，不再只是文字提示 */}
          <Link to="/me/support" className="font-semibold text-primary hover:underline">{t("auth.forgot", "忘记密码？请联系客服")}</Link>
          <ContactText value={(config?.service?.contact || "").trim() || SUPPORT_EMAIL} />
        </p>
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const { refresh, config, currencies, t, tf, lang } = useSite();
  const query = useQuery();
  const [form, setForm] = useState({
    username: "", password: "", nickname: "", email: "",
    phone_dial: "86", phone: "",
    invite_code: (query.ref ?? "").toUpperCase(),
  });
  const [website, setWebsite] = useState(""); // 蜜罐：真人看不见也填不了，填了必是脚本
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cap = useCaptchaChallenge("register", true);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  // 与后端 resolveRegisterCurrency 同源的预览：意图币种（没填号码就没有意图）→ 站点本位币 → USD → 首个已开通
  const expectedCurrency = (() => {
    if (!currencies.length) return "";
    const chain = [form.phone.trim() ? intentCurrencyForDial(form.phone_dial) : null, config?.currency?.base, "USD"];
    const hit = chain.find((code): code is string => Boolean(code) && currencies.some((c) => c.code === code));
    return hit ?? currencies[0].code;
  })();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const phoneGiven = Boolean(form.phone.trim());
    // 手机号/邮箱二选一必填：两边都空就拦在前端，后端 register 有同一条 contact_required 兜底
    if (!phoneGiven && !form.email.trim()) {
      setError(tf("auth.contact_required", {}, "手机号和邮箱至少填写一项"));
      return;
    }
    const built: { value?: string; error?: string; errorKey?: string } = phoneGiven ? buildE164(form.phone_dial, form.phone) : {};
    if (built.error) { setError(built.errorKey ? tf(built.errorKey, { label: dialLabel(form.phone_dial, lang) }, built.error) : built.error); return; }
    setBusy(true);
    setError("");
    try {
      const r = await call<AuthResult>("auth/register", {
        method: "POST",
        idem: newIdem(),
        body: {
          username: form.username,
          password: form.password,
          nickname: form.nickname || form.username,
          email: form.email.trim() || undefined,
          // 号码留空时整对字段都不发，后端据此走「无区号→站点本位币」
          ...(phoneGiven ? { phone_dial_code: form.phone_dial, phone_national: form.phone } : {}),
          language: localStorage.getItem("mall.lang") || config?.default_lang || "zh",
          invite_code: form.invite_code || undefined,
          website: website || undefined,
          ...captchaBody(cap),
        },
      });
      tokenStore.user.set(r.token);
      await refresh();
      navigate("/me");
    } catch (err) {
      if (err instanceof ApiError) {
        // 提交即消耗题目（哪怕用户名占用等 409），too_fast 是唯一未消耗的错误 → 其余错误一律换题
        if (err.code !== "captcha_too_fast") void cap.refresh();
        setError(authErr(err, t));
      } else setError(t("auth.register_failed", "注册失败"));
    } finally {
      setBusy(false);
    }
  }

  if (config && !config.switches.register_open) {
    return (
      <AuthShell title={t("auth.reg_closed_title", "注册通道已关闭")} subTitle={t("auth.reg_closed_sub", "管理员暂停了注册，请稍后再试或联系管理员")}>
        <Link to="/" className="inline-block text-sm font-semibold text-primary hover:underline">{t("auth.reg_back_home", "返回首页浏览")}</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t("auth.reg_title", "创建账号")} subTitle={t("auth.reg_sub", "注册即登录，邀请码选填")}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rg-u">{t("auth.username", "用户名")}</Label>
            <Input id="rg-u" className="h-10" placeholder={t("auth.username_rules", "字母/数字/下划线 3-20 位")} value={form.username} onChange={(e) => set("username")(e.target.value)} required minLength={3} maxLength={20} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rg-n">{t("auth.nickname", "昵称")}</Label>
            <Input id="rg-n" className="h-10" placeholder={t("auth.nickname_ph", "展示用名称")} value={form.nickname} onChange={(e) => set("nickname")(e.target.value)} maxLength={30} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rg-pn">{t("auth.phone_label", "手机号（选填，选择区号后填写号码）")}</Label>
          <DialPhoneInput idNum="rg-pn" dial={form.phone_dial} national={form.phone} onDial={set("phone_dial")} onNational={set("phone")} />
          <p className="text-xs text-muted-foreground">{t("auth.contact_hint", "手机号与邮箱至少填写一项，用于订单联系与找回账号")}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rg-p">{t("auth.password", "密码")}</Label>
            <Input id="rg-p" className="h-10" type="password" placeholder={t("auth.password_min", "至少 8 位")} value={form.password} onChange={(e) => set("password")(e.target.value)} required minLength={8} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rg-e">{t("auth.email", "邮箱（选填）")}</Label>
            <Input id="rg-e" className="h-10" type="email" placeholder={t("auth.email_ph", "用于找回，可留空")} value={form.email} onChange={(e) => set("email")(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>{t("auth.settle_currency", "结算币种")}</Label>
            <p className="flex h-10 items-center rounded-xl border bg-muted/40 px-3 text-sm text-muted-foreground">
              {expectedCurrency || "—"}
              <span className="ml-2 text-xs">{t("auth.settle_currency_hint", "（按区号自动匹配）")}</span>
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rg-i">{t("auth.invite_code", "邀请码（可选）")}</Label>
            <Input id="rg-i" className="h-10" placeholder={t("auth.invite_code_ph", "好友邀请码")} value={form.invite_code} onChange={(e) => set("invite_code")(e.target.value.toUpperCase())} maxLength={10} />
          </div>
        </div>
        {/* 蜜罐字段：对真人完全隐藏；机器人普遍会填所有 text 输入 */}
        <div className="hidden" aria-hidden="true">
          <label htmlFor="rg-w">{t("auth.hp_label", "网站（勿填）")}</label>
          <Input id="rg-w" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </div>
        <CaptchaRow cap={cap} label={t("auth.captcha_label", "人机验证")} />
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">{error}</p>
        )}
        <Button type="submit" disabled={busy || !cap.challenge} className="mt-1 h-10 rounded-xl text-base shadow-md shadow-primary/30">
          {busy ? t("common.submitting", "提交中…") : t("auth.register_btn", "注册并登录")}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          {t("auth.have_account", "已有账号？")}<Link to="/login" className="font-semibold text-primary underline-offset-2 hover:underline">{t("auth.go_login", "去登录")}</Link>
        </p>
      </form>
    </AuthShell>
  );
}
