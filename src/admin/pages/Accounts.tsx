import { useCallback, useEffect, useState } from "react";
import { call } from "../../api";
import { PageTitle, errText, riskyPost, useBusy } from "../ui";
import type { AdminAccount, RoleRow } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [error, setError] = useState("");
  const [busy, run] = useBusy();
  const [form, setForm] = useState({ username: "", nickname: "", password: "", roles: [] as string[] });
  const [editing, setEditing] = useState<AdminAccount | null>(null);

  const load = useCallback(() => {
    void run(async () => {
      try {
        const [a, r] = await Promise.all([
          call<{ accounts: AdminAccount[] }>("admin/accounts", { token: "admin" }),
          call<{ roles: RoleRow[] }>("admin/roles", { token: "admin" }),
        ]);
        setAccounts(a.accounts);
        setRoles(r.roles);
        setError("");
      } catch (e) {
        setError(errText(e));
      }
    });
  }, [run]);

  useEffect(load, [load]);

  function toggleRole(roleKey: string) {
    setForm((f) => ({
      ...f,
      roles: f.roles.includes(roleKey) ? f.roles.filter((r) => r !== roleKey) : [...f.roles, roleKey],
    }));
  }

  function startEdit(a: AdminAccount) {
    setEditing(a);
    setForm({ username: a.username, nickname: a.nickname, password: "", roles: [...a.roles] });
  }

  async function save() {
    setError("");
    const body: Record<string, unknown> = { nickname: form.nickname, roles: form.roles, status: editing?.status ?? "active" };
    if (editing) body.admin_id = editing.id;
    else { body.username = form.username; body.password = form.password; }
    if (form.password) body.password = form.password;
    try {
      await riskyPost("admin/account/save", body, `${editing ? "修改" : "新建"}后台账号 ${form.username}`);
      setEditing(null);
      setForm({ username: "", nickname: "", password: "", roles: [] });
      load();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function toggleActive(a: AdminAccount) {
    setError("");
    const status = a.status === "active" ? "disabled" : "active";
    try {
      await riskyPost("admin/account/save", { admin_id: a.id, nickname: a.nickname, roles: a.roles, status }, `${status === "disabled" ? "禁用" : "启用"}账号 ${a.username}`);
      load();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function remove(a: AdminAccount) {
    setError("");
    try {
      await riskyPost("admin/account/delete", { admin_id: a.id }, `删除后台账号 ${a.username}`);
      if (editing?.id === a.id) { setEditing(null); setForm({ username: "", nickname: "", password: "", roles: [] }); }
      load();
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="后台账号" desc="创建/修改管理员并绑定角色；禁用与改密会退出其全部会话。" />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>用户名</TableHead>
            <TableHead>昵称</TableHead>
            <TableHead>角色</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((a) => (
            <TableRow key={a.id}>
              <TableCell className="font-medium">{a.username}</TableCell>
              <TableCell>{a.nickname}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {a.roles.map((r) => <Badge key={r} variant="secondary">{r}</Badge>)}
                  {a.roles.length === 0 && <span className="text-xs text-muted-foreground">无角色</span>}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant={a.status === "active" ? "secondary" : "destructive"}>{a.status === "active" ? "正常" : "禁用"}</Badge>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => startEdit(a)}>编辑</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggleActive(a)}>
                    {a.status === "active" ? "禁用" : "启用"}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void remove(a)}>删除</Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Card>
        <CardHeader><CardTitle>{editing ? `编辑：${editing.username}` : "新建后台账号"}</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="ac-u">用户名{editing ? "（不可修改）" : "（字母数字下划线 3-20）"}</Label>
              <Input id="ac-u" value={form.username} disabled={!!editing} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ac-n">昵称</Label>
              <Input id="ac-n" value={form.nickname} onChange={(e) => setForm((f) => ({ ...f, nickname: e.target.value }))} maxLength={30} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ac-p">{editing ? "重置密码（留空=不改）" : "初始密码（≥8 位）"}</Label>
              <Input id="ac-p" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label>角色绑定</Label>
            <div className="flex flex-wrap gap-3">
              {roles.map((r) => (
                <label key={r.role_key} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={form.roles.includes(r.role_key)} onChange={() => toggleRole(r.role_key)} />
                  {r.role_key}
                  {r.permissions.includes("*") && <Badge variant="outline" className="ml-1">全部权限</Badge>}
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => void save()}>{editing ? "保存修改" : "创建账号"}</Button>
            {editing && (
              <Button variant="outline" onClick={() => { setEditing(null); setForm({ username: "", nickname: "", password: "", roles: [] }); }}>取消</Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
