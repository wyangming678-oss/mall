import { useEffect, useState } from "react";
import { Link } from "../router";
import { formatBase, pickLocalized } from "../const";
import { brandText } from "../tagL10n";
import { useSite } from "../site";
import { useAssetUrl } from "./BrandMark";
import type { ProductItem } from "../catalog";

export function ProductCover({ imageKey, alt, className = "size-full object-cover" }: {
  imageKey: string | null | undefined; alt: string; className?: string;
}) {
  const url = useAssetUrl(imageKey ?? null);
  // 地址有效但对象已被删/签名已过期时，同样回落占位图，不留浏览器裂图
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  if (!url || broken) {
    return (
      <span className="grid size-full place-items-center text-muted-foreground/40" aria-hidden>
        <svg viewBox="0 0 24 24" className="size-8" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M6 8h12l-1 12H7L6 8Z" strokeLinejoin="round" />
          <path d="M9 8V6a3 3 0 0 1 6 0v2" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return <img src={url} alt={alt} className={className} loading="lazy" onError={() => setBroken(true)} />;
}

export function ProductCard({ item }: { item: ProductItem }) {
  const { t, tf, lang } = useSite();
  const title = pickLocalized(item.title_i18n, item.title, lang);
  const subtitle = pickLocalized(item.subtitle_i18n, item.subtitle ?? "", lang);
  const soldOut = item.total_stock <= 0;
  const inst = item.installment?.enabled ? item.installment : null;
  const rating = typeof item.rating_avg === "number" && item.rating_avg > 0 ? item.rating_avg : null;
  const sold = Number(item.sold_total ?? 0);
  return (
    <Link to={`/product?id=${item.id}`} className="group flex flex-col">
      <div className="relative aspect-square overflow-hidden bg-muted">
        <ProductCover imageKey={item.images[0]} alt={title} className="size-full object-cover transition group-hover:scale-[1.03]" />
        {inst && (
          <span className="absolute left-0 top-0 bg-primary px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground">
            {t("installment.card_tag", "支持分期")}
          </span>
        )}
        {soldOut && (
          <span className="absolute inset-x-0 bottom-0 bg-foreground/75 py-0.5 text-center text-xs text-background">{t("card.sold_out", "暂时缺货")}</span>
        )}
      </div>
      <div className="flex flex-col gap-1 py-2">
        {item.brand && <p className="truncate text-xs font-medium text-primary/80">{brandText(item.brand, lang)}</p>}
        <p className="line-clamp-2 min-h-[2.5em] text-sm font-medium leading-tight">{title}</p>
        {subtitle && <p className="line-clamp-1 text-xs text-muted-foreground">{subtitle}</p>}
        <div className="mt-1 flex min-w-0 items-baseline justify-between gap-1">
          <span className="shrink-0 text-base font-bold text-primary">{item.min_price === null ? "—" : formatBase(item.min_price)}</span>
          {item.category_name && <span className="min-w-0 shrink truncate text-right text-xs text-muted-foreground">{pickLocalized(item.category_name_i18n, item.category_name, lang)}</span>}
        </div>
        {(rating !== null || sold > 0) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            {rating !== null && (
              <span className="flex items-center gap-0.5 text-primary">
                <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden><path d="M12 3l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.2l5.9-.8L12 3z" /></svg>
                {rating.toFixed(1)}
                {item.rating_count ? tf("card.rating_n", { n: item.rating_count }, "({n})") : ""}
              </span>
            )}
            {sold > 0 && <span>{tf("card.sold_n", { n: sold }, "已售 {n}")}</span>}
          </div>
        )}
      </div>
    </Link>
  );
}
