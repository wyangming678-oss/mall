// 客服会话（文档C CH1–CH4 购物端 / CS1–CS4 工作台；方案 §13 五秒轮询 + last_message_id 增量）
// 两端共用类型与游标规则：坏游标由服务端降级为全量，客户端只会往前推不会卡死。
import { useCallback, useEffect, useRef, useState } from "react";
import { call, newIdem, tokenStore } from "./api";
import { text } from "./i18n";
import { announceUnreadChange } from "./notify";

export type ChatStatus = "waiting" | "active" | "closed";
export type ChatSender = "user" | "admin" | "system";

export interface ChatMessage {
  message_id: string;
  sender_type: ChatSender;
  sender_id: string;
  content_type: "text" | "image";
  content: string;
  attachment_key: string | null;
  url: string | null;
  created_at: string;
}

export interface ChatSessionView {
  session_id: string;
  status: ChatStatus;
  assigned_admin_id: string | null;
  last_message_at: string;
  created_at: string;
}

export interface ChatOpenResult {
  session: ChatSessionView;
  reused: boolean;
  offline?: boolean;
  working_hours?: string;
  messages: ChatMessage[];
  last_message_id: string | null;
  /** 文档J：本次主体是否为服务端签发的访客 */
  is_guest?: boolean;
  /** 仅访客首次 open 时下发，写入本机后复用 */
  guest_token?: string;
}

export interface ChatPollResult {
  session_id: string;
  status: ChatStatus;
  user_id?: string;
  messages: ChatMessage[];
  has_more: boolean;
  last_message_id: string | null;
}

export interface ChatSendResult {
  message_id: string;
  created_at: string;
  status: ChatStatus;
}

export interface ChatQueueItem extends ChatSessionView {
  user_id: string;
  user: { id: string; username: string; nickname: string; avatar_key: string | null } | null;
  /** 文档J §2.3：false = 免注册访客（没有 users 行），后台统一显示「未注册」 */
  registered: boolean;
  display_name: string;
  assigned_admin_name: string | null;
  mine: boolean;
  unread_for_user: number;
}

export interface ChatQueueResult {
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  items: ChatQueueItem[];
  waiting_total: number;
}

export const CHAT_STATUS_TEXT: Record<ChatStatus, string> = { /* i18n-fallback */
  waiting: "等待客服接入", active: "客服已接入", closed: "会话已结束",
};

const errText = (e: unknown, fallback: string) =>
  (e instanceof Error && e.message ? e.message : fallback);

/**
 * 增量游标：只有拿到消息才往前推，且落到本会话内才生效（服务端对坏游标已做全量降级）。
 * 返回的消息按 message_id 去重后追加——自己刚发的那条可能在轮询里再出现一次。
 */
export function useMessageFeed() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const cursor = useRef<string | null>(null);

  const reset = useCallback((rows: ChatMessage[]) => {
    cursor.current = rows.length ? rows[rows.length - 1].message_id : null;
    setMessages(rows);
  }, []);

  /** 拉到新消息返回 true，供调用方决定是否广播红点刷新 */
  const merge = useCallback((rows: ChatMessage[]) => {
    if (!rows.length) return false;
    cursor.current = rows[rows.length - 1].message_id;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.message_id));
      const added = rows.filter((m) => !seen.has(m.message_id));
      return added.length ? [...prev, ...added] : prev;
    });
    return true;
  }, []);

  const push = useCallback((msg: ChatMessage) => {
    cursor.current = msg.message_id;
    setMessages((prev) => (prev.some((m) => m.message_id === msg.message_id) ? prev : [...prev, msg]));
  }, []);

  return { messages, cursor, reset, merge, push };
}

/** 定时轮询（方案 §13 的 5 秒节奏）；关闭时不再挂表，避免已结束会话空转 */
export function usePoll(active: boolean, onTick: () => void, ms = 5000) {
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(onTick, ms);
    return () => window.clearInterval(id);
  }, [active, onTick, ms]);
}

export interface ShopperChat {
  sessionId: string | null;
  status: ChatStatus;
  messages: ChatMessage[];
  offline: boolean;
  workingHours: string;
  error: string;
  sending: boolean;
  /** 本次会话走的是访客主体（免注册），页面据此提示记录只保存在本机 */
  isGuest: boolean;
  send: (payload: { content: string; contentType?: "text" | "image"; attachmentKey?: string }) => Promise<boolean>;
  close: () => Promise<void>;
  reopen: () => Promise<void>;
}

