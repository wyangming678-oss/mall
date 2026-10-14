// 品牌加载动画：购物车摇摆 + 三点落入
import { useSite } from "../site";
export function CartLoading({ label, size = 64 }: { label?: string; size?: number }) {
  const { t } = useSite();
  const text = label ?? t("common.loading", "加载中…");
  return (
    <div className="flex flex-col items-center gap-2 text-primary" role="status" aria-live="polite">
      <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
        <g className="animate-dot-fall" style={{ transformOrigin: "26px 8px" }}>
          <circle cx="26" cy="8" r="3" fill="currentColor" />
        </g>
        <g className="animate-dot-fall [animation-delay:0.2s]" style={{ transformOrigin: "36px 8px" }}>
          <circle cx="36" cy="8" r="3" fill="currentColor" opacity="0.8" />
        </g>
        <g className="animate-dot-fall [animation-delay:0.4s]" style={{ transformOrigin: "46px 8px" }}>
          <circle cx="46" cy="8" r="3" fill="currentColor" opacity="0.6" />
        </g>
        <g className="animate-cart-sway" style={{ transformOrigin: "34px 40px" }}>
          <path d="M6 8h7l5.5 26.2a3 3 0 0 0 2.9 2.3h21.4a3 3 0 0 0 2.9-2.2L50 20H19" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="25" cy="51" r="4" stroke="currentColor" strokeWidth="3.5" />
          <circle cx="44" cy="51" r="4" stroke="currentColor" strokeWidth="3.5" />
        </g>
      </svg>
      {text && <p className="text-sm text-muted-foreground">{text}</p>}
    </div>
  );
}
