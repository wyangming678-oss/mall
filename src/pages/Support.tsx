// 客服中心（方案 §13 购物端；文档C CH1 打开 / CH2 轮询 / CH3 发言 / CH4 结束）
// 整页会话框：外壳（App）在本路由占满视口并去掉底部 Tab/页脚，这里只做「头部 + 内部滚动消息区 + 贴底输入框」
// 版式仍为扁平直角：发言块靠左右分栏 + 实色底区分，不用圆角卡片和阴影
import { useEffect, useRef, useState } from "react";
import { call, uploadImageKey } from "../api";
import { useQuery } from "../router";
import { useSite } from "../site";
import { useShopperChat, CHAT_STATUS_TEXT, type ChatMessage } from "../chat";
import { fmtTime, shopErr, ORDER_STATUS_TEXT } from "../trade";
import { CartLoading } from "../components/CartLoading";
import { SubHeader } from "../components/SubHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function Bubble({ msg }: { msg: ChatMessage }) {
  const { t } = useSite();
  if (msg.sender_type === "system") {
    return (
      <p className="px-1 py-2 text-center text-xs text-muted-foreground">
        {msg.content} · {fmtTime(msg.created_at)}
      </p>
    );
  }
  const mine = msg.sender_type === "user";
  return (
    <div className={"flex flex-col gap-1 py-1.5 " + (mine ? "items-end" : "items-start")}>
      <p className="px-1 text-[11px] text-muted-foreground">
        {mine ? t("support.sender_me", "我") : t("support.agent", "客服")} · {fmtTime(msg.created_at)}
      </p>
      {msg.content_type === "image" && (
        msg.url
          ? <a href={msg.url} target="_blank" rel="noreferrer"><img src={msg.url} alt={msg.content} className="max-h-60 border border-border" /></a>
          : <p className="border border-dashed border-border bg-card px-3 py-2 text-xs text-muted-foreground">{t("support.img_unavailable", "图片暂不可用（存储未就绪）")}</p>
      )}
      {msg.content && (
        <p className={"max-w-[82%] break-words px-3 py-2 text-sm leading-6 " + (mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")}>
          {msg.content}
        </p>
      )}
    </div>
  );
}

export function SupportPage() {
  const { user, ready, t, tf, lang } = useSite();
  const { sessionId, status, messages, offline, workingHours, error, sending, isGuest, send, close, reopen } = useShopperChat(lang);
  const query = useQuery();
  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const feed = useRef<HTMLDivElement | null>(null);

  // 消息区是唯一的滚动容器：新消息只把它推到底，不整页跳
  useEffect(() => {
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, sessionId]);

  // #279/#281：从订单详情「申请退款（转客服）」跳来时带 ?refund=<order_id>。
  // 退款不走系统自动处理：先拉订单信息展示，买家必须填写退款原因，点「发送给客服」才把
  // 订单+原因合成一条消息发出（客服核实 → 后台审批）。原因未填不发，去重仅发一次。
  const refundOrder = query.refund ?? "";
  const [refundInfo, setRefundInfo] = useState<{ order_no: string; goods: string; statusText: string } | null>(null);
  const [refundReason, setRefundReason] = useState("");
  const [refundErr, setRefundErr] = useState("");
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundDone, setRefundDone] = useState(false);
  const refundFetched = useRef(false);
  const refundSent = useRef(false);

  useEffect(() => {
    if (!refundOrder || refundFetched.current) return;
    refundFetched.current = true;
    void (async () => {
      try {
        const d = await call<{ order: { order_no: string; status_order: string }; items: Array<{ title_snapshot: string; quantity: number }> }>(
          "order/detail", { token: "user", query: { id: refundOrder } },
        );
        const goods = d.items.map((it) => `${it.title_snapshot} ×${it.quantity}`).join(t("common.list_sep", "、"));
        const st = ORDER_STATUS_TEXT[d.order.status_order] ?? d.order.status_order;
        setRefundInfo({ order_no: d.order.order_no, goods, statusText: t("status.order." + d.order.status_order, st) });
      } catch (e) {
        setRefundErr(shopErr(e));
      }
    })();
  }, [refundOrder, t]);

  async function submitRefund() {
    const reason = refundReason.trim();
    if (refundSent.current || !sessionId || !refundInfo) return;
    if (reason.length < 2) { setRefundErr(t("support.refund_reason_need", "请先填写退款原因（至少 2 个字）")); return; }
    setRefundBusy(true); setRefundErr("");
    const msg = [
      `${t("support.refund_prefix", "【退款申请】订单 ")}${refundInfo.order_no}`,
      `${t("support.refund_goods", "商品：")}${refundInfo.goods}`,
      `${t("support.refund_status", "订单状态：")}${refundInfo.statusText}`,
      `${t("support.refund_reason_prefix", "退款原因：")}${reason}`,
      t("support.refund_ask", "我想申请这个订单的退款，请协助处理。"),
    ].join("\n");
    const sent = await send({ content: msg });
    setRefundBusy(false);
    if (sent) {
      refundSent.current = true;
      setRefundDone(true);
      setNotice(t("support.refund_sent", "已把订单和退款原因发给客服，客服核实后由后台审批。"));
    } else {
      setRefundErr(t("support.refund_send_failed", "退款申请发送失败，请稍后重试，或手动把订单号告诉客服。"));
    }
  }

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("support.connecting", "正在连接客服…")} /></div>;
  // 文档J §2.2：客服免注册可用——没有 user 也要能进来。chat/open 无令牌时由服务端签发访客主体。

  const closed = status === "closed";

  async function submit() {
    const content = text.trim();
    if (!content) return;
    setNotice("");
    if (await send({ content })) setText("");
  }

  async function pickImage(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setNotice("");
    try {
      const key = await uploadImageKey(file, "chat", "chat");
      // 图片消息的 content 是给列表看的说明文字，服务端按 chat/ 前缀校验键
      const ok = await send({ content: file.name.slice(0, 60) || t("support.image", "图片"), contentType: "image", attachmentKey: key });
      if (ok) setNotice(t("support.image_sent", "图片已发送"));
    } catch (e) {
      setNotice(shopErr(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col md:border-x md:border-border/70">
      <div className="shrink-0 px-4">
        <SubHeader
          title={t("me.link_support", "客服中心")}
          back={user ? "/me" : "/"}
          extra={
            sessionId
              ? <span className={"text-xs " + (closed ? "text-muted-foreground" : "text-primary")}>{t("support.status." + status, CHAT_STATUS_TEXT[status])}</span>
              : null
          }
        />
        {isGuest && (
          <p className="pt-2 text-xs text-muted-foreground">{t("support.guest_hint", "访客咨询 · 咨询记录只保存在本机")}</p>
        )}
      </div>

      <div ref={feed} className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {!sessionId && !error && <div className="grid place-items-center py-14"><CartLoading label={t("support.joining", "正在接入客服…")} /></div>}

        {sessionId && messages.length === 0 && (
          <p className="px-1 py-8 text-center text-sm text-muted-foreground">
            {t("support.empty", "还没有消息。说说你想咨询什么，客服接入后会在这里回复。")}
          </p>
        )}

        {messages.map((m) => <Bubble key={m.message_id} msg={m} />)}

        {offline && !closed && (
          <p className="px-1 py-2 text-center text-xs text-muted-foreground">
            {workingHours
              ? tf("support.offline_hours", { hours: workingHours }, "当前不在服务时段（服务时段 {hours}，按 UTC 计），留言会先收到自动回复，客服上线后处理。")
              : t("support.offline", "当前不在服务时段，留言会先收到自动回复，客服上线后处理。")}
          </p>
        )}
      </div>

      {/* 输入条永远贴在会话框底部：没接通时是禁用态，不整块消失（否则视觉上像「输入框跑到中间」） */}
      <div className="shrink-0 border-t bg-background px-3 pt-2 pb-[calc(0.5rem+var(--safe-b,0px))]">
        {error && <p className="pb-1 text-xs text-destructive">{error}</p>}
        {notice && <p className="pb-1 text-xs text-primary">{notice}</p>}

        {refundOrder && !refundDone && !closed && (
          <div className="mb-2 flex flex-col gap-1.5 border bg-accent/40 px-3 py-2">
            <p className="text-sm font-medium">{t("support.refund_reason_title", "填写退款原因")}</p>
            {refundInfo && (
              <p className="text-xs text-muted-foreground">
                {t("support.refund_prefix", "【退款申请】订单 ")}{refundInfo.order_no}
                {refundInfo.goods ? ` · ${refundInfo.goods}` : ""} · {refundInfo.statusText}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t("support.refund_reason_hint", "退款不走系统自动处理：请先填写退款原因，再发给客服核实，最后由后台审批。")}</p>
            <textarea
              className="w-full border bg-background px-2 py-1.5 text-sm"
              rows={2}
              maxLength={200}
              value={refundReason}
              placeholder={t("support.refund_reason_ph", "请说明退款原因，例如：未收到货 / 与描述不符 / 尺码不合适")}
              onChange={(e) => setRefundReason(e.target.value)}
            />
            {refundErr && <p className="text-xs text-destructive">{refundErr}</p>}
            <Button
              size="sm"
              disabled={!sessionId || !refundInfo || refundBusy || refundReason.trim().length < 2}
              onClick={() => void submitRefund()}
            >
              {refundBusy
                ? t("support.sending", "发送中…")
                : !sessionId
                  ? t("support.joining", "正在接入客服…")
                  : t("support.refund_reason_submit", "发送给客服")}
            </Button>
          </div>
        )}

        {closed ? (
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
            <p className="text-xs text-muted-foreground">{t("support.closed_note", "会话已结束，如需继续请重新发起。")}</p>
            <Button size="sm" variant="outline" onClick={() => void reopen()}>{t("support.reopen", "重新发起会话")}</Button>
          </div>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <Input
                value={text}
                maxLength={2000}
                disabled={!sessionId}
                placeholder={sessionId
                  ? t("support.input_ph", "描述你的问题，如涉及订单请带上订单号")
                  : t("support.joining", "正在接入客服…")}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }}
              />
              <Button disabled={sending || !sessionId || !text.trim()} onClick={() => void submit()}>
                {sending ? t("support.sending", "发送中…") : t("support.send", "发送")}
              </Button>
              <label className={"flex h-9 shrink-0 items-center border px-3 text-sm " + (sessionId && !uploading ? "cursor-pointer hover:bg-accent" : "opacity-60")}>
                {t("support.image", "图片")}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  disabled={uploading || !sessionId}
                  onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = ""; }}
                />
              </label>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1.5 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">{uploading ? t("support.uploading", "图片上传中…") : t("support.image_hint", "支持截图取证：png / jpg / webp")}</span>
              {sessionId ? (
                <button type="button" className="shrink-0 text-destructive underline" disabled={sending} onClick={() => void close()}>
                  {t("support.end", "结束会话")}
                </button>
              ) : error ? (
                <button type="button" className="shrink-0 text-primary underline" onClick={() => void reopen()}>
                  {t("support.retry", "重新连接")}
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
