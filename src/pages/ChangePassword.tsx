// 二级页「修改密码」：改密成功后清本地会话并跳登录（后端会踢掉其他设备）
import { useState, type FormEvent } from "react";
import { call, newIdem, tokenStore } from "../api";
import { navigate, RedirectTo } from "../router";
import { useSite } from "../site";
import { CartLoading } from "../components/CartLoading";
import { SubHeader } from "../components/SubHeader";
import { useError } from "../account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ChangePasswordPage() {
  const { user, ready, t } = useSite();
  const [pw, setPw] = useState({ old_password: "", new_password: "" });
  const [busy, setBusy] = useState(false);
  const [error, onError, clearError] = useError();

  if (!ready) return <div className="grid place-items-center py-14"><CartLoading label={t("me.loading", "正在加载账户信息…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    clearError();
    try {
      await call("auth/change-password", { method: "POST", token: "user", idem: newIdem(), body: pw });
      tokenStore.user.set(null);
      navigate("/login");
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5">
      <SubHeader title={t("me.change_pw_title", "修改密码")} />

      <form className="flex flex-col gap-4" onSubmit={changePassword}>
        <div className="flex flex-col gap-1">
          <Label htmlFor="me-op">{t("me.old_pw", "原密码")}</Label>
          <Input id="me-op" type="password" value={pw.old_password} onChange={(e) => setPw((p) => ({ ...p, old_password: e.target.value }))} required />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="me-np">{t("me.new_pw", "新密码（至少 8 位）")}</Label>
          <Input id="me-np" type="password" value={pw.new_password} onChange={(e) => setPw((p) => ({ ...p, new_password: e.target.value }))} required minLength={8} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" variant="outline" disabled={busy}>{t("me.change_pw_btn", "修改密码（其他设备将退出登录）")}</Button>
      </form>
    </div>
  );
}
