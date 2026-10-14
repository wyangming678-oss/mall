// 消息中心（整体逻辑 §一：/me/messages；文档C NT1 notify/list + notify/read）
// 消息由状态机副作用产生，页面只提供读取与已读；版式扁平直角，行与行靠细分隔线区分
import { useCallback, useEffect, useState } from "react";
import { call, newIdem } from "../api";
import { text } from "../i18n";
import { notifyTitle, notifyContent } from "../notify-text";
import { Link, RedirectTo } from "../router";
import { useSite } from "../site";
import { CartLoading } from "../components/CartLoading";
import { fmtTime, shopErr } from "../trade";
import { groupOf, targetOf, announceUnreadChange, useUnreadCount, type NotifyItem, type NotifyList } from "../notify";
import { Button } from "@/components/ui/button";

function NotifyRow({ item, onOpen }: { item: NotifyItem; onOpen: (item: NotifyItem) => void }) {
  const { t } = useSite();
  const target = targetOf(item);
  // 分组标签本地化：按 msg_type 前缀取键，groupOf 的模块返回值保留为中文兜底
  const groupKey = item.msg_type.startsWith("order_") ? "nav.orders"
    : item.msg_type.startsWith("refund_") ? "msg.group.refund"
    : item.msg_type === "invite_reward" ? "msg.group.reward"
    : item.msg_type === "recharge_credited" ? "msg.group.recharge"
    : item.msg_type === "announcement" ? "home.announce"
    : "msg.group.notice";
  const inner = (
    <>
      <span className={"mt-1.5 size-2 shrink-0 rounded-full " + (item.unread ? "bg-destructive" : "bg-transparent")} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium">{notifyTitle(item.title, text)}</span>
          <time className="shrink-0 text-xs text-muted-foreground">{fmtTime(item.created_at)}</time>
        </span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{notifyContent(item.content, text)}</span>
        <span className="mt-1 block text-[11px] text-muted-foreground">{t(groupKey, groupOf(item.msg_type))}{target ? " · " + t("msg.click_view", "点击查看") : ""}</span>
      </span>
      {target && <span className="shrink-0 self-center text-muted-foreground" aria-hidden>›</span>}
    </>
  );
  const cls = "flex items-start gap-2 border-b border-border/70 px-1 py-3 text-left transition last:border-0 hover:bg-accent/50";
  return target
    ? <Link to={target} className={cls} onClick={() => onOpen(item)}>{inner}</Link>
    : <button type="button" className={cls} onClick={() => onOpen(item)}>{inner}</button>;
}

export function MessagesPage() {
  const { user, ready, t, tf } = useSite();
  const [list, setList] = useState<NotifyList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [marking, setMarking] = useState(false);
  const unreadCount = useUnreadCount(user);

  const load = useCallback(async (offset: number, append: boolean) => {
    setLoading(true);
    try {
      const r = await call<NotifyList>("notify/list", { token: "user", query: { offset } });
      setList((prev) => (append && prev
        ? { ...r, items: [...prev.items, ...r.items] }
        : r));
      setError("");
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) void load(0, false);
  }, [user, load]);

  // read_at 一次性置位：本地先改状态，失败也不回滚UI（重进页面会以服务端为准）
  function markOne(item: NotifyItem) {
    if (!item.unread) return;
    void call("notify/read", { method: "POST", token: "user", idem: newIdem(), body: { id: item.id } })
      .then(() => {
        announceUnreadChange();
        setList((prev) => (prev
          ? { ...prev, items: prev.items.map((x) => (x.id === item.id ? { ...x, unread: false, read_at: new Date().toISOString() } : x)), unread_count: Math.max(0, prev.unread_count - 1) }
          : prev));
      })
      .catch(() => undefined);
  }

  async function markAll() {
    setMarking(true);
    try {
      await call("notify/read", { method: "POST", token: "user", idem: newIdem(), body: { all: true } });
      announceUnreadChange();
      await load(0, false);
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setMarking(false);
    }
  }

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("msg.loading", "正在加载消息…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  const items = list?.items ?? [];
  const nextOffset = list?.next_offset ?? null;
  // 单条已读走本地更新，头部计数跟随服务端 unread_count，避免两处数字打架
  const unreadShown = list?.unread_count ?? unreadCount;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold">
          {t("msg.title", "消息中心")}
          {unreadShown > 0 && <span className="ml-2 align-middle text-xs font-normal text-destructive">{tf("msg.unread_n", { n: unreadShown }, "{n} 条未读")}</span>}
        </h1>
        <span className="flex items-center gap-3 text-sm">
          <Link to="/me" className="text-primary underline">{t("common.back_me", "返回我的")}</Link>
          {unreadShown > 0 && (
            <Button size="sm" variant="outline" disabled={marking} onClick={() => void markAll()}>{t("msg.mark_all", "全部标为已读")}</Button>
          )}
        </span>
      </div>

      {error && <p className="border-y border-border/70 px-1 py-3 text-sm text-destructive">{error}</p>}

      {loading && !list && <div className="grid place-items-center py-14"><CartLoading label={t("msg.loading", "正在加载消息…")} /></div>}

      {list && items.length === 0 && (
        <div className="flex flex-col items-center gap-3 border-y border-border/70 py-12 text-center">
          <svg viewBox="0 0 24 24" className="size-10 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 6h16v12H4Z M4 7l8 6 8-6" />
          </svg>
          <p className="text-sm text-muted-foreground">{t("msg.empty", "暂无消息")}</p>
          <p className="max-w-md text-xs text-muted-foreground">
            {t("msg.empty_note", "订单支付成功、发货、确认收货、退款进度、邀请奖励与充值到账都会自动写进这里，无需手动订阅。")}
          </p>
        </div>
      )}

      {items.length > 0 && (
        <section className="border-t border-border/70">
          {items.map((item) => <NotifyRow key={item.id} item={item} onOpen={markOne} />)}
        </section>
      )}

      {!loading && nextOffset !== null && (
        <div>
          <Button variant="outline" className="w-full" onClick={() => void load(nextOffset, true)}>{t("common.loading_more", "加载更多")}</Button>
        </div>
      )}
    </div>
  );
}
