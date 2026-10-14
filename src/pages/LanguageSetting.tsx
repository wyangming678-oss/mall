// 二级页「界面语言」：四语切换，登录后偏好同步到账号
import { RedirectTo } from "../router";
import { useSite } from "../site";
import { CartLoading } from "../components/CartLoading";
import { LanguagePicker } from "../components/LanguagePicker";
import { SubHeader } from "../components/SubHeader";

export function LanguageSettingPage() {
  const { user, ready, t } = useSite();
  if (!ready) return <div className="grid place-items-center py-14"><CartLoading label={t("me.loading", "正在加载账户信息…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5">
      <SubHeader title={t("me.language", "界面语言")} />
      <LanguagePicker />
      <p className="text-xs text-muted-foreground">{t("me.language_hint", "切换后自动同步到账号，换设备登录自动跟随。")}</p>
    </div>
  );
}
