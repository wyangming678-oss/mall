// 二级页头部：左上角「←」返回上一级（默认「我的」），标题同行，底部发丝分隔线（扁平直角，无阴影）
import { type ReactNode } from "react";
import { Link } from "../router";
import { useSite } from "../site";

export function SubHeader({ title, back = "/me", extra }: { title: string; back?: string; extra?: ReactNode }) {
  const { t } = useSite();
  return (
    <header className="flex items-center gap-2.5 border-b pb-3">
      <Link
        to={back}
        aria-label={t("common.back", "返回")}
        className="grid size-8 shrink-0 place-items-center border bg-card text-primary hover:bg-accent"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </Link>
      <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h1>
      {extra ? <div className="flex shrink-0 items-center gap-3 text-sm">{extra}</div> : null}
    </header>
  );
}
