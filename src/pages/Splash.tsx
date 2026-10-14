// 开屏动画：每次浏览会话进入站点时播放一次（sessionStorage 记录）
// 活动皮肤可替换为开屏海报（splash_poster.enabled）；关闭时回落品牌动画
import { useEffect, useState } from "react";
import { useSite } from "../site";
import { Link } from "../router";
import { useAssetUrl, useBrandLogoUrl } from "../components/BrandMark";

export const SPLASH_SHOWN_KEY = "mall.splash.shown";

export function Splash() {
  const { config, campaign, t } = useSite();
  const logoUrl = useBrandLogoUrl(config?.brand?.logo_key);
  const poster = campaign?.posters?.splash_poster;
  const posterUrl = useAssetUrl(poster?.enabled ? poster.image_key : null);
  const [visible, setVisible] = useState(() => {
    try { return sessionStorage.getItem(SPLASH_SHOWN_KEY) !== "1"; } catch { return false; }
  });
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => dismiss(), posterUrl ? 3600 : 2000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function dismiss() {
    try { sessionStorage.setItem(SPLASH_SHOWN_KEY, "1"); } catch { /* 忽略隐私模式异常 */ }
    setLeaving(true);
    window.setTimeout(() => setVisible(false), 380);
  }

  if (!visible) return null;
  const name = config?.brand?.site_name ?? "ChicCart";

  // 开屏海报：整屏图片、可点跳转；未启用/无图时不渲染海报，走下方品牌动画
  if (poster?.enabled && posterUrl) {
    const img = <img src={posterUrl} alt={t("splash.poster_alt", "活动开屏")} className="size-full object-cover" />;
    return (
      <div
        className={"fixed inset-0 z-50 bg-black transition-opacity duration-300 " + (leaving ? "pointer-events-none opacity-0" : "opacity-100")}
        onClick={dismiss}
        role="presentation"
      >
        {poster.link ? <Link to={poster.link} onClick={dismiss} className="block size-full">{img}</Link> : img}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); dismiss(); }}
          className="absolute right-4 top-4 rounded-full bg-black/45 px-3 py-1 text-xs text-white"
        >
          {t("splash.skip", "跳过")}
        </button>
      </div>
    );
  }

  return (
    <div
      className={
        "fixed inset-0 z-50 flex flex-col items-center justify-center brand-gradient transition-opacity duration-300 " +
        (leaving ? "opacity-0 pointer-events-none" : "opacity-100")
      }
      onClick={dismiss}
      role="presentation"
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <span className="absolute left-[12%] top-[18%] size-24 rounded-full bg-white/15 animate-float-slow" />
        <span className="absolute right-[15%] top-[30%] size-16 rounded-full bg-white/10 animate-float-slow [animation-delay:1.2s]" />
        <span className="absolute bottom-[20%] left-[24%] size-10 rounded-full bg-white/15 animate-float-slow [animation-delay:2.1s]" />
        <span className="absolute bottom-[28%] right-[20%] size-32 rounded-full bg-white/10 animate-float-slow [animation-delay:0.6s]" />
      </div>

      <div className="relative flex flex-col items-center gap-6 px-6">
        <div className="relative grid size-24 place-items-center">
          <span className="absolute inset-0 rounded-3xl bg-white/30 animate-brand-ring" />
          <div className="grid size-24 animate-pop-in place-items-center overflow-hidden rounded-3xl bg-white shadow-xl">
            {logoUrl
              ? <img src={logoUrl} alt="" className="size-full object-contain p-2" />
              : <span className="text-4xl font-black text-primary">{name.charAt(0)}</span>}
          </div>
        </div>
        <div className="animate-fade-up text-center [animation-delay:0.35s]">
          <h1 className="text-3xl font-bold text-white drop-shadow-sm">{name}</h1>
          <p className="mt-2 text-sm text-white/85">{t("auth.tagline", "好物，从这里开始")}</p>
        </div>
        <div className="mt-2 h-1 w-40 overflow-hidden rounded-full bg-white/25">
          <div className="h-full w-full hero-shine bg-white/60" />
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); dismiss(); }}
          className="mt-2 rounded-md bg-white/90 px-6 py-2 text-sm font-medium text-secondary shadow-md transition hover:bg-white animate-fade-up [animation-delay:0.7s]"
        >
          {t("splash.enter", "进入商城")}
        </button>
      </div>
    </div>
  );
}
