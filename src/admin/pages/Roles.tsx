import { useCallback, useEffect, useState } from "react";
import { call } from "../../api";
import { PageTitle, errText, riskyPost, useBusy } from "../ui";
import type { RoleRow } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function RolesPage() {
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [points, setPoints] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, run] = useBusy();
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [newKey, setNewKey] = useState("");
  const isSuper = (roleKey: string) => (draft[roleKey] ?? []).includes("*");

  const load = useCallback(() => {
    void run(async () => {
      try {
        const r = await call<{ roles: RoleRow[]; permission_points: string[] }>("admin/roles", { token: "admin" });
        setRoles(r.roles);
        setPoints(r.permission_points);
        const d: Record<string, string[]> = {};
        for (const role of r.roles) d[role.role_key] = [...role.permissions];
        setDraft(d);
        setError("");
      } catch (e) {
        setError(errText(e));
      }
    });
  }, [run]);

  useEffect(load, [load]);

  function toggle(roleKey: string, point: string) {
    setDraft((d) => {
      const list = d[roleKey] ?? [];
      return { ...d, [roleKey]: list.includes(point) ? list.filter((p) => p !== point) : [...list, point] };
    });
  }

  async function saveRole(roleKey: string) {
    setError("");
    try {
      await riskyPost("admin/role/save", { role_key: roleKey, permissions: draft[roleKey] ?? [] }, `全量替换角色 ${roleKey} 的权限`);
      load();
    } catch (e) {
      setError(errText(e));
    }
  }

  const grouped = points.map((p) => p.split(".")[0]);
  const groups = [...new Set(grouped)];

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="角色权限" desc="权限点保存为全量替换，立即对该角色所有账号生效（服务端逐请求复验）。" />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Card>
        <CardHeader><CardTitle>新建角色</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="ro-k">角色标识（小写字母数字下划线）</Label>
              <Input id="ro-k" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="audit_viewer" className="max-w-52" />
            </div>
            <Button
              disabled={busy || !newKey}
              onClick={() => {
                if (draft[newKey]) { setError("角色已存在"); return; }
                const defaults = points.filter((p) => p !== "admin.manage");
                setDraft((d) => ({ ...d, [newKey]: defaults }));
                setRoles((r) => [...r, { role_key: newKey, permissions: defaults }]);
                setNewKey("");
              }}
            >
              添加角色
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            新角色默认已勾选全部权限，仅不含「账号管理（admin.manage）」，即不能改其他后台账号的密码、不能新建后台账号与角色；保存前请按需增删勾选。
          </p>
        </CardContent>
      </Card>

      {roles.filter((r) => (draft[r.role_key] ?? r.permissions).length || draft[r.role_key]).map((role) => (
        <Card key={role.role_key}>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{role.role_key}{isSuper(role.role_key) && <Badge variant="secondary" className="ml-2">超级权限（*）</Badge>}</CardTitle>
          <Button size="sm" disabled={busy} onClick={() => void saveRole(role.role_key)}>保存 {role.role_key}</Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {role.role_key === "super_admin" || isSuper(role.role_key) ? null : (
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={isSuper(role.role_key)} onChange={() => toggle(role.role_key, "*")} /> 通配全部权限（仅超级管理员可授予）
            </label>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map((g) => (
              <div key={g} className="rounded-lg border p-3">
                <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{g}</p>
                <div className="flex flex-col gap-1">
                  {points.filter((p) => p.startsWith(g + ".")).map((p) => (
                    <label key={p} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        disabled={isSuper(role.role_key)}
                        checked={(draft[role.role_key] ?? []).includes(p)}
                        onChange={() => toggle(role.role_key, p)}
                      />
                      {p}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      ))}
    </div>
  );
}
