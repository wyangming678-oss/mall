// A5 静态内容页渲染 /page?slug=：正文取 site_config.pages（bootstrap 已带），纯文本按段落渲染，不解析 HTML
import { Link, useQuery } from "../router";
import { useSite } from "../site";
import { CartLoading } from "../components/CartLoading";
import { pickLocalized } from "../const";
import type { StaticPage } from "../site";

export function resolvePage(pages: Record<string, StaticPage> | undefined, slug: string, lang: string) {
  const p = pages?.[slug];
  if (!p) return null;
  return { slug, title: pickLocalized(p.title_i18n, p.title, lang), body: pickLocalized(p.body_i18n, p.body, lang) };
}

export function PageView() {
  const { config, lang, ready, t } = useSite();
  const query = useQuery();
  const slug = query.slug ?? "";

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("common.loading", "正在加载…")} /></div>;

  const page = resolvePage(config?.pages, slug, lang);
  if (!page) {
    return (
      <div className="mx-auto grid max-w-3xl place-items-center gap-3 px-4 py-16 text-center">
        <p className="text-sm text-muted-foreground">{slug ? t("page.not_found", "该页面不存在或尚未发布内容") : t("page.missing_slug", "缺少页面标识")}</p>
        <Link to="/" className="rounded-md brand-gradient px-5 py-1.5 text-sm font-medium text-white">{t("common.back_home", "返回首页")}</Link>
      </div>
    );
  }

  const paragraphs = page.body.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
      <h1 className="text-xl font-bold">{page.title || t("page.default_title", "内容页面")}</h1>
      <article className="flex flex-col gap-3 text-sm leading-7 text-foreground">
        {paragraphs.length ? (
          paragraphs.map((para, i) => <p key={i} className="whitespace-pre-wrap">{para}</p>)
        ) : (
          <p className="text-muted-foreground">{t("page.empty", "该页面暂无内容。")}</p>
        )}
      </article>
    </div>
  );
}
