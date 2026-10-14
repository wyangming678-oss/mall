// 分期购买个人信息弹窗：姓名/手机号/邮箱地址/详细住址 四项必填，判据与 functions/orders.mjs 同口径
import { useState, type FormEvent } from "react";
import { useSite } from "../site";
import type { InstallmentProfile } from "../trade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type { InstallmentProfile };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^[0-9+-]{5,20}$/;
type Field = keyof InstallmentProfile;
type Translator = (key: string, fallback?: string) => string;

export function installmentProfileError(p: InstallmentProfile, t: Translator): string | null {
  if (!p.name.trim()) return t("installment.err_name", "请填写姓名");
  if (!PHONE_RE.test(p.phone.trim())) return t("installment.err_phone", "手机号只能包含数字、+、-，长度 5–20");
  if (!EMAIL_RE.test(p.email.trim())) return t("installment.err_email", "请填写正确的邮箱地址");
  if (p.address.trim().length < 5) return t("installment.err_address", "详细住址至少 5 个字");
  return null;
}

const CELL = "flex flex-col gap-1";

export function InstallmentProfileModal({ initial, onClose, onDone }: {
  initial: InstallmentProfile;
  onClose: () => void;
  onDone: (profile: InstallmentProfile) => void;
}) {
  const { t } = useSite();
  const [draft, setDraft] = useState<InstallmentProfile>(initial);
  const [error, setError] = useState("");

  const set = (k: Field) => (e: { target: { value: string } }) => {
    setDraft((d) => ({ ...d, [k]: e.target.value }));
    setError("");
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    const invalid = installmentProfileError(draft, t);
    if (invalid) { setError(invalid); return; }
    onDone({
      name: draft.name.trim(),
      phone: draft.phone.trim(),
      email: draft.email.trim(),
      address: draft.address.trim(),
    });
  }

  return (
    <div
      role="dialog" aria-modal="true"
      aria-label={t("installment.info_modal_title", "分期购买需填写个人信息")}
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4 py-6"
    >
      <form onSubmit={submit} className="flex max-h-[86vh] w-full max-w-md flex-col gap-3 overflow-y-auto border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-semibold">{t("installment.info_modal_title", "分期购买需填写个人信息")}</p>
          <button type="button" onClick={onClose} aria-label={t("common.close", "关闭")}
            className="-mt-1 -mr-1 size-7 shrink-0 text-lg leading-7 text-muted-foreground hover:text-foreground">×</button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("installment.info_modal_intro", "分期订单需要留存本人的联系方式与住址，用于发货、对账与后续沟通；填完后进入确认页。")}</p>

        <div className={CELL}>
          <Label htmlFor="ifp-name">{t("installment.field_name", "姓名")} *</Label>
          <Input id="ifp-name" maxLength={30} value={draft.name} onChange={set("name")} />
        </div>
        <div className={CELL}>
          <Label htmlFor="ifp-phone">{t("installment.field_phone", "手机号")} *</Label>
          <Input id="ifp-phone" inputMode="tel" maxLength={20} value={draft.phone} onChange={set("phone")} placeholder="+8613800000000" />
        </div>
        <div className={CELL}>
          <Label htmlFor="ifp-email">{t("installment.field_email", "邮箱地址")} *</Label>
          <Input id="ifp-email" type="email" inputMode="email" maxLength={120} value={draft.email} onChange={set("email")} placeholder="name@example.com" />
        </div>
        <div className={CELL}>
          <Label htmlFor="ifp-address">{t("installment.field_address", "详细住址")} *</Label>
          <textarea
            id="ifp-address" rows={2} maxLength={200} value={draft.address} onChange={set("address")}
            placeholder={t("af.detail_ph", "街道、门牌号、楼层")}
            className="resize-none rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" size="sm">{t("installment.info_next", "下一步：确认")}</Button>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>{t("common.cancel", "取消")}</Button>
        </div>
      </form>
    </div>
  );
}
