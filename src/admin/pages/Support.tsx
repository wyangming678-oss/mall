// 客服工作台 CS1–CS4（文档C §六.7；权限点 chat.handle，方案 §2 客服角色只有这一页）
// 左列固定宽度不随内容回流；后台不做加载动画，处理中只靠按钮禁用表达
import { useCallback, useEffect, useState } from "react";
import { call, newIdem, uploadImageKey } from "../../api";
import { useAdmin } from "../AdminAuth";
import { PageTitle, Toolbar, errText, useBusy } from "../ui";
import {
  CHAT_STATUS_TEXT, useAdminChatFeed, usePoll,
  type ChatMessage, type ChatQueueItem, type ChatQueueResult, type ChatStatus,
} from "../../chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE = 20;
const STATUS_FILTER: Record<string, string> = { "": "进行中", waiting: "待接入", active: "已接入", closed: "已结束" };

const stamp = (iso: string) => iso.slice(5, 16).replace("T", " ");

// 工作台视角：自己发的靠右标「我」，同事/用户的靠左，系统消息居中
// 免注册访客的消息 sender_type 仍是 user，靠会话的 registered 区分称谓（文档J §2.3）
function Line({ msg, meId, guest }: { msg: ChatMessage; meId: string; guest: boolean }) {
  const mine = msg.sender_type === "admin" && msg.sender_id === meId;
  const who = msg.sender_type === "system" ? "系统" : msg.sender_type === "user" ? (guest ? "访客" : "用户") : mine ? "我" : "客服";
  return (
    <div className={"flex flex-col gap-1 border-b border-border/60 px-2 py-2 last:border-0 "
      + (msg.sender_type === "system" ? "items-center" : mine ? "items-end" : "items-start")}>
      <span className="text-[11px] text-muted-foreground">{who} · {stamp(msg.created_at)}</span>
      {msg.content_type === "image" && (
        msg.url
          ? <a href={msg.url} target="_blank" rel="noreferrer"><img src={msg.url} alt={msg.content} className="max-h-56 border border-border" /></a>
          : <span className="border border-dashed border-border px-2 py-1 text-xs text-muted-foreground">图片暂不可用</span>
      )}
      {msg.content && <span className="max-w-[75%] break-words text-sm leading-6">{msg.content}</span>}
    </div>
  );
}

