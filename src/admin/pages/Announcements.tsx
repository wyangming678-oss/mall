// 后台公告 AN1：草稿维护 / 发布⚠ / 下线 / 软删（文档C AN1；权限点 content.manage + content.publish）
// 四种投放位置各走固定通道：首页横幅、首页弹窗（每人每天≤1 次，由前端本地记账）、单人定向、VIP 定向（后两者进消息中心且不占红点）
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, call, newIdem } from "../../api";
import { LANGUAGES } from "../../const";
import { useAdmin } from "../AdminAuth";
import { PageTitle, Toolbar, errText, isConfirmCancel, riskyPost, useBusy } from "../ui";
import type { Paged, UserRow } from "../types";
import type { AnnouncementItem } from "../../site";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE = 20;

export const ANNOUNCE_SCOPE_TEXT: Record<string, string> = {
  banner: "首页横幅", popup: "首页弹窗", user: "单人定向", vip: "VIP 定向",
};
export const ANNOUNCE_STATUS_TEXT: Record<string, string> = {
  draft: "草稿", published: "已发布", offline: "已下线",
};
const NEXT_ACTION: Record<string, ["publish" | "offline", string]> = {
  draft: ["publish", "发布"],
  published: ["offline", "下线"],
  offline: ["publish", "重新发布"],
};

/** 每语言一行：标题 + 正文，中文为必填原文，其余留空即回退中文 */
interface LangRow { title: string; content: string }

interface Draft {
  scope: "banner" | "popup" | "user" | "vip";
  target_user_id: string;
  langs: Record<string, LangRow>;
  publish_at: string;
  expire_at: string;
}

const emptyLangs = (): Record<string, LangRow> =>
  Object.fromEntries(LANGUAGES.map((l) => [l.code, { title: "", content: "" }]));

const EMPTY: Draft = { scope: "banner", target_user_id: "", langs: emptyLangs(), publish_at: "", expire_at: "" };

const toDraft = (a: AnnouncementItem | null): Draft => ({
  scope: (ANNOUNCE_SCOPE_TEXT[a?.scope ?? ""] ? a?.scope : "banner") as Draft["scope"],
  target_user_id: a?.target_user_id ?? "",
  langs: Object.fromEntries(LANGUAGES.map((l) => [l.code, {
    title: a?.title_i18n?.[l.code] ?? (l.code === "zh" ? a?.title ?? "" : ""),
    content: a?.content_i18n?.[l.code] ?? (l.code === "zh" ? a?.content ?? "" : ""),
  }])),
  publish_at: a ? a.publish_at.slice(0, 16) : "",
  expire_at: a?.expire_at ? a.expire_at.slice(0, 16) : "",
});

function draftError(d: Draft): string {
  const zh = d.langs.zh;
  if (!zh.title.trim()) return "请填写中文标题（其他语言留空时自动回退中文）";
  if (!zh.content.trim()) return "请填写中文正文";
  if (d.publish_at && Number.isNaN(Date.parse(d.publish_at))) return "发布时间格式不正确";
  if (d.expire_at) {
    if (Number.isNaN(Date.parse(d.expire_at))) return "下线时间格式不正确";
    const from = d.publish_at ? Date.parse(d.publish_at) : Date.now();
    if (Date.parse(d.expire_at) <= from) return "下线时间必须晚于发布时间";
  }
  if (d.scope === "user" && !d.target_user_id) return "单人定向公告需要选择一位用户";
  return "";
}

