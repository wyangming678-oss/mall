import { useCallback, useEffect, useState } from "react";
import { call } from "../../api";
import { PageTitle, errText, useBusy } from "../ui";
import type { AuditRow, Paged } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE = 20;

export default function AuditPage() {
  const [filters, setFilters] = useState({ action: "", target_type: "", from: "" });
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Paged<AuditRow> | null>(null);
  const [error, setError] = useState("");
  const [busy, run] = useBusy();

  const load = useCallback((off: number, f: typeof filters) => {
    setError("");
    void run(async () => {
      try {
        setData(await call<Paged<AuditRow>>("admin/audit", {
          token: "admin",
          query: { offset: off, limit: PAGE, action: f.action || undefined, target_type: f.target_type || undefined, from: f.from || undefined },
        }));
      } catch (e) {
        setError(errText(e));
      }
    });
  }, [run]);

  useEffect(() => { load(offset, filters); }, [offset]); // eslint-disable-line react-hooks/exhaustive-deps

  // 后端按 user.ip_view 决定是否下发 ip：字段出现即代表当前账号可见
  const canIp = (data?.items ?? []).some((r) => "ip" in r);
  return (
    <div>
      <PageTitle title="审计日志" desc="高危操作全量留痕（append-only，只增不改不删）。" />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input placeholder="action（如 site.decorate）" value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} className="max-w-48" />
        <Input placeholder="target_type（如 user）" value={filters.target_type} onChange={(e) => setFilters({ ...filters, target_type: e.target.value })} className="max-w-40" />
        <Input placeholder="起始日期 YYYY-MM-DD" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} className="max-w-40" />
        <Button onClick={() => { setOffset(0); load(0, filters); }}>筛选</Button>
      </div>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>时间</TableHead><TableHead>动作</TableHead><TableHead>对象</TableHead><TableHead>摘要</TableHead>{canIp && <TableHead>IP</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {(data?.items ?? []).map((row) => (
            <TableRow key={row.id}>
              <TableCell className="whitespace-nowrap text-xs">{row.created_at?.slice(0, 19).replace("T", " ")}</TableCell>
              <TableCell className="font-mono text-xs">{row.action}</TableCell>
              <TableCell className="text-xs">{row.target_type}{row.target_id ? ` · ${row.target_id.slice(0, 8)}` : ""}</TableCell>
              <TableCell className="max-w-md truncate font-mono text-xs text-muted-foreground">{JSON.stringify(row.detail)}</TableCell>
              {canIp && <TableCell className="font-mono text-xs">{row.ip ?? "—"}</TableCell>}
            </TableRow>
          ))}
          {(data?.items ?? []).length === 0 && (
            <TableRow><TableCell colSpan={canIp ? 5 : 4} className="py-8 text-center text-muted-foreground">{busy ? "加载中…" : "暂无审计记录"}</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
      <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
        <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</Button>
        <span>第 {Math.floor(offset / PAGE) + 1} 页</span>
        <Button size="sm" variant="outline" disabled={(data?.items ?? []).length < PAGE} onClick={() => setOffset(offset + PAGE)}>下一页</Button>
      </div>
    </div>
  );
}
