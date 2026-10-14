// 二级页「支付密码」：买家自助设置 / 修改 / 关闭（6–20 位数字）
// 设置后余额支付必须校验该密码；未设置则不拦。后台客服在用户抽屉里也能代设/代清（AU7）。
import { useState, type FormEvent } from "react";
import { call, newIdem } from "../api";
import { RedirectTo } from "../router";
import { useSite } from "../site";
import { CartLoading } from "../components/CartLoading";
import { SubHeader } from "../components/SubHeader";
import { useError } from "../account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PIN_RE = /^\d{6,20}$/;

export function PaymentPasswordPage() {
  const { user, ready, t, refresh } = useSite();
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, onError, clearError] = useError();

  if (!ready) return <div className="grid place-items-center py-14"><CartLoading label={t("me.loading", "正在加载账户信息…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  const isSet = user.has_payment_password === true;

  async function save(e: FormEvent) {
    e.preventDefault();
    clearError();
    setNotice("");
    if (isSet && !oldPin) { onError(t("me.pay_pw_old_required", "请输入原支付密码")); return; }
    if (!PIN_RE.test(newPin)) { onError(t("me.pay_pw_format", "支付密码需为 6–20 位数字")); return; }
    setBusy("save");
    try {
      await call("auth/payment-password", {
        method: "POST", token: "user", idem: newIdem(),
        body: isSet ? { old_payment_password: oldPin, payment_password: newPin } : { payment_password: newPin },
      });
      await refresh();
      setOldPin("");
      setNewPin("");
      setNotice(t("me.pay_pw_saved", "支付密码已保存"));
    } catch (err) {
      onError(err);
    } finally {
      setBusy("");
    }
  }

  async function disable() {
    clearError();
    setNotice("");
    if (!oldPin) { onError(t("me.pay_pw_old_required", "请输入原支付密码")); return; }
    setBusy("clear");
    try {
      await call("auth/payment-password", {
        method: "POST", token: "user", idem: newIdem(), body: { clear: true, old_payment_password: oldPin },
      });
      await refresh();
      setOldPin("");
      setNewPin("");
      setNotice(t("me.pay_pw_cleared", "支付密码已关闭，余额支付不再校验"));
    } catch (err) {
      onError(err);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5">
      <SubHeader title={t("me.pay_pw_title", "支付密码")} />

      <p className="flex flex-wrap items-baseline gap-2 border bg-muted/40 px-4 py-3 text-sm">
        <span>{t("me.pay_pw_status", "当前状态")}</span>
        <b className={isSet ? "text-primary" : "text-muted-foreground"}>
          {isSet ? t("me.pay_pw_on", "已设置") : t("me.pay_pw_off", "未设置")}
        </b>
      </p>
      <p className="text-xs text-muted-foreground">{t("me.pay_pw_hint", "设置后每次用余额付款都要输入该密码；未设置则不需要。忘记支付密码请联系客服。")}</p>

      <form className="flex flex-col gap-4" onSubmit={save}>
        {isSet && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="pp-old">{t("me.pay_pw_old", "原支付密码")}</Label>
            <Input id="pp-old" type="password" inputMode="numeric" autoComplete="current-password"
              value={oldPin} onChange={(e) => setOldPin(e.target.value)} maxLength={20} />
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="pp-new">{isSet ? t("me.pay_pw_new", "新支付密码（6–20 位数字）") : t("me.pay_pw_set", "设置支付密码（6–20 位数字）")}</Label>
          <Input id="pp-new" type="password" inputMode="numeric" autoComplete="new-password"
            value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/[^0-9]/g, ""))} maxLength={20} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {notice && <p className="text-sm text-primary">{notice}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" disabled={busy !== ""}>
            {isSet ? t("me.pay_pw_change_btn", "修改支付密码") : t("me.pay_pw_save_btn", "设置支付密码")}
          </Button>
          {isSet && (
            <Button type="button" variant="destructive" disabled={busy !== ""} onClick={() => void disable()}>
              {t("me.pay_pw_close_btn", "关闭支付密码")}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
