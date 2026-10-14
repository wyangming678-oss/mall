// 站内消息（文档C §四 NT1）：列表类型、消息点目的地映射、未读红点计数
import { useEffect, useState } from "react";
import { call } from "./api";

export interface NotifyItem {
  id: string;
  msg_type: string;
  title: string;
  content: string;
  ref_type: string | null;
  ref_id: string | null;
  read_at: string | null;
  unread: boolean;
  created_at: string;
}

export interface NotifyList {
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  items: NotifyItem[];
  unread_count: number;
}

/** 分组标签：与函数侧 MSG_TYPES 白名单一一对应（调用处按 msg_type 推键取词，这里保留中文兜底） */
export function groupOf(msgType: string): string { /* i18n-fallback */
  if (msgType.startsWith("order_")) return "订单";
  if (msgType.startsWith("refund_")) return "退款";
  if (msgType === "invite_reward") return "奖励";
  if (msgType === "recharge_credited") return "充值";
  if (msgType === "announcement") return "公告";
  return "通知";
}

/** 只挂真实存在的页面：订单类回订单详情，充值回钱包，奖励回我的页 */
export function targetOf(item: NotifyItem): string | null {
  if (item.ref_type === "order" && item.ref_id) return `/order?id=${item.ref_id}`;
  if (item.ref_type === "wallet_txn") return "/wallet";
  if (item.ref_type === "invite_reward") return "/me";
  return null;
}

/** 已读动作发生后广播，让各处红点同一条消息里同步归零 */
const UNREAD_EVENT = "mall:unread-change";

export function announceUnreadChange() {
  window.dispatchEvent(new Event(UNREAD_EVENT));
}

/** 未读红点广播的订阅计数：任何红点相关的写动作后 bump，各处据此重取 */
export function useUnreadTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    window.addEventListener(UNREAD_EVENT, fn);
    return () => window.removeEventListener(UNREAD_EVENT, fn);
  }, []);
  return tick;
}

/** 未读红点数（公告类不计入，函数侧已排除）；path 变化或站内广播后重新拉取 */
export function useUnreadCount(user: unknown, path?: string): number {
  const [count, setCount] = useState(0);
  const tick = useUnreadTick();

  useEffect(() => {
    if (!user) {
      setCount(0);
      return undefined;
    }
    let alive = true;
    call<NotifyList>("notify/list", { token: "user", query: { unread: "1" } })
      .then((r) => { if (alive) setCount(r.unread_count ?? 0); })
      .catch(() => { if (alive) setCount(0); });
    return () => { alive = false; };
  }, [user, path, tick]);

  return count;
}