/** 时间输入按 UTC 解释，与列表显示同一口径，避免编辑一次保存就漂移 8 小时 */
const isoOf = (local: string): string | undefined => {
  if (!local) return undefined;
  const ms = Date.parse(local.length === 16 ? `${local}:00Z` : local);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

const mapsOf = (langs: Record<string, LangRow>) => {
  const pick = (key: keyof LangRow) => Object.fromEntries(
    LANGUAGES.map((l) => [l.code, langs[l.code][key].trim()]).filter(([, v]) => v),
  );
  return { titles: pick("title"), contents: pick("content") };
};

// —— 公告编辑器 ——
function AnnounceEditor({ item, onSaved, onCancel }: {
  item: AnnouncementItem | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(item));
  const [error, setError] = useState("");
  const [busy, run] = useBusy();
  const [keyword, setKeyword] = useState("");
  const [users, setUsers] = useState<UserRow[]>([]);

  const patch = (p: Partial<Draft>) => { setDraft((d) => ({ ...d, ...p })); setError(""); };
  const setLang = (code: string, p: Partial<LangRow>) => patch({
    langs: { ...draft.langs, [code]: { ...draft.langs[code], ...p } },
  });

  const searchUsers = useCallback(() => {
    setError("");
    void run(async () => {
      try {
        const r = await call<Paged<UserRow>>("admin/users", { token: "admin", query: { keyword: keyword || undefined } });
        setUsers(r.items);
      } catch (e) {
        setError(errText(e));
      }
    });
  }, [keyword, run]);

  useEffect(() => {
    if (draft.scope !== "user") return;
    searchUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.scope]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const invalid = draftError(draft);
    if (invalid) { setError(invalid); return; }
    setError("");
    const { titles, contents } = mapsOf(draft.langs);
    await run(async () => {
      try {
        await call("admin/announcement/save", {
          method: "POST", token: "admin", idem: newIdem(),
          body: {
            announcement_id: item?.announcement_id,
            scope: draft.scope,
            target_user_id: draft.scope === "user" ? draft.target_user_id : undefined,
            title: titles.zh,
            content: contents.zh,
            title_i18n: titles,
            content_i18n: contents,
            publish_at: isoOf(draft.publish_at),
            expire_at: isoOf(draft.expire_at),
          },
        });
        onSaved();
      } catch (err) {
        setError(errText(err));
      }
    });
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={onSave}>
      <PageTitle
        title={item ? "编辑公告" : "新建公告"}
        desc="新建后为草稿，需「发布」才会出现在前台；编辑已发布公告只改内容，状态保持已发布、即刻生效。"
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="an-scope">投放位置</Label>
          <select id="an-scope" className="h-9 border bg-background px-2 text-sm" value={draft.scope}
            onChange={(e) => patch({ scope: e.target.value as Draft["scope"], target_user_id: "" })}>
            {Object.entries(ANNOUNCE_SCOPE_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="an-publish">生效时间（UTC，留空=立即）</Label>
          <Input id="an-publish" type="datetime-local" value={draft.publish_at} onChange={(e) => patch({ publish_at: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="an-expire">自动下线时间（UTC，留空=不自动下线）</Label>
          <Input id="an-expire" type="datetime-local" value={draft.expire_at} onChange={(e) => patch({ expire_at: e.target.value })} />
        </div>
        {draft.scope === "user" && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="an-target">定向用户</Label>
            <div className="flex items-end gap-2">
              <Input id="an-target" className="h-9" placeholder="用户名/昵称" value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchUsers(); } }} />
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={searchUsers}>搜索</Button>
            </div>
          </div>
        )}
      </div>

      {draft.scope === "user" && (
        <div className="flex flex-wrap gap-2 border p-3">
          {users.map((u) => (
            <button key={u.id} type="button" onClick={() => patch({ target_user_id: u.id })}
              className={"border px-3 py-1 text-xs transition "
                + (draft.target_user_id === u.id ? "border-primary bg-primary text-primary-foreground" : "hover:border-primary")}>
              {u.username}{u.nickname ? `（${u.nickname}）` : ""}
            </button>
          ))}
          {!users.length && <span className="text-xs text-muted-foreground">未匹配到用户，可输入关键词后点「搜索」</span>}
          {draft.target_user_id && (
            <span className="text-xs text-muted-foreground">
              已选 {users.find((u) => u.id === draft.target_user_id)?.username ?? draft.target_user_id.slice(0, 8)}
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3 border p-3">
        <p className="text-sm font-medium">文案（中/英/日/韩）</p>
        {LANGUAGES.map((l) => (
          <div key={l.code} className="grid items-end gap-2 sm:grid-cols-[72px_1fr_2fr]">
            <span className="pb-2 text-xs text-muted-foreground">{l.name}{l.code === "zh" ? " *" : ""}</span>
            <Input aria-label={`${l.name}标题`} maxLength={200} placeholder="标题" value={draft.langs[l.code].title}
              onChange={(e) => setLang(l.code, { title: e.target.value })} />
            <Input aria-label={`${l.name}正文`} maxLength={2000} placeholder="正文" value={draft.langs[l.code].content}
              onChange={(e) => setLang(l.code, { content: e.target.value })} />
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          弹窗公告每人每天最多弹一次；单人/VIP 定向公告发布时会写入消息中心，且不占用未读红点。
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>{busy ? "保存中…" : item ? "保存修改" : "保存为草稿"}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>返回列表</Button>
      </div>
    </form>
  );
}

export default function AnnouncementsPage() {
  const { has } = useAdmin();
  const [items, setItems] = useState<AnnouncementItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState({ scope: "", status: "" });
  const [listError, setListError] = useState("");
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<"new" | AnnouncementItem | null>(null);
  const [busy, run] = useBusy();
  const canManage = has("content.manage");
  const canPublish = has("content.publish");

  useEffect(() => {
    if (!canManage) return;
    let alive = true;
    setListError("");
    void run(async () => {
      try {
        const r = await call<Paged<AnnouncementItem>>("admin/announcements", {
          token: "admin",
          query: { scope: filter.scope || undefined, status: filter.status || undefined, offset },
        });
        if (alive) { setItems(r.items); setHasMore(!!r.has_more); }
      } catch (e) {
        if (alive) setListError(errText(e));
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, filter, offset, tick]);

  async function act(a: AnnouncementItem, kind: "publish" | "offline" | "delete") {
    setListError("");
    const label = ANNOUNCE_SCOPE_TEXT[a.scope] ?? a.scope;
    await run(async () => {
      try {
        if (kind === "publish") {
          await riskyPost("admin/announcement/publish", { announcement_id: a.announcement_id }, `发布公告：${a.title}（${label}）`);
        } else if (kind === "offline") {
          await call("admin/announcement/offline", {
            method: "POST", token: "admin", idem: newIdem(), body: { announcement_id: a.announcement_id },
          });
        } else {
          await riskyPost("admin/announcement/save", { announcement_id: a.announcement_id, delete: true }, `删除公告：${a.title}`);
        }
        setTick((k) => k + 1);
      } catch (e) {
        if (e instanceof ApiError && e.code === "confirm_required") return;
        if (!isConfirmCancel(e)) setListError(errText(e));
      }
    });
  }

  if (!canManage) {
    return <p className="text-sm text-muted-foreground">当前账号缺少 content.manage 权限，无法管理公告。</p>;
  }

  if (editing !== null) {
    return (
      <AnnounceEditor
        item={editing === "new" ? null : editing}
        onSaved={() => { setEditing(null); setTick((k) => k + 1); }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="公告" desc="AN1 公告维护：横幅/弹窗投放在首页，单人定向与 VIP 定向进消息中心（权限点 content.manage / content.publish）" />
      <Toolbar>
        <span className="flex flex-col gap-1">
          <Label htmlFor="al-scope">投放位置</Label>
          <select id="al-scope" className="h-9 border bg-background px-2 text-sm" value={filter.scope}
            onChange={(e) => { setFilter((f) => ({ ...f, scope: e.target.value })); setOffset(0); }}>
            <option value="">全部</option>
            {Object.entries(ANNOUNCE_SCOPE_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </span>
        <span className="flex flex-col gap-1">
          <Label htmlFor="al-status">状态</Label>
          <select id="al-status" className="h-9 border bg-background px-2 text-sm" value={filter.status}
            onChange={(e) => { setFilter((f) => ({ ...f, status: e.target.value })); setOffset(0); }}>
            <option value="">全部</option>
            {Object.entries(ANNOUNCE_STATUS_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </span>
        <Button variant="outline" onClick={() => setTick((k) => k + 1)}>刷新</Button>
        <Button className="ml-auto" onClick={() => setEditing("new")}>新建公告</Button>
      </Toolbar>
      {listError && <p className="text-sm text-destructive">{listError}</p>}
      {!canPublish && <p className="text-xs text-muted-foreground">当前账号缺少 content.publish：只能存草稿，发布与下线按钮不可用。</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>标题</TableHead><TableHead>投放位置</TableHead><TableHead>定向</TableHead>
            <TableHead>状态</TableHead><TableHead>生效时间</TableHead><TableHead>自动下线</TableHead><TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((a) => (
            <TableRow key={a.announcement_id}>
              <TableCell className="max-w-56 truncate text-sm font-medium">{a.title}</TableCell>
              <TableCell className="text-xs">{ANNOUNCE_SCOPE_TEXT[a.scope] ?? a.scope}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {a.target_user_id ? a.target_user_id.slice(0, 8) : a.scope === "vip" ? "全部 VIP" : "全站"}
              </TableCell>
              <TableCell>
                <Badge variant={a.status === "published" ? "default" : a.status === "draft" ? "secondary" : "outline"}>
                  {ANNOUNCE_STATUS_TEXT[a.status] ?? a.status}
                </Badge>
              </TableCell>
              <TableCell className="text-xs">{a.publish_at.slice(0, 16).replace("T", " ")}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{a.expire_at ? a.expire_at.slice(0, 16).replace("T", " ") : "不过期"}</TableCell>
              <TableCell>
                <span className="flex flex-wrap items-center gap-1">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(a)}>编辑</Button>
                  {canPublish && NEXT_ACTION[a.status] && (
                    <Button size="sm" variant={NEXT_ACTION[a.status][0] === "publish" ? "outline" : "ghost"}
                      disabled={busy} onClick={() => void act(a, NEXT_ACTION[a.status][0])}>
                      {NEXT_ACTION[a.status][1]}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void act(a, "delete")}>
                    删除
                  </Button>
                </span>
              </TableCell>
            </TableRow>
          ))}
          {!items.length && (
            <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">暂无公告：点「新建公告」写第一条</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</Button>
        <span>每页 {PAGE} 条 · 偏移 {offset}</span>
        <Button size="sm" variant="outline" disabled={!hasMore} onClick={() => setOffset(offset + PAGE)}>下一页</Button>
      </div>
    </div>
  );
}
