// 后台用户详情抽屉：资料/资金/支付密码/发券/定向弹窗 一站式（AU5–AU7 + 既有端点聚合）
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { call, newIdem } from "../../api";
import { formatBase } from "../../const";
import { couponRuleText } from "../../trade";
import { coinText } from "../../coins";
import { buildE164, prettyE164, splitE164 } from "../../phone";
import { DialPhoneInput } from "../../components/DialPhoneInput";
import { useAdmin } from "../AdminAuth";
import { useSite } from "../../site";
import { errText, isConfirmCancel, riskyPost, useBusy } from "../ui";
import type { CouponTemplateRow, Paged, UserRow } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

const PIN_RE = /^\d{6,20}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isoInDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b p-4">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="min-w-0 break-all text-right">{v}</span>
    </div>
  );
}

export default function UserDrawer({ user, onClose, onChanged }: {
  user: UserRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { has } = useAdmin();
  const { config } = useSite();
  const [busy, run] = useBusy();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 资料编辑
  const [nickname, setNickname] = useState(user.nickname ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [phoneDial, setPhoneDial] = useState(() => splitE164(user.phone).dial);
  const [phoneNational, setPhoneNational] = useState(() => splitE164(user.phone).national);

  // 支付密码
  const [pin, setPin] = useState("");

  // 发券
  const [templates, setTemplates] = useState<CouponTemplateRow[]>([]);
  const [tplId, setTplId] = useState("");
  const [seq, setSeq] = useState("0");

  // 定向弹窗
  const [popTitle, setPopTitle] = useState("");
  const [popContent, setPopContent] = useState("");
  const [popDays, setPopDays] = useState("7");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canGrant = has("coupon.grant");
  useEffect(() => {
    if (!canGrant) return;
    call<Paged<CouponTemplateRow>>("admin/coupon-templates", { token: "admin", query: { status: "on" } })
      .then((r) => {
        setTemplates(r.items);
        const first = r.items.find((t) => t.status === "on");
        if (first) setTplId((cur) => cur || first.id);
      })
      .catch(() => undefined);
  }, [canGrant]);

  const canPop = has("content.manage") && has("content.publish");
  const canIp = has("user.ip_view");
  const canCoinAdjust = config?.switches?.coins === true && has("coin.adjust");

  function flash(msg: string) { setNotice(msg); setError(""); }
  function fail2(e: unknown) {
    if (isConfirmCancel(e)) return;
    setNotice("");
    setError(errText(e));
  }

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    const nick = nickname.trim();
    if (!nick) { setError("昵称不能为空"); return; }
    const em = email.trim();
    if (em && !EMAIL_RE.test(em)) { setError("邮箱格式不正确"); return; }
    const national = phoneNational.trim();
    let phoneOut: string | null = null;
    if (national) {
      const built = buildE164(phoneDial, national);
      if (built.error) { setError(built.error); return; }
      phoneOut = built.value ?? null;
    }
    const body: Record<string, unknown> = { user_id: user.id };
    if (nick !== user.nickname) body.nickname = nick;
    if (em !== (user.email ?? "")) body.email = em;
    if ((phoneOut ?? "") !== (user.phone ?? "")) body.phone = phoneOut ?? "";
    if (Object.keys(body).length === 1) { setError("未检测到资料变更"); return; }
    setError("");
    await run(async () => {
      try {
        await call("admin/user/update", { method: "POST", token: "admin", idem: newIdem(), body });
        flash("资料已保存");
        onChanged();
      } catch (err) { fail2(err); }
    });
  }

  async function toggleStatus() {
    const to = user.status === "active" ? "disabled" : "active";
    await riskyPost("admin/user/status", { user_id: user.id, status: to }, `${to === "disabled" ? "禁用" : "启用"}用户 ${user.username}`)
      .then(() => { flash(`已${to === "disabled" ? "禁用" : "启用"}`); onChanged(); })
      .catch(fail2);
  }

  async function adjustBalance() {
    const raw = window.prompt(`调整 ${user.username} 的余额：变动金额（分，正入账 / 负扣减）。当前 ${formatBase(user.balance)}`);
    if (raw === null) return;
    const delta = Number(raw.trim());
    if (!Number.isInteger(delta) || delta === 0) { setError("请输入非 0 的整数金额（单位：分）"); return; }
    const remark = window.prompt("调整备注（至少 2 字，写入钱包流水与审计）");
    if (!remark || remark.trim().length < 2) { setError("备注至少 2 个字，未提交"); return; }
    setError("");
    await riskyPost<{ balance_before: number; balance_after: number }>(
      "admin/user/balance-adjust", { user_id: user.id, delta, remark: remark.trim() },
      `调整用户 ${user.username} 余额 ${delta > 0 ? "+" : ""}${delta} 分`)
      .then((r) => { flash(`已调整：${formatBase(r.balance_before)} → ${formatBase(r.balance_after)}`); onChanged(); })
      .catch(fail2);
  }

  async function adjustCoins() {
    const raw = window.prompt(`调整 ${user.username} 的金币：变动数量（正入账 / 负扣减，不可为 0）`);
    if (raw === null) return;
    const amount = Number(raw.trim());
    if (!Number.isInteger(amount) || amount === 0) { setError("请输入非 0 的整数金币数"); return; }
    const reason = window.prompt("调整原因（至少 2 字，写入金币流水与审计）");
    if (!reason || reason.trim().length < 2) { setError("原因至少 2 个字，未提交"); return; }
    setError("");
    await riskyPost<{ before: number; after: number }>(
      "admin/user/coin-adjust", { user_id: user.id, amount, reason: reason.trim() },
      `调整用户 ${user.username} 金币 ${amount > 0 ? "+" : ""}${amount}`)
      .then((r) => { flash(`金币已调整：${coinText(r.before)} → ${coinText(r.after)}`); onChanged(); })
      .catch(fail2);
  }

  async function resetLoginPassword() {
    const pwd = window.prompt(`为用户 ${user.username} 设置新登录密码（至少 8 位，将退出其全部会话）`);
    if (!pwd) return;
    await riskyPost("admin/user/password-reset", { user_id: user.id, password: pwd }, `重置用户 ${user.username} 的登录密码`)
      .then(() => flash("登录密码已重置"))
      .catch(fail2);
  }

  async function setPaymentPassword() {
    if (!PIN_RE.test(pin)) { setError("支付密码需为 6–20 位数字"); return; }
    setError("");
    await riskyPost("admin/user/payment-password", { user_id: user.id, payment_password: pin }, `设置用户 ${user.username} 的支付密码`)
      .then(() => { setPin(""); flash("支付密码已设置"); onChanged(); })
      .catch(fail2);
  }

  async function clearPaymentPassword() {
    await riskyPost("admin/user/payment-password", { user_id: user.id, clear: true }, `清除用户 ${user.username} 的支付密码`)
      .then(() => { setPin(""); flash("支付密码已清除"); onChanged(); })
      .catch(fail2);
  }

  async function grantCoupon() {
    if (!tplId) { setError("请选择发放中的券模板"); return; }
    setError("");
    await riskyPost<{ granted: boolean; duplicated: boolean }>(
      "admin/user/coupon-grant", { user_id: user.id, template_id: tplId, seq: Number(seq) || 0 },
      `向用户 ${user.username} 发放优惠券`)
      .then((r) => { flash(r.duplicated ? "此前已发放（幂等命中）" : "优惠券已发放"); onChanged(); })
      .catch(fail2);
  }

  async function sendPopup() {
    const title = popTitle.trim();
    const content = popContent.trim();
    if (!title || title.length > 200) { setError("标题需为 1–200 字"); return; }
    if (!content || content.length > 2000) { setError("正文需为 1–2000 字"); return; }
    const days = Number(popDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) { setError("有效天数需为 1–3650 的整数"); return; }
    setError("");
    await run(async () => {
      try {
        const saved = await call<{ announcement_id: string }>("admin/announcement/save", {
          method: "POST", token: "admin", idem: newIdem(),
          body: { scope: "popup", target_user_id: user.id, title, content, expire_at: isoInDays(days) },
        });
        await riskyPost("admin/announcement/publish", { announcement_id: saved.announcement_id }, `向用户 ${user.username} 定向发布公告`);
        setPopTitle(""); setPopContent("");
        flash("已定向发布（该用户首页弹窗 + 站内信各一条）");
      } catch (err) { fail2(err); }
    });
  }

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`用户 ${user.username} 详情`}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l bg-background">
        <header className="flex items-center justify-between gap-2 border-b p-4">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold">{user.username}</p>
            <p className="truncate text-xs text-muted-foreground">{user.nickname || "—"}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="关闭">关闭</Button>
        </header>

        {(error || notice) && (
          <div className="border-b px-4 py-2 text-sm">
            {error ? <p className="text-destructive">{error}</p> : <p className="text-primary">{notice}</p>}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          <Section title="概览">
            <KV k="状态" v={<Badge variant={user.status === "active" ? "secondary" : "destructive"}>{user.status === "active" ? "正常" : "禁用"}</Badge>} />
            <KV k="余额" v={<span className="tabular-nums">{formatBase(user.balance)}（{user.currency_code}）</span>} />
            <KV k="手机号" v={<span className="font-mono text-xs">{user.phone ? prettyE164(user.phone) : "—"}</span>} />
            <KV k="语言" v={user.language} />
            <KV k="邀请码" v={<span className="font-mono">{user.invite_code}</span>} />
            <KV k="未用券" v={user.coupon_unused ?? 0} />
            <KV k="注册时间" v={user.created_at?.slice(0, 10) ?? "—"} />
            {canIp && <KV k="注册 IP" v={<span className="font-mono text-xs">{user.register_ip ?? "—"}</span>} />}
            {canIp && <KV k="最近登录" v={<span className="font-mono text-xs">{user.last_login_ip ?? "—"}{user.last_login_at ? ` · ${user.last_login_at.slice(5, 16).replace("T", " ")}` : ""}</span>} />}
          </Section>

          {has("user.edit") && (
            <Section title="资料编辑">
              <form className="flex flex-col gap-3" onSubmit={saveProfile}>
                <Field label="昵称">
                  <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={30} />
                </Field>
                <Field label="邮箱（留空清除）">
                  <Input value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} placeholder="name@example.com" />
                </Field>
                <Field label="号码（留空清除，选区号后填国内号码）">
                  <DialPhoneInput idNum="ud-phone" dial={phoneDial} national={phoneNational} onDial={setPhoneDial} onNational={setPhoneNational} autoComplete="off" />
                </Field>
                <Button type="submit" size="sm" disabled={busy}>保存资料</Button>
              </form>
            </Section>
          )}

          <Section title="资金 / 凭证">
            <div className="flex flex-wrap gap-2">
              {has("user.balance_adjust") && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void adjustBalance()}>余额调整</Button>
              )}
              {has("user.reset_password") && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void resetLoginPassword()}>重置登录密码</Button>
              )}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggleStatus()}>
                {user.status === "active" ? "禁用账号" : "启用账号"}
              </Button>
            </div>
          </Section>

          {canCoinAdjust && (
            <Section title="金币（独立账本，与余额无关）">
              <p className="text-xs text-muted-foreground">
                手动增减该用户金币：正数入账、负数扣减，扣减不可使余额为负。变动会写入金币流水与审计日志。
              </p>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void adjustCoins()}>金币调整</Button>
            </Section>
          )}

          {has("user.reset_password") && (
            <Section title="支付密码">
              <p className="text-xs text-muted-foreground">
                当前状态：<span className={user.has_payment_password ? "text-primary" : ""}>{user.has_payment_password ? "已设置" : "未设置"}</span>。
                该用户用余额付款时会校验此密码；买家也可在购物端「我的 → 支付密码」自行修改或关闭，此处可代为设置或清除。
              </p>
              <Field label="新支付密码（6–20 位数字）">
                <Input value={pin} onChange={(e) => setPin(e.target.value)} maxLength={20} inputMode="numeric" placeholder="仅数字" />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy || !pin} onClick={() => void setPaymentPassword()}>设置 / 更新</Button>
                {user.has_payment_password && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void clearPaymentPassword()}>清除</Button>
                )}
              </div>
            </Section>
          )}

          {canGrant && (
            <Section title="发放优惠券">
              <Field label="券模板（发放中）">
                {templates.some((t) => t.status === "on") ? (
                  <select className="h-9 w-full border bg-background px-2 text-sm" value={tplId} onChange={(e) => setTplId(e.target.value)}>
                    {templates.filter((t) => t.status === "on").map((t) => (
                      <option key={t.id} value={t.id}>{t.name}（{couponRuleText(t)}）</option>
                    ))}
                  </select>
                ) : (
                  <p className="text-xs text-muted-foreground">没有「发放中」的券模板，请先在优惠券页开始发放。</p>
                )}
              </Field>
              <Field label="批次号（同人同批次重复提交不重复发券）">
                <Input className="w-24" type="number" min={0} max={999} value={seq} onChange={(e) => setSeq(e.target.value)} />
              </Field>
              <Button size="sm" disabled={busy || !tplId} onClick={() => void grantCoupon()}>发放给该用户</Button>
            </Section>
          )}

          {canPop && (
            <Section title="定向弹窗公告">
              <p className="text-xs text-muted-foreground">仅对该用户生效：其首页弹出一次 + 消息中心收到一条站内信。</p>
              <Field label="标题">
                <Input value={popTitle} onChange={(e) => setPopTitle(e.target.value)} maxLength={200} />
              </Field>
              <Field label="正文">
                <textarea
                  className="min-h-20 w-full border bg-background p-2 text-sm"
                  value={popContent} onChange={(e) => setPopContent(e.target.value)} maxLength={2000}
                />
              </Field>
              <Field label="有效天数">
                <Input className="w-24" type="number" min={1} max={3650} value={popDays} onChange={(e) => setPopDays(e.target.value)} />
              </Field>
              <Button size="sm" disabled={busy} onClick={() => void sendPopup()}>编辑并发布</Button>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