function Conversation({ item, onChanged }: { item: ChatQueueItem; onChanged: () => void }) {
  const { me } = useAdmin();
  const adminId = me?.admin.id ?? "";
  const { status, messages, error, sending, send, setStatus, refresh } = useAdminChatFeed(item.session_id, adminId);
  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, run] = useBusy();
  // 接入后队列按状态筛选时这条会话会离开列表，快照里的 mine 来不及更新，靠本次操作兜住
  const [claimed, setClaimed] = useState(false);

  const writable = status === "active" && (item.mine || claimed);

  async function reply() {
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
      const key = await uploadImageKey(file, "chat", "admin");
      if (await send({ content: file.name.slice(0, 60) || "图片", contentType: "image", attachmentKey: key })) {
        setNotice("图片已发送");
      }
    } catch (e) {
      setNotice(errText(e));
    } finally {
      setUploading(false);
    }
  }

  async function claim() {
    setNotice("");
    await run(async () => {
      try {
        const r = await call<{ status: ChatStatus }>("admin/chat/claim", {
          method: "POST", token: "admin", body: { session_id: item.session_id },
        });
        setStatus(r.status);
        if (r.status === "active") setClaimed(true);
        setNotice(r.status === "active" ? "已接入，可以回复" : "该会话已在进行中");
        onChanged();
      } catch (e) {
        setNotice(errText(e));
        onChanged();
      }
    });
  }

  async function closeSession() {
    const label = item.registered ? `结束 ${item.user?.username ?? "该用户"} 的会话？` : "结束这位访客的会话？";
    if (!window.confirm(`${label}结束后双方都只能读，不能再发言。`)) return;
    setNotice("");
    await run(async () => {
      try {
        const r = await call<{ status: ChatStatus }>("admin/chat/close", {
          method: "POST", token: "admin", idem: newIdem(), body: { session_id: item.session_id },
        });
        setStatus(r.status);
        // 结束后轮询表停了，手动补拉一次把「客服已结束会话」这条系统消息带进记录
        await refresh();
        onChanged();
      } catch (e) {
        setNotice(errText(e));
      }
    });
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col border">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm">
        {/* display_name：注册用户是昵称/用户名，访客直接是「未注册」（文档J §2.3） */}
        <b>{item.display_name}</b>
        {item.registered && <span className="font-mono text-xs text-muted-foreground">{item.user?.username}</span>}
        <Badge variant={status === "active" ? "default" : status === "waiting" ? "secondary" : "outline"}>
          {CHAT_STATUS_TEXT[status]}
        </Badge>
        {item.assigned_admin_name && <span className="text-xs text-muted-foreground">接入：{item.assigned_admin_name}</span>}
        <span className="ml-auto flex gap-1">
          {status === "waiting" && <Button size="sm" disabled={busy} onClick={() => void claim()}>接入会话</Button>}
          {status !== "closed" && (
            <Button size="sm" variant="outline" className="text-destructive" disabled={busy || (status === "active" && !writable)} onClick={() => void closeSession()}>
              结束会话
            </Button>
          )}
        </span>
      </div>

      {error && <p className="border-b px-3 py-2 text-sm text-destructive">{error}</p>}
      {notice && <p className="border-b px-3 py-2 text-sm text-primary">{notice}</p>}

      <div className="flex max-h-[52dvh] min-h-64 flex-col overflow-y-auto">
        {!messages.length && <p className="py-10 text-center text-sm text-muted-foreground">该会话还没有消息</p>}
        {messages.map((m) => <Line key={m.message_id} msg={m} meId={adminId} guest={!item.registered} />)}
      </div>

      <div className="flex flex-col gap-2 border-t px-3 py-2">
        {writable ? (
          <>
            <div className="flex items-end gap-2">
              <Input
                value={text}
                maxLength={2000}
                placeholder="回复用户，回车发送"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void reply(); } }}
              />
              <Button disabled={sending || !text.trim()} onClick={() => void reply()}>{sending ? "发送中…" : "发送"}</Button>
              <label className="flex h-9 shrink-0 cursor-pointer items-center border px-3 text-sm hover:bg-accent">
                图片
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  disabled={uploading}
                  onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = ""; }}
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">{uploading ? "图片上传中…" : "可发订单截图等凭证（png / jpg / webp）"}</p>
          </>
        ) : (
          <p className="py-1 text-xs text-muted-foreground">
            {status === "waiting" && "先点「接入会话」再回复（waiting→active 只能由 CS2 完成）"}
            {status === "active" && "该会话由其他客服接入，只能查看不能代答"}
            {status === "closed" && "会话已结束，记录保留为只读"}
          </p>
        )}
      </div>
    </div>
  );
}

