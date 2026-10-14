import { useCallback, useEffect, useState, type FormEvent } from "react";
import { call } from "../../api";
import { formatBase } from "../../const";
import { DEFAULT_DIAL, buildE164 } from "../../phone";
import { DialPhoneInput } from "../../components/DialPhoneInput";
import { LANGS } from "../../i18n";
import { useAdmin } from "../AdminAuth";
import { PageTitle, errText, isConfirmCancel, riskyPost, useBusy } from "../ui";
import type { Paged, UserRow } from "../types";
import UserDrawer from "./UserDrawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE = 20;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// 与后端 users.mjs 的 LANGS 同源；语言决定顾客看到的界面与题面
const LANG_LABEL: Record<string, string> = { zh: "简体中文", en: "English", ja: "日本語", ko: "한국어" };

export default function UsersPage() {
  const [keyword, setKeyword] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Paged<UserRow> | null>(null);
  const [error, setError] = useState("");
  const [busy, run] = useBusy();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { has } = useAdmin();

  const load = useCallback((off: number, kw: string) => {
    setError("");
    void run(async () => {
      try {
        setData(await call<Paged<UserRow>>("admin/users", { token: "admin", query: { offset: off, limit: PAGE, keyword: kw || undefined } }));
      } catch (e) {
        setError(errText(e));
      }
    });
  }, [run]);

  useEffect(() => {
    load(offset, keyword);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset]);

  const total = data?.total ?? 0;
  const canIp = has("user.ip_view");
  const items = data?.items ?? [];
  const selected = items.find((u) => u.id === selectedId) ?? null;

  return (
    <div>
      <PageTitle title="用户管理" desc="查看前台用户；点「详情」在抽屉中编辑资料、调整余额、重置密码、设置支付密码、发放优惠券与定向弹窗。不会注册的顾客可由后台直接开号。" />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          placeholder="按用户名/昵称搜索"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { setOffset(0); load(0, keyword); } }}
          className="max-w-60"
        />
        <Button onClick={() => { setOffset(0); load(0, keyword); }}>搜索</Button>
        {has("user.create") && (
          <Button className="ml-auto" disabled={busy} onClick={() => setCreating(true)}>添加会员</Button>
        )}
      </div>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户名</TableHead>
              <TableHead>昵称</TableHead>
              <TableHead>邮箱</TableHead>
              <TableHead>余额(基准)</TableHead>
              <TableHead>币种</TableHead>
              <TableHead>未用券</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>注册时间</TableHead>
              {canIp && <TableHead>注册 IP</TableHead>}
              {canIp && <TableHead>最近登录 IP</TableHead>}
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.username}</TableCell>
                <TableCell>{u.nickname}</TableCell>
                <TableCell>{u.email ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{formatBase(u.balance)}</TableCell>
                <TableCell>{u.currency_code}</TableCell>
                <TableCell className="tabular-nums">{u.coupon_unused ?? 0}</TableCell>
                <TableCell>
                  <Badge variant={u.status === "active" ? "secondary" : "destructive"}>{u.status === "active" ? "正常" : "禁用"}</Badge>
                </TableCell>
                <TableCell className="text-xs">{u.created_at?.slice(0, 10)}</TableCell>
                {canIp && <TableCell className="font-mono text-xs">{u.register_ip ?? "—"}</TableCell>}
                {canIp && <TableCell className="font-mono text-xs">{u.last_login_ip ?? "—"}{u.last_login_at ? <span className="ml-1 text-muted-foreground">{u.last_login_at.slice(5, 16)}</span> : null}</TableCell>}
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setSelectedId(u.id)}>详情</Button>
                </TableCell>
              </TableRow>
            ))}
            {!busy && items.length === 0 && (
              <TableRow>
                <TableCell colSpan={canIp ? 11 : 9} className="py-8 text-center text-muted-foreground">
                  {data ? "暂无用户" : "加载中…"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
        <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</Button>
        <span>{total ? `${offset + 1}–${Math.min(total, offset + PAGE)}` : "0"} / 共 {total}（关键词搜索作用于当页过滤）</span>
        <Button size="sm" variant="outline" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>下一页</Button>
      </div>

      {selected && (
        <UserDrawer
          user={selected}
          onClose={() => setSelectedId(null)}
          onChanged={() => load(offset, keyword)}
        />
      )}

      {creating && (
        <UserCreatePanel
          onClose={() => setCreating(false)}
          onCreated={() => { setOffset(0); load(0, keyword); }}
        />
      )}
    </div>
  );
}

// 文档J §1.3：替不会注册的顾客开号。与自助注册的差异由后端决定（免人机验证、不受 register_open 约束、不发令牌），
// 这里只负责收字段与把账号信息原样交给操作者复制。
function UserCreatePanel({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [busy, run] = useBusy();
  const [error, setError] = useState("");
  const [created, setCreated] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [language, setLanguage] = useState<string>("zh");
  const [phoneDial, setPhoneDial] = useState(DEFAULT_DIAL);
  const [phoneNational, setPhoneNational] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const name = username.trim();
    if (!USERNAME_RE.test(name)) { setError("用户名需为 3–20 位字母、数字或下划线"); return; }
    if (password.length < 8) { setError("初始密码至少 8 位"); return; }
    const em = email.trim();
    if (em && !EMAIL_RE.test(em)) { setError("邮箱格式不正确"); return; }
    const national = phoneNational.trim();
    if (national) {
      const built = buildE164(phoneDial, national);
      if (built.error) { setError(built.error); return; }
    }
    setError("");
    await run(async () => {
      try {
        const r = await riskyPost<{ user: UserRow }>("admin/user/create", {
          username: name,
          password,
          nickname: nickname.trim() || undefined,
          email: em || undefined,
          language,
          ...(national ? { phone_dial_code: phoneDial, phone_national: national } : {}),
        }, `添加会员 ${name}（初始密码由你线下交给顾客）`);
        setCreated(r.user.username);
        setPassword("");
        onCreated();
      } catch (err) {
        if (!isConfirmCancel(err)) setError(errText(err));
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="添加会员">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l bg-background">
        <header className="flex items-center justify-between gap-2 border-b p-4">
          <div>
            <p className="text-base font-semibold">添加会员</p>
            <p className="text-xs text-muted-foreground">替不会自助注册的顾客开号，建好即为正常状态</p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="关闭">关闭</Button>
        </header>

        {(error || created) && (
          <div className="border-b px-4 py-2 text-sm">
            {error ? <p className="text-destructive">{error}</p> : (
              <p className="select-all text-primary">
                {`已创建会员 ${created}，请把用户名和初始密码交给顾客，登录后可在「我的-修改密码」自行更换。`}
              </p>
            )}
          </div>
        )}

        <form className="flex flex-1 flex-col gap-4 overflow-y-auto p-4" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="uc-u">用户名</Label>
            <Input id="uc-u" className="h-10" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} maxLength={20} placeholder="字母/数字/下划线 3-20 位" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="uc-p">初始密码</Label>
            <Input id="uc-p" className="h-10" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} maxLength={64} placeholder="至少 8 位" />
            <p className="text-xs text-muted-foreground">仅本次提交给后端，系统不保存明文；请通过你自己的渠道转告顾客。</p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="uc-n">昵称（留空同用户名）</Label>
            <Input id="uc-n" className="h-10" value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={30} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="uc-phone">手机号（选填）</Label>
            <DialPhoneInput idNum="uc-phone" dial={phoneDial} national={phoneNational} onDial={setPhoneDial} onNational={setPhoneNational} autoComplete="off" />
            <p className="text-xs text-muted-foreground">填了则按区号决定该账户的记账币种；留空沿用站点本位币。</p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="uc-e">邮箱（选填）</Label>
            <Input id="uc-e" className="h-10" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} placeholder="用于找回，可留空" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="uc-lang">界面语言</Label>
            <select
              id="uc-lang"
              className="h-10 w-full border bg-background px-2 text-sm"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {LANGS.map((l) => (
                <option key={l} value={l}>{LANG_LABEL[l] ?? l}</option>
              ))}
            </select>
          </div>
          <Button type="submit" size="sm" disabled={busy}>创建会员</Button>
        </form>
      </div>
    </div>
  );
}