/** 购物端会话：CH1 打开 → CH2 轮询（同时推进服务端已读游标）→ CH3 发言 → CH4 结束 */
export function useShopperChat(lang?: string): ShopperChat {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<ChatStatus>("waiting");
  const [offline, setOffline] = useState(false);
  const [workingHours, setWorkingHours] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [isGuest, setIsGuest] = useState(() => !tokenStore.user.get() && !!tokenStore.guest.get());
  const { messages, cursor, reset, merge, push } = useMessageFeed();
  const started = useRef(false);

  /** CH1 幂等：有活会话就复用，已结束则开一条新的（文档B §10 closed 是终态、可重开） */
  const openSession = useCallback(async () => {
    setError("");
    try {
      // 自动回复在写库那一刻就要定语言，所以把界面语言带给服务端（旧会话复用的那条气泡不重写）
      const r = await call<ChatOpenResult>("chat/open", {
        method: "POST", token: "chat", body: {}, query: { lang: localStorage.getItem("mall.lang") || lang || "zh" },
      });
      if (r.guest_token) tokenStore.guest.set(r.guest_token);
      setIsGuest(r.is_guest ?? false);
      setSessionId(r.session.session_id);
      setStatus(r.session.status);
      setOffline(r.offline ?? false);
      setWorkingHours(r.working_hours ?? "");
      reset(r.messages ?? []);
      announceUnreadChange();
    } catch (e) {
      setError(errText(e, text("chat.open_failed", "无法打开客服会话")));
    }
  }, [reset]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void openSession();
  }, [openSession]);

  const pull = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await call<ChatPollResult>("chat/poll", {
        token: "chat", query: { session_id: sessionId, last_message_id: cursor.current },
      });
      setStatus(r.status);
      if (merge(r.messages)) announceUnreadChange();
      setError("");
    } catch (e) {
      // 会话被后台结束等终态错误：停止刷新界面即可，消息保留，按钮由 status 决定
      setError(errText(e, text("chat.poll_failed", "拉取新消息失败")));
    }
  }, [sessionId, cursor, merge]);

  usePoll(!!sessionId && status !== "closed", pull);

  const send = useCallback(async (payload: { content: string; contentType?: "text" | "image"; attachmentKey?: string }) => {
    if (!sessionId) return false;
    setSending(true);
    setError("");
    try {
      const r = await call<ChatSendResult>("chat/send", {
        method: "POST", token: "chat", idem: newIdem(),
        body: {
          session_id: sessionId,
          content: payload.content,
          content_type: payload.contentType,
          attachment_key: payload.attachmentKey,
        },
      });
      push({
        message_id: r.message_id,
        sender_type: "user",
        sender_id: "",
        content_type: payload.contentType ?? "text",
        content: payload.content,
        attachment_key: payload.attachmentKey ?? null,
        url: null,
        created_at: r.created_at,
      });
      setStatus(r.status);
      setSending(false);
      return true;
    } catch (e) {
      setError(errText(e, text("chat.send_failed", "发送失败")));
      setSending(false);
      return false;
    }
  }, [sessionId, push]);

  const close = useCallback(async () => {
    if (!sessionId) return;
    setError("");
    try {
      const r = await call<{ status: ChatStatus; message_id?: string }>("chat/close", {
        method: "POST", token: "chat", idem: newIdem(), body: { session_id: sessionId },
      });
      setStatus(r.status);
      await pull();
      announceUnreadChange();
    } catch (e) {
      setError(errText(e, text("chat.close_failed", "结束会话失败")));
    }
  }, [sessionId, pull]);

  return { sessionId, status, messages, offline, workingHours, error, sending, isGuest, send, close, reopen: openSession };
}

/** 工作台单个会话的轮询：CS3 GET admin/chat/poll，服务端刻意不动用户已读游标 */
export function useAdminChatFeed(sessionId: string | null, meId = "") {
  const [status, setStatus] = useState<ChatStatus>("waiting");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const { messages, cursor, reset, merge, push } = useMessageFeed();

  useEffect(() => {
    if (!sessionId) {
      reset([]);
      return;
    }
    let alive = true;
    cursor.current = null;
    void (async () => {
      try {
        const r = await call<ChatPollResult>("admin/chat/poll", { token: "admin", query: { session_id: sessionId } });
        if (!alive) return;
        setStatus(r.status);
        reset(r.messages ?? []);
        setError("");
      } catch (e) {
        if (alive) setError(errText(e, text("chat.history_failed", "无法载入会话记录")));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, reset]);

  const pull = useCallback(async () => {
    if (!sessionId) return;
    try {
      const r = await call<ChatPollResult>("admin/chat/poll", {
        token: "admin", query: { session_id: sessionId, last_message_id: cursor.current },
      });
      setStatus(r.status);
      merge(r.messages);
      setError("");
    } catch (e) {
      setError(errText(e, text("chat.poll_failed", "拉取新消息失败")));
    }
  }, [sessionId, cursor, merge]);

  usePoll(!!sessionId && status !== "closed", pull);

  const send = useCallback(async (payload: { content: string; contentType?: "text" | "image"; attachmentKey?: string }) => {
    if (!sessionId) return false;
    setSending(true);
    setError("");
    try {
      const r = await call<ChatSendResult>("admin/chat/reply", {
        method: "POST", token: "admin", idem: newIdem(),
        body: {
          session_id: sessionId,
          content: payload.content,
          content_type: payload.contentType,
          attachment_key: payload.attachmentKey,
        },
      });
      push({
        message_id: r.message_id,
        sender_type: "admin",
        sender_id: meId,
        content_type: payload.contentType ?? "text",
        content: payload.content,
        attachment_key: payload.attachmentKey ?? null,
        url: null,
        created_at: r.created_at,
      });
      setStatus(r.status);
      setSending(false);
      return true;
    } catch (e) {
      setError(errText(e, text("chat.reply_failed", "回复失败")));
      setSending(false);
      return false;
    }
  }, [sessionId, meId, push]);

  return { status, messages, error, sending, send, setStatus, refresh: pull };
}
