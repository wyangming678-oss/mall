// 二级页「编辑资料」：头像 / 昵称 / 邮箱 / 手机号（区号 + 国内号码归一为 E.164）
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { call, newIdem, uploadImageKey } from "../api";
import { RedirectTo } from "../router";
import { useSite } from "../site";
import { buildE164, dialLabel, splitE164 } from "../phone";
import { useAssetUrl } from "../components/BrandMark";
import { CartLoading } from "../components/CartLoading";
import { DialPhoneInput } from "../components/DialPhoneInput";
import { SubHeader } from "../components/SubHeader";
import { useError } from "../account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ProfileDraft {
  nickname: string;
  email: string;
  avatar_key: string | null;
  phone_dial: string;
  phone_national: string;
}

export function ProfileEditPage() {
  const { user, ready, refresh, t, tf, lang } = useSite();
  const [profile, setProfile] = useState<ProfileDraft>({ nickname: "", email: "", avatar_key: null, phone_dial: "86", phone_national: "" });
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [error, onError, clearError] = useError();
  const [notice, setNotice] = useState("");
  const avatarPreviewUrl = useAssetUrl(profile.avatar_key);

  useEffect(() => {
    if (!user) return;
    const { dial, national } = splitE164(user.phone);
    setProfile({ nickname: user.nickname, email: user.email ?? "", avatar_key: user.avatar_key, phone_dial: dial, phone_national: national });
  }, [user]);

  if (!ready) return <div className="grid place-items-center py-14"><CartLoading label={t("me.loading", "正在加载账户信息…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  async function pickAvatar(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAvatarBusy(true);
    clearError();
    setNotice("");
    try {
      const key = await uploadImageKey(file, "avatars", "user");
      setProfile((p) => ({ ...p, avatar_key: key }));
    } catch (err) {
      onError(err);
    } finally {
      setAvatarBusy(false);
    }
  }

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    clearError();
    setNotice("");
    // 手机号：空串=清空；非空则走区号+E.164 归一
    let phoneVal: string | null = null;
    if (profile.phone_national.trim()) {
      const built = buildE164(profile.phone_dial, profile.phone_national);
      if (built.error) {
        onError(built.errorKey ? tf(built.errorKey, { label: dialLabel(profile.phone_dial, lang) }, built.error) : built.error);
        setBusy(false);
        return;
      }
      phoneVal = built.value ?? null;
    }
    try {
      await call("auth/profile", {
        method: "POST", token: "user", idem: newIdem(),
        body: {
          nickname: profile.nickname,
          email: profile.email.trim() || null,
          avatar_key: profile.avatar_key,
          phone: phoneVal,
        },
      });
      await refresh();
      setNotice(t("me.profile_updated", "资料已更新"));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5">
      <SubHeader title={t("me.edit_title", "编辑资料")} />

      <form className="flex flex-col gap-4" onSubmit={saveProfile}>
        <div className="flex flex-col gap-2">
          <Label>{t("me.avatar", "头像")}</Label>
          <div className="flex flex-wrap items-center gap-3">
            <div className="grid size-16 shrink-0 place-items-center overflow-hidden border bg-muted">
              {avatarPreviewUrl ? (
                <img src={avatarPreviewUrl} alt="" className="size-full object-cover" />
              ) : (
                <span className="text-2xl font-black text-primary">{(profile.nickname || user.username).charAt(0)}</span>
              )}
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 border bg-background px-3 py-1.5 text-sm hover:bg-accent">
              <input type="file" accept="image/*" className="sr-only" onChange={(e) => void pickAvatar(e)} disabled={avatarBusy} />
              {avatarBusy ? t("me.avatar_uploading", "上传中…") : t("me.avatar_pick", "选择图片")}
            </label>
            {profile.avatar_key && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setProfile((p) => ({ ...p, avatar_key: null }))}>{t("me.avatar_remove", "移除")}</Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t("me.avatar_hint", "支持 JPG/PNG，保存资料后生效。")}</p>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="me-n">{t("me.nickname", "昵称")}</Label>
          <Input id="me-n" value={profile.nickname} onChange={(e) => setProfile((p) => ({ ...p, nickname: e.target.value }))} maxLength={30} />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="me-email">{t("me.email", "邮箱")}</Label>
          <Input id="me-email" type="email" value={profile.email} onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))} maxLength={120} placeholder={t("me.email_ph", "用于找回密码与订单通知，可留空")} />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="me-phone">{t("me.phone", "手机号")}</Label>
          <DialPhoneInput idNum="me-phone" dial={profile.phone_dial} national={profile.phone_national} onDial={(v) => setProfile((p) => ({ ...p, phone_dial: v }))} onNational={(v) => setProfile((p) => ({ ...p, phone_national: v }))} />
          <p className="text-xs text-muted-foreground">{t("me.phone_hint", "清空后保存即取消绑定；他人已占用的号码会返回冲突提示。")}</p>
        </div>

        {notice && <p className="text-sm text-primary">{notice}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || avatarBusy}>{t("me.save_profile", "保存资料")}</Button>
      </form>
    </div>
  );
}
