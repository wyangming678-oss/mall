// A7 商品评价/评分（RV1 列表+汇总 / RV2 提交）：购物端商品详情页评价区
// 口径：一个用户对同一商品仅一条有效评价，再次提交即覆盖；仅展示后台审核通过（status=on）的评价。
import { useCallback, useEffect, useState } from "react";
import { call, newIdem } from "../api";
import { Link } from "../router";
import { useSite } from "../site";
import { fmtDate, shopErr, type ReviewItem, type ReviewListResult } from "../trade";

function Stars({ value, className = "", label }: { value: number; className?: string; label: string }) {
  return (
    <span className={"tabular-nums leading-none " + className} aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= Math.round(value) ? "text-primary" : "text-muted-foreground/40"}>★</span>
      ))}
    </span>
  );
}

export function ReviewSection({ productId }: { productId: string }) {
  const { user, t, tf } = useSite();
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [summary, setSummary] = useState<ReviewListResult["summary"] | null>(null);
  const [myReview, setMyReview] = useState<ReviewItem | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [rating, setRating] = useState(5);
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async (offset: number, append: boolean) => {
    setLoading(true);
    setError("");
    try {
      const r = await call<ReviewListResult>("review/list", {
        query: { product_id: productId, offset }, token: "user",
      });
      setItems((prev) => (append ? [...prev, ...r.items] : r.items));
      setSummary(r.summary);
      setMyReview(r.my_review);
      setHasMore(r.has_more);
    } catch (e: unknown) {
      setError(shopErr(e));
      if (!append) setItems([]);
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    setEditing(false);
    void load(0, false);
  }, [load]);

  function startEdit() {
    if (myReview) {
      setRating(myReview.rating);
      setContent(myReview.content);
    } else {
      setRating(5);
      setContent("");
    }
    setEditing(true);
    setNotice("");
  }

  async function submit() {
    if (submitting) return;
    if (rating < 1) { setNotice(t("review.pick_rating", "请先选择评分")); return; }
    setSubmitting(true);
    setNotice("");
    try {
      const r = await call<{ review: ReviewItem; created: boolean }>("review/submit", {
        method: "POST", token: "user", idem: newIdem(),
        body: { product_id: productId, rating, content },
      });
      setMyReview(r.review);
      setEditing(false);
      setNotice(r.created ? t("review.published", "评价已发布") : t("review.updated", "评价已更新"));
      void load(0, false);
    } catch (e: unknown) {
      setNotice(shopErr(e));
    } finally {
      setSubmitting(false);
    }
  }

  const total = summary?.count ?? 0;

  return (
    <section className="border-t border-border/70 pt-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="h-4 w-1 rounded-none bg-primary" />
          {t("review.title", "商品评价")}{total > 0 ? <span className="text-sm font-normal text-muted-foreground">{tf("common.paren", { v: total }, "（{v}）")}</span> : null}
        </h2>
        {user ? (
          myReview && !editing ? (
            <button type="button" onClick={startEdit} className="text-sm text-primary underline">{t("review.edit_mine", "修改我的评价")}</button>
          ) : null
        ) : (
          <Link to="/login" className="text-sm text-primary underline">{t("review.login_to_write", "登录后写评价")}</Link>
        )}
      </div>

      {summary && total > 0 && (
        <div className="mt-3 flex items-center gap-4">
          <div className="flex w-20 shrink-0 flex-col items-center border-r border-border/70 pr-4">
            <span className="text-3xl font-bold tabular-nums text-primary">{summary.avg_rating.toFixed(1)}</span>
            <Stars value={summary.avg_rating} className="text-sm" label={tf("review.aria_score", { n: summary.avg_rating.toFixed(1) }, "{n} 分")} />
            <span className="mt-0.5 text-xs text-muted-foreground">{tf("review.count_unit", { n: total }, "{n} 条")}</span>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {[5, 4, 3, 2, 1].map((star) => {
              const c = summary.distribution?.[String(star)] ?? 0;
              const pct = total ? Math.round((c / total) * 100) : 0;
              return (
                <div key={star} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="w-6 shrink-0 tabular-nums">{tf("review.star_count", { n: star }, "{n} 星")}</span>
                  <span className="h-1.5 flex-1 bg-muted">
                    <span className="block h-full bg-primary" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="w-8 shrink-0 text-right tabular-nums">{c}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {notice && (
        <p className="mt-3 border-l-2 border-primary bg-primary/10 px-3 py-2 text-sm text-foreground">{notice}</p>
      )}

      {user && editing && (
        <div className="mt-4 flex flex-col gap-3 border-t border-dashed border-border/70 pt-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{t("review.rating_label", "评分")}</span>
            <span className="flex gap-1 text-2xl leading-none">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRating(n)}
                  className={n <= rating ? "text-primary" : "text-muted-foreground/40"}
                  aria-label={tf("review.aria_set_rating", { n }, "评 {n} 分")}
                >★</button>
              ))}
            </span>
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value.slice(0, 500))}
            rows={3}
            maxLength={500}
            placeholder={t("review.placeholder", "说说使用感受，帮助其他买家参考（选填，最多 500 字）")}
            className="w-full resize-y border bg-card px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void submit()}
              className="brand-gradient rounded-none px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
            >{submitting ? t("common.submitting", "提交中…") : myReview ? t("review.save_edit", "保存修改") : t("review.publish", "发布评价")}</button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => setEditing(false)}
              className="rounded-none border bg-card px-5 py-2 text-sm text-muted-foreground disabled:opacity-60"
            >{t("common.cancel", "取消")}</button>
            <span className="text-xs text-muted-foreground">{content.length}/500</span>
          </div>
        </div>
      )}

      {error && <p className="mt-4 py-6 text-center text-sm text-destructive">{error}</p>}

      {!error && !loading && total === 0 && (
        <p className="mt-4 border-t border-border/70 py-8 text-center text-sm text-muted-foreground">
          {user ? t("review.empty_user", "还没有评价，抢第一个试用感受吧") : t("review.empty_login", "还没有评价，登录后即可发表第一条评价")}
        </p>
      )}

      {!error && items.length > 0 && (
        <ul className="mt-2 divide-y divide-border/70">
          {items.map((rv) => (
            <li key={rv.review_id} className="flex flex-col gap-1 py-4">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{rv.user_name}</span>
                <Stars value={rv.rating} className="text-sm" label={tf("review.aria_score", { n: rv.rating }, "{n} 分")} />
                {rv.verified && <span className="rounded-none bg-accent px-1.5 py-0.5 text-[11px] text-accent-foreground">{t("review.verified", "已购买")}</span>}
                <span className="ml-auto text-xs text-muted-foreground">{fmtDate(rv.created_at)}</span>
              </div>
              <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/90">{rv.content || t("review.no_text", "该用户未填写文字评价")}</p>
            </li>
          ))}
        </ul>
      )}

      {!error && hasMore && (
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(items.length, true)}
          className="mt-2 w-full border-t border-border/70 py-3 text-sm text-primary disabled:opacity-60"
        >{loading ? t("common.loading", "加载中…") : t("review.view_all", "查看全部评价")}</button>
      )}
    </section>
  );
}