export default function SupportWorkbench() {
  const { has } = useAdmin();
  const [rows, setRows] = useState<ChatQueueItem[]>([]);
  const [filter, setFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [waitingTotal, setWaitingTotal] = useState(0);
  const [listError, setListError] = useState("");
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<ChatQueueItem | null>(null);
  const [busy, run] = useBusy();

  const load = useCallback(async () => {
    try {
      const r = await call<ChatQueueResult>("admin/chat/queue", {
        token: "admin", query: { status: filter || undefined, offset },
      });
      setRows(r.items);
      setHasMore(!!r.has_more);
      setWaitingTotal(r.waiting_total);
      setListError("");
      // 队列刷新后同步当前会话快照：接入/结束他人操作要立刻反映到按钮可用性
      setSelected((prev) => (prev ? (r.items.find((i) => i.session_id === prev.session_id) ?? prev) : null));
    } catch (e) {
      setListError(errText(e));
    }
  }, [filter, offset]);

  useEffect(() => {
    if (has("chat.handle")) void run(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [has, load, tick]);

  // 队列 5 秒轮询：新会话进线不必手动刷新（后台不做加载动画，只静默替换数据）
  usePoll(has("chat.handle"), () => void load(), 5000);

  if (!has("chat.handle")) {
    return <p className="text-sm text-muted-foreground">当前账号缺少 chat.handle 权限，无法使用客服工作台。</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="客服工作台" desc="CS1 队列 / CS2 接入 / CS3 回复与增量拉取 / CS4 结束会话（文档B §10：waiting→active→closed，closed 为终态）" />
      {/* 窄屏（手机）纵向堆叠：并排时 320px 队列栏会把对话区挤成一条 */}
      <div className="flex flex-col gap-3 md:min-h-[60dvh] md:flex-row md:gap-4">
        <div className="flex max-h-[46dvh] flex-col border md:max-h-none md:w-80 md:shrink-0">
          <Toolbar>
            <span className="flex flex-1 flex-col gap-1">
              <Label htmlFor="cs-status">会话状态</Label>
              <select id="cs-status" className="h-9 border bg-background px-2 text-sm" value={filter}
                onChange={(e) => { setFilter(e.target.value); setOffset(0); }}>
                {Object.entries(STATUS_FILTER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </span>
            <Button size="sm" variant="outline" className="mb-0.5" onClick={() => setTick((t) => t + 1)}>刷新</Button>
          </Toolbar>
          <p className="border-y px-2 py-1.5 text-xs text-muted-foreground">
            本页待接入 {waitingTotal} 条 · 共 {rows.length} 条
          </p>
          {listError && <p className="px-2 py-2 text-sm text-destructive">{listError}</p>}
          <div className="flex-1 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow><TableHead>用户</TableHead><TableHead>状态</TableHead><TableHead>最近消息</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((i) => (
                  <TableRow key={i.session_id}
                    className={"cursor-pointer " + (selected?.session_id === i.session_id ? "bg-accent" : "")}
                    onClick={() => setSelected(i)}>
                    <TableCell className="max-w-32 truncate text-sm">
                      {/* 访客不再打印 uuid 前缀，直接显示「未注册」 */}
                      {i.registered ? i.display_name : <span className="text-muted-foreground">{i.display_name}</span>}
                      {i.unread_for_user > 0 && <span className="ml-1 text-xs text-destructive">{i.unread_for_user} 未读</span>}
                    </TableCell>
                    <TableCell className="text-xs">
                      {CHAT_STATUS_TEXT[i.status]}
                      {i.mine && <span className="ml-1 text-primary">（我）</span>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{stamp(i.last_message_at)}</TableCell>
                  </TableRow>
                ))}
                {!rows.length && (
                  <TableRow><TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                    {filter === "closed" ? "暂无已结束会话" : "当前没有进行中的会话"}
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between border-t px-2 py-1 text-xs">
            <Button size="sm" variant="ghost" disabled={offset === 0 || busy} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</Button>
            <span className="text-muted-foreground">偏移 {offset}</span>
            <Button size="sm" variant="ghost" disabled={!hasMore || busy} onClick={() => setOffset(offset + PAGE)}>下一页</Button>
          </div>
        </div>

        {selected
          ? <Conversation key={selected.session_id} item={selected} onChanged={() => setTick((t) => t + 1)} />
          : <div className="flex flex-1 items-center justify-center border text-sm text-muted-foreground">左侧选择一条会话开始处理</div>}
      </div>
      <p className="text-xs text-muted-foreground">
        队列每 5 秒自动刷新；接入与结束都会写入审计日志（chat.claim / chat.close）。
      </p>
    </div>
  );
}
