// A5 内容页面后台：维护 site_config "pages"（关于我们/帮助/协议/隐私/退换货等静态长文）
// 整篇替换语义：保存时提交完整 slug->page 映射；正文纯文本，前台按段落渲染，不解析 HTML。
import { useEffect, useState } from "react";
import { ApiError, call, newIdem } from "../../api";
import { hrefFor } from "../../router";
import { useAdmin } from "../AdminAuth";
import { useSite } from "../../site";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { StaticPage } from "../../site";

interface Row { slug: string; title: string; body: string }
const SLUG_RE = /^[a-z0-9_-]{1,40}$/;
const MAX_PAGES = 20;

// 常见页给出建议 slug，方便站长一眼对齐前端约定（非强制，可自定义）
const SUGGESTIONS: { slug: string; label: string }[] = [
  { slug: "about", label: "关于我们" },
  { slug: "help", label: "帮助中心" },
  { slug: "terms", label: "用户协议" },
  { slug: "privacy", label: "隐私政策" },
  { slug: "returns", label: "退换货政策" },
];

export default function PagesPage() {
  const { config, refresh } = useSite();
  const { has } = useAdmin();
  const canEdit = has("content.manage");
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const pages = config?.pages ?? {};
    setRows(Object.entries(pages).map(([slug, p]) => ({ slug, title: p.title ?? "", body: p.body ?? "" })));
  }, [config?.pages]);

  function patchRow(i: number, patch: Partial<Row>) {
    setError(""); setOk("");
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i));
    setError(""); setOk("");
  }
  function addRow() {
    setRows((rs) => [...rs, { slug: "", title: "", body: "" }]);
    setError(""); setOk("");
  }

  async function save() {
    setBusy(true); setError(""); setOk("");
    const out: Record<string, StaticPage> = {};
    for (const r of rows) {
      const slug = r.slug.trim();
      if (!slug) { setError("每篇页面都要填写 slug（小写字母/数字/-/_）"); setBusy(false); return; }
      if (!SLUG_RE.test(slug)) { setError(`slug「${slug}」只允许小写字母 / 数字 / - / _`); setBusy(false); return; }
      if (out[slug]) { setError(`slug「${slug}」重复`); setBusy(false); return; }
      // 保留旧的多语言覆盖，只改默认（zh）标题与正文
      const prev = config?.pages?.[slug];
      out[slug] = {
        title: r.title.trim(),
        title_i18n: prev?.title_i18n ?? null,
        body: r.body,
        body_i18n: prev?.body_i18n ?? null,
        updated_at: new Date().toISOString(),
      };
    }
    try {
      await call("admin/page/save", { method: "POST", token: "admin", idem: newIdem(), body: { pages: out } });
      await refresh();
      setOk(`已保存 ${Object.keys(out).length} 篇页面，前台约 60 秒内刷新`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  if (!canEdit) return <p className="text-sm text-muted-foreground">当前账号缺少「内容管理（content.manage）」权限。</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold">内容页面</h1>
        <span className="text-xs text-muted-foreground">协议 / 隐私 / 关于 / 帮助等静态长文，正文为纯文本，保存即在页脚出现链接</span>
      </div>

      {rows.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.slug}
              type="button"
              disabled={!canEdit || rows.length >= MAX_PAGES}
              onClick={() => setRows((rs) => [...rs, { slug: s.slug, title: s.label, body: "" }])}
              className="border bg-background px-3 py-1.5 text-sm hover:border-primary disabled:opacity-50"
            >
              + {s.label}（{s.slug}）
            </button>
          ))}
        </div>
      )}

      {rows.map((r, i) => (
        <div key={i} className="flex flex-col gap-3 border-y border-border/70 py-4">
          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`slug-${i}`}>slug *</Label>
              <Input id={`slug-${i}`} value={r.slug} onChange={(e) => patchRow(i, { slug: e.target.value })} placeholder="about" maxLength={40} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`title-${i}`}>标题</Label>
              <Input id={`title-${i}`} value={r.title} onChange={(e) => patchRow(i, { title: e.target.value })} maxLength={60} />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`body-${i}`}>正文（空行分段）</Label>
            <textarea
              id={`body-${i}`}
              className="min-h-[160px] w-full border bg-background p-3 text-sm leading-6"
              value={r.body}
              maxLength={20000}
              onChange={(e) => patchRow(i, { body: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => removeRow(i)}>删除此页</Button>
            {r.slug && <a href={hrefFor(`/page?slug=${encodeURIComponent(r.slug)}`)} target="_blank" rel="noreferrer" className="text-xs text-primary underline">前台预览</a>}
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!canEdit || rows.length >= MAX_PAGES} onClick={addRow}>+ 新增空白页</Button>
        <Button size="sm" disabled={busy || !canEdit} onClick={() => void save()}>{busy ? "保存中…" : "保存全部"}</Button>
        <span className="text-xs text-muted-foreground">共 {rows.length} / {MAX_PAGES} 篇</span>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {ok && <p className="text-sm text-primary">{ok}</p>}
    </div>
  );
}
