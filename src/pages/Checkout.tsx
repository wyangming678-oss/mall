// 下单结算：AD1 地址 + 币种 + CP2 选券 + O1 创建订单（文档C §二/§四）
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, call, newIdem } from "../api";
import { Link, navigate, RedirectTo, useQuery } from "../router";
import { useSite } from "../site";
import { formatBase, pickLocalized } from "../const";
import { CartLoading } from "../components/CartLoading";
import { ProductCover } from "../components/ProductCard";
import { AddressFields, addressDraftError, toDraft, oneLine, type AddressDraft } from "../components/AddressFields";
import { InstallmentProfileModal, type InstallmentProfile } from "../components/InstallmentProfileModal";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { intersectPeriods, previewSchedule } from "../installments";
import {
  COUPON_REASON_TEXT, couponRuleText, fmtDate, money, rateText, shopErr, symbolOf, usableCurrencyCode, useLoader,
  type AddressRow, type CartItem, type CartResult, type CouponOption, type CouponQuote,
} from "../trade";

interface CheckoutData {
  cart: CartResult;
  addresses: AddressRow[];
}

function CouponPicker({ quote, loading, error, couponId, onChange }: {
  quote: CouponQuote | null;
  loading: boolean;
  error: string;
  couponId: string;
  onChange: (id: string) => void;
}) {
  const { t, tf, lang } = useSite();
  const options = quote?.options ?? [];
  const usable = options.filter((o) => o.usable);
  const bestId = usable[0]?.coupon_id ?? "";
  const quotedGoods = quote?.goods_amount_base ?? 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{t("checkout.coupon", "优惠券")}</span>
        <span className="text-xs text-muted-foreground">
          {loading ? t("checkout.coupon_loading", "正在算券…") : usable.length ? tf("checkout.coupon_usable", { n: usable.length }, "{n} 张可用") : options.length ? t("checkout.coupon_none", "暂无满足条件的券") : t("checkout.coupon_empty", "券包为空")}
        </span>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-col gap-2">
        <label className={"flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm transition "
          + (couponId === "" ? "border-primary bg-primary/5" : "hover:border-primary/60")}>
          <input type="radio" name="coupon" className="size-4 accent-[var(--primary)]" checked={couponId === ""} onChange={() => onChange("")} />
          <span className="text-muted-foreground">{t("checkout.coupon_dont_use", "不使用优惠券")}</span>
        </label>
        {options.map((o: CouponOption) => (
          <label key={o.coupon_id}
            className={"flex items-start gap-3 rounded-xl border px-3 py-2 text-sm transition "
              + (o.usable ? "cursor-pointer hover:border-primary/60 " : "opacity-60 ")
              + (couponId === o.coupon_id ? "border-primary bg-primary/5" : "")}
          >
            <input type="radio" name="coupon" className="mt-0.5 size-4 accent-[var(--primary)]" disabled={!o.usable}
              checked={couponId === o.coupon_id} onChange={() => onChange(o.coupon_id)} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <b className="truncate">{pickLocalized(o.name_i18n, o.name, lang) || t("coupon.withdrawn", "券已下架")}</b>
                <span className="text-xs text-primary">{couponRuleText(o)}</span>
                {o.usable && o.coupon_id === bestId && <span className="rounded-md bg-accent px-2 py-0.5 text-[11px] text-accent-foreground">{t("checkout.coupon_best", "优惠最大")}</span>}
              </span>
              <span className="text-xs text-muted-foreground">
                {o.usable
                  ? tf("checkout.coupon_deduct", { amt: formatBase(o.deduction_amount_base), date: fmtDate(o.expire_at) }, "本单可减 {amt} · 有效期至 {date}")
                  : t("status.coupon_reason." + (o.reason ?? ""), COUPON_REASON_TEXT[o.reason ?? ""] ?? t("checkout.coupon_unusable", "本单不可用"))}
                {o.usable && (o.eligible_amount_base ?? 0) < (quote?.goods_amount_base ?? 0) && t("checkout.coupon_partial", " · 仅部分商品参与")}
              </span>
            </span>
            {o.usable && <span className="shrink-0 font-medium text-primary">−{formatBase(o.deduction_amount_base)}</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

function AddressCard({ selectedId, addresses, onPick, onCreated }: {
  selectedId: string;
  addresses: AddressRow[];
  onPick: (id: string) => void;
  onCreated: () => void;
}) {
  const { t, tf } = useSite();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<AddressDraft>(toDraft(null, t("af.country_default", "中国")));
  const [asDefault, setAsDefault] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState("");

  async function remove(id: string) {
    setDeleting(id);
    setError("");
    try {
      await call("address/delete", { method: "POST", token: "user", idem: newIdem(), body: { address_id: id } });
      onCreated();
    } catch (err) {
      setError(shopErr(err));
    } finally {
      setDeleting("");
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const invalid = addressDraftError(draft, t);
    if (invalid) { setError(invalid); return; }
    setBusy(true);
    setError("");
    try {
      await call("address/save", {
        method: "POST", token: "user", idem: newIdem(),
        body: { ...draft, district: draft.district || undefined, postal_code: draft.postal_code || undefined, is_default: asDefault },
      });
      setAdding(false);
      setDraft(toDraft(null, t("af.country_default", "中国")));
      onCreated();
    } catch (err) {
      setError(shopErr(err));
    } finally {
      setBusy(false);
    }
  }

  if (adding) {
    return (
      <form className="flex flex-col gap-3 rounded-2xl border bg-card p-4" onSubmit={submit}>
        <p className="text-sm font-medium">{t("checkout.address_add", "新增收货地址")}</p>
        <AddressFields value={draft} onChange={(patch) => { setDraft((d) => ({ ...d, ...patch })); setError(""); }} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={asDefault} onChange={(e) => setAsDefault(e.target.checked)} />
          {t("checkout.address_default_set", "设为默认地址")}
        </label>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy}>{busy ? t("checkout.address_saving", "保存中…") : t("checkout.address_save", "保存地址")}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => { setAdding(false); setError(""); }}>{t("common.cancel", "取消")}</Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {!addresses.length && <p className="text-sm text-muted-foreground">{t("checkout.address_none", "还没有收货地址，请先添加一个。")}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {addresses.map((a) => (
        <div key={a.id} className={"flex items-start gap-2 rounded-2xl border bg-card p-3 transition " + (a.id === selectedId ? "border-primary shadow-sm" : "hover:border-primary/60")}>
          <label className="flex flex-1 cursor-pointer gap-3 text-sm">
            <input type="radio" name="addr" className="mt-1 size-4 accent-[var(--primary)]" checked={a.id === selectedId} onChange={() => onPick(a.id)} />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">
                {a.receiver_name} · {a.phone}
                {a.is_default && <span className="ml-2 rounded-md bg-accent px-2 py-0.5 text-xs text-accent-foreground">{t("checkout.address_default_tag", "默认")}</span>}
              </span>
              <span className="text-muted-foreground">{a.country}{a.province}{a.city}{a.district ?? ""}{a.detail}{a.postal_code ? tf("common.paren", { v: a.postal_code }, "（{v}）") : ""}</span>
            </span>
          </label>
          <button type="button" className="shrink-0 text-sm text-muted-foreground underline hover:text-destructive" disabled={deleting === a.id} onClick={() => void remove(a.id)}>
            {deleting === a.id ? t("checkout.deleting", "删除中…") : t("common.delete", "删除")}
          </button>
        </div>
      ))}
      <button type="button" className="self-start text-sm text-primary underline" onClick={() => setAdding(true)}>{t("checkout.address_add_btn", "+ 新增收货地址")}</button>
    </div>
  );
}

export function CheckoutPage() {
  const query = useQuery();
  const { user, currencies, config, ready, lang, t, tf } = useSite();
  const ids = useMemo(() => (query.ids ?? "").split(",").filter(Boolean), [query.ids]);
  const { data, loading, error, refresh } = useLoader<CheckoutData>(async () => {
    const [cart, addr] = await Promise.all([
      call<CartResult>("cart/list", { token: "user" }),
      call<{ items: AddressRow[] }>("address/list", { token: "user" }),
    ]);
    return { cart, addresses: addr.items };
  }, [user?.id]);

  const [addressId, setAddressId] = useState("");
  // 结算币种只跟随账号（注册时按区号定），不再提供前端下拉；账号币种已下架时回落站点本位币（与后端同口径）
  const currency = usableCurrencyCode(currencies, user?.currency_code);
  const [remark, setRemark] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [couponId, setCouponId] = useState("");
  const [installmentN, setInstallmentN] = useState<number | null>(null);
  // 分期购买两道闸：① 个人信息弹窗 ② 购买须知确认页（确认后 step 才回到表单态提交）
  const [profile, setProfile] = useState<InstallmentProfile | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [confirmStep, setConfirmStep] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [quote, setQuote] = useState<CouponQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [quoteTick, setQuoteTick] = useState(0);

  const lines: CartItem[] = (data?.cart.items ?? []).filter((it) => ids.includes(it.id) && it.purchasable);
  const cartKey = lines.map((it) => it.id).join(",");
  const pickedAddress = data?.addresses.find((a) => a.id === addressId)
    ?? data?.addresses.find((a) => a.is_default) ?? data?.addresses[0] ?? null;
  const goodsBase = lines.reduce((sum, it) => sum + (it.sku?.price_base ?? 0) * it.quantity, 0);
  const chosen = (quote?.options ?? []).find((o) => o.coupon_id === couponId && o.usable) ?? null;
  const vipQuote = quote?.vip ?? null;
  // 与函数侧 O1 的 useVip 同口径：关闭叠加且选了券时，会员折扣让位给券
  const vipActive = Boolean(vipQuote) && (quote?.vip_coupon_stack !== false || !chosen);
  const vipDiscountBase = vipActive ? (vipQuote?.discount_amount_base ?? 0) : 0;
  const actualBase = Math.max(0, goodsBase - vipDiscountBase - (chosen?.deduction_amount_base ?? 0));
  const rate = currencies.find((c) => c.code === currency)?.rate_scaled ?? 1_000_000;
  const symbol = symbolOf(currencies, currency);
  const orderOpen = config?.switches?.order_open !== false;

  // 文档N D4/D6：仅当开关开启且本单每件商品都可分期时，才给出期数选项（各商品可选期数交集）
  const installmentOn = config?.switches?.installment === true && lines.length > 0;
  const periodOptions = installmentOn
    ? intersectPeriods(lines.map((it) => it.product?.installment ?? { enabled: false, periods: [] }))
    : [];
  const canInstallment = periodOptions.length > 0;
  const activeN = canInstallment ? installmentN : null;
  const schedule = activeN ? previewSchedule(actualBase, activeN) : null;

  useEffect(() => {
    if (!user || !cartKey) {
      setQuote(null);
      setCouponId("");
      setQuoteError("");
      setQuoteLoading(false);
      return undefined;
    }
    let alive = true;
    setQuoteLoading(true);
    call<CouponQuote>("coupon/available-for-cart", { token: "user", query: { cart_ids: cartKey } })
      .then((r) => {
        if (!alive) return;
        setQuote(r);
        setQuoteError("");
        // 默认选中优惠最大的一张；已选券仍可用则保持选择
        setCouponId((cur) => (
          r.options.some((o) => o.coupon_id === cur && o.usable)
            ? cur
            : (r.options.find((o) => o.usable)?.coupon_id ?? "")
        ));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setQuote(null);
        setCouponId("");
        setQuoteError(shopErr(e));
      })
      .finally(() => { if (alive) setQuoteLoading(false); });
    return () => { alive = false; };
    // 仅在购物车集合/登录主体变化或手动重算时取券；user 用 id 参与即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey, quoteTick, user?.id]);

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("checkout.preparing", "正在准备结算…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;
  if (!loading && (!ids.length || !lines.length)) return <RedirectTo to="/cart" />;

  async function submit() {
    if (!pickedAddress) { setFormError(t("checkout.pick_address", "请先选择收货地址")); return; }
    setSubmitting(true);
    setFormError("");
    try {
      const r = await call<{ order_id: string }>("order/create", {
        method: "POST", token: "user", idem: newIdem(),
        body: {
          cart_ids: lines.map((it) => it.id),
          address_id: pickedAddress.id,
          currency_code: currency || undefined,
          coupon_id: chosen?.coupon_id,
          installment: activeN ?? undefined,
          installment_profile: activeN !== null ? profile ?? undefined : undefined,
          buyer_remark: remark || undefined,
        },
      });
      navigate(`/order?id=${r.order_id}&created=1`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "coupon_unavailable") {
        const msg = e.message || t("status.coupon_reason.coupon_unavailable", "优惠券当前不可用");
        setFormError(tf("checkout.err_coupon_reset", { msg }, "{msg}（已重置选券，请确认后重新提交）"));
        setCouponId("");
        setQuoteTick((t) => t + 1);
      } else if (e instanceof ApiError && (e.code === "insufficient_stock" || e.code === "state_conflict")) {
        setFormError(tf("checkout.err_stock_reset", { msg: e.message }, "{msg}（库存或商品状态已变动，购物车已刷新）"));
        refresh();
      } else if (e instanceof ApiError && e.code === "installment_profile_required") {
        // 后端兜底闸：资料缺失时回到弹窗，报错文案走语言系统（不吃后端中文）
        setConfirmStep(false);
        setProfileOpen(true);
        setFormError(t("installment.err_profile_required", "请先填写姓名、手机号、邮箱地址与详细住址"));
      } else setFormError(shopErr(e));
    } finally {
      setSubmitting(false);
    }
  }

  function onInstallmentSubmit() {
    if (!pickedAddress) { setFormError(t("checkout.pick_address", "请先选择收货地址")); return; }
    setFormError("");
    setProfileOpen(true);
  }

  // 弹窗预填：收货地址带出姓名/手机/住址，邮箱带出账号邮箱（四项仍可改，落库以提交的为准）
  const profileInitial: InstallmentProfile = profile ?? {
    name: pickedAddress?.receiver_name ?? user?.nickname ?? "",
    phone: pickedAddress?.phone ?? user?.phone ?? "",
    email: user?.email ?? "",
    address: pickedAddress
      ? `${pickedAddress.country}${pickedAddress.province}${pickedAddress.city}${pickedAddress.district ?? ""}${pickedAddress.detail}`
      : "",
  };

  if (confirmStep && activeN !== null && profile && schedule) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
        <h1 className="text-lg font-bold">{t("installment.confirm_title", "分期购买确认")}</h1>

        <section className="flex flex-col gap-1 border-t pt-3 text-sm">
          <div className="flex justify-between"><span>{t("installment.checkout_title", "分期支付")}</span><span className="font-medium">{tf("installment.period_n", { n: activeN }, "{n} 期")}</span></div>
          <div className="flex justify-between"><span>{t("installment.deposit", "首付（第 1 期）")}</span><span className="font-medium text-primary">{formatBase(schedule.deposit_amount_base)}</span></div>
          <div className="flex justify-between text-muted-foreground"><span>{tf("installment.tail_each", { n: schedule.n - 1 }, "尾款每期")}</span><span>{formatBase(schedule.tail_each_base)}</span></div>
          <div className="flex justify-between font-bold"><span>{t("checkout.payable", "应付")}</span><span className="text-primary">{money(Math.round((actualBase * rate) / 1e6), symbol)}</span></div>
        </section>

        <section className="flex flex-col gap-1 border-t pt-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium">{t("installment.confirm_profile_title", "所填资料")}</span>
            <button type="button" className="text-xs text-primary underline" onClick={() => { setConfirmStep(false); setProfileOpen(true); }}>{t("installment.confirm_edit", "返回修改")}</button>
          </div>
          <p><span className="text-muted-foreground">{t("installment.field_name", "姓名")}：</span>{profile.name}</p>
          <p><span className="text-muted-foreground">{t("installment.field_phone", "手机号")}：</span>{profile.phone}</p>
          <p><span className="text-muted-foreground">{t("installment.field_email", "邮箱地址")}：</span>{profile.email}</p>
          <p className="break-words"><span className="text-muted-foreground">{t("installment.field_address", "详细住址")}：</span>{profile.address}</p>
          <p className="break-words text-muted-foreground">{t("checkout.address", "收货地址")}：{oneLine(pickedAddress)}</p>
        </section>

        <section className="flex flex-col gap-2 border bg-card p-4">
          <p className="text-sm font-semibold">{t("installment.confirm_notice_title", "购买须知与信息保护承诺")}</p>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-relaxed">
            <li>{t("installment.confirm_point_1", "填写详细信息并完成付款后，将会在 48 小时内完成发货")}</li>
            <li>{t("installment.confirm_point_2", "需每月按时付款")}</li>
            <li>{t("installment.confirm_point_3", "平台将保证所填写的信息受到保护")}</li>
            <li>{t("installment.confirm_point_4", "如果发生信息泄露，ChicCart 将会承担所有的法律责任")}</li>
          </ol>
          <label className="flex items-start gap-2 border-t pt-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={agreed}
              onChange={(e) => { setAgreed(e.target.checked); setFormError(""); }} />
            <span>{t("installment.confirm_agree", "我已知晓以上内容，并确认所填信息真实有效")}</span>
          </label>
        </section>

        {formError && <p className="text-sm text-destructive">{formError}</p>}
        {!orderOpen && <p className="text-sm text-destructive">{t("checkout.order_closed", "下单功能暂未开放，请联系客服。")}</p>}
        <div className="flex items-center gap-3">
          <Button onClick={() => void submit()} disabled={submitting || !orderOpen || !agreed || !lines.length}>
            {submitting ? t("common.submitting", "提交中…") : t("installment.confirm_submit", "确认并提交订单")}
          </Button>
          <Link to="/cart" className="text-sm text-muted-foreground underline">{t("checkout.back_cart", "返回购物车")}</Link>
        </div>
      </div>
    );
  }

  if (loading && !data) return <div className="grid place-items-center py-16"><CartLoading label={t("checkout.preparing", "正在准备结算…")} /></div>;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
      <h1 className="text-lg font-bold">{t("checkout.title", "确认订单")}</h1>
      {error && <p className="rounded-xl border bg-card px-4 py-3 text-sm text-destructive">{error}</p>}

      <section className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t("checkout.address", "收货地址")}</p>
        <AddressCard
          selectedId={pickedAddress?.id ?? ""}
          addresses={data?.addresses ?? []}
          onPick={setAddressId}
          onCreated={refresh}
        />
      </section>

      <section className="flex flex-col gap-2">
        <p className="text-sm font-medium">{tf("checkout.items_title", { n: lines.length }, "商品清单（{n} 种）")}</p>
        <ul className="flex flex-col gap-2">
          {lines.map((it) => {
            const itTitle = it.product ? pickLocalized(it.product.title_i18n, it.product.title, lang) : "";
            const itSpec = it.sku ? pickLocalized(it.sku.spec_name_i18n, it.sku.spec_name, lang) : "";
            return (
            <li key={it.id} className="flex items-center gap-3 rounded-2xl border bg-card p-3 text-sm">
              <span className="size-14 shrink-0 overflow-hidden rounded-lg border bg-muted">
                <ProductCover imageKey={it.product?.images?.[0]} alt={itTitle} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{itTitle}</span>
                <span className="text-xs text-muted-foreground">{itSpec} · ×{it.quantity}</span>
              </span>
              <span className="font-medium">{formatBase((it.sku?.price_base ?? 0) * it.quantity)}</span>
            </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
        <CouponPicker quote={quote} loading={quoteLoading} error={quoteError} couponId={couponId} onChange={setCouponId} />
      </section>

      {canInstallment && (
        <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t("installment.checkout_title", "分期支付")}</span>
            <div className="flex items-center gap-1 text-sm">
              <button
                type="button"
                onClick={() => setInstallmentN(null)}
                className={"px-3 py-1 " + (activeN === null ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >{t("installment.mode_full", "全额支付")}</button>
              <button
                type="button"
                onClick={() => setInstallmentN(periodOptions[0] ?? null)}
                className={"px-3 py-1 " + (activeN !== null ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >{t("installment.mode_split", "分期付款")}</button>
            </div>
          </div>

          {activeN !== null && (
            <>
              <div className="flex flex-wrap gap-2">
                {periodOptions.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setInstallmentN(n)}
                    className={"min-w-16 border px-3 py-1.5 text-sm " + (n === activeN ? "border-primary bg-primary/5 font-medium text-primary" : "border-border hover:border-primary/60")}
                  >{tf("installment.period_n", { n }, "{n} 期")}</button>
                ))}
              </div>
              {schedule && (
                <div className="flex flex-col gap-1 border-t pt-3 text-sm">
                  <div className="flex justify-between"><span>{t("installment.deposit", "首付（第 1 期）")}</span><span className="font-medium text-primary">{formatBase(schedule.deposit_amount_base)}</span></div>
                  <div className="flex justify-between text-muted-foreground"><span>{tf("installment.tail_each", { n: schedule.n - 1 }, "尾款每期")}</span><span>{formatBase(schedule.tail_each_base)}</span></div>
                  {schedule.last_amount_base !== schedule.tail_each_base && (
                    <div className="flex justify-between text-muted-foreground"><span>{tf("installment.tail_last", { n: schedule.n }, "第 {n} 期（末期内含差额）")}</span><span>{formatBase(schedule.last_amount_base)}</span></div>
                  )}
                  <p className="text-xs text-muted-foreground">{t("installment.checkout_note", "首付到账即发货，尾款按月支付、0 利息；分期不影响本单已选优惠。")}</p>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
        <p className="text-xs text-muted-foreground">
          {tf("checkout.currency_note", { code: currency }, "结算币种：{code}（跟随账号，注册时按区号自动确定）· 汇率按下单时刻快照锁定，后续变动不影响本单")}
        </p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="co-remark">{t("checkout.remark_label", "买家备注（选填，≤500 字）")}</Label>
          <textarea
            id="co-remark"
            rows={2}
            maxLength={500}
            className="rounded-md border bg-background px-3 py-2 text-sm"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder={t("checkout.remark_ph", "如：工作日送达、放前台")}
          />
        </div>
        <div className="flex flex-col gap-1 border-t pt-3 text-sm">
          <div className="flex justify-between"><span>{t("checkout.goods_amount", "商品金额")}</span><span>{formatBase(goodsBase)}</span></div>
          <div className="flex justify-between">
            <span className={vipActive ? "" : "text-muted-foreground"}>
              {t("checkout.vip_discount", "会员折扣")}{vipQuote ? tf("common.paren", { v: rateText(vipQuote.discount_rate) }, "（{v}）") : ""}
            </span>
            {vipQuote ? (
              <span className={vipActive ? "font-medium text-primary" : "text-muted-foreground"}>
                {vipActive ? `−${formatBase(vipQuote.discount_amount_base)}` : t("checkout.vip_no_stack", "与优惠券不叠加")}
              </span>
            ) : (
              <Link to="/me/vip" className="text-xs text-primary underline">{t("checkout.vip_open", "开通会员享折扣")}</Link>
            )}
          </div>
          <div className="flex justify-between">
            <span className={chosen ? "" : "text-muted-foreground"}>{t("checkout.coupon", "优惠券")}</span>
            <span className={chosen ? "font-medium text-primary" : "text-muted-foreground"}>
              {chosen ? `−${formatBase(chosen.deduction_amount_base)}` : (quote?.options.some((o) => o.usable) ? t("checkout.coupon_not_selected", "未选择") : t("checkout.coupon_no_usable", "无可用券"))}
            </span>
          </div>
          <div className="flex justify-between text-muted-foreground"><span>{t("checkout.freight", "运费")}</span><span>{formatBase(0)}</span></div>
          <div className="flex justify-between font-bold"><span>{t("checkout.payable", "应付")}</span><span className="text-primary">{money(Math.round((actualBase * rate) / 1e6), symbol)}</span></div>
          {chosen && (
            <div className="text-xs text-muted-foreground">
              {tf("checkout.basis_note", { name: pickLocalized(chosen.name_i18n, chosen.name, lang), amt: formatBase(actualBase) }, "已用「{name}」· 计价基准 {amt} · 汇率按下单时刻快照锁定")}
            </div>
          )}
          {vipQuote && !vipActive && (
            <div className="text-xs text-muted-foreground">{t("checkout.vip_stack_off", "后台已关闭「会员折扣 + 优惠券叠加」，本单按优惠券计价。")}</div>
          )}
        </div>
        {formError && <p className="text-sm text-destructive">{formError}</p>}
        {!orderOpen && <p className="text-sm text-destructive">{t("checkout.order_closed", "下单功能暂未开放，请联系客服。")}</p>}
        <div className="flex items-center gap-3">
          <Button
            onClick={() => { if (activeN !== null) onInstallmentSubmit(); else void submit(); }}
            disabled={submitting || !orderOpen || !lines.length || !pickedAddress}
          >
            {submitting ? t("common.submitting", "提交中…") : t("checkout.submit_order", "提交订单")}
          </Button>
          <Link to="/cart" className="text-sm text-muted-foreground underline">{t("checkout.back_cart", "返回购物车")}</Link>
        </div>
      </section>

      {profileOpen && (
        <InstallmentProfileModal
          initial={profileInitial}
          onClose={() => setProfileOpen(false)}
          onDone={(p) => {
            setProfile(p);
            setProfileOpen(false);
            setAgreed(false);
            setFormError("");
            setConfirmStep(true);
            window.scrollTo({ top: 0 });
          }}
        />
      )}
    </div>
  );
}
