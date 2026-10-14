// 后台发票管理（A9）：队列 + 开具/作废（权限点 order.read 查看、order.operate 操作）
// 开具=pending→issued（置 issued_at）；作废=→void（需原因，释放名额使买家可重新申请）。
import { useEffect, useState } from "react";
import { ApiError, call, newIdem } from "../../api";
import { useAdmin } from "../AdminAuth";
import { PageTitle, Toolbar, errText, useBusy } from "../ui";
import { formatBase } from "../../const";
import { INVOICE_STATUS_TEXT, INVOICE_TYPE_TEXT } from "../../trade";
import type { AdminInvoiceRow, Paged } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE = 20;
const TABS: Array<[string, string]> = [["", "全部"], ["pending", "待开具"], ["issued", "已开具"], ["void", "已作废"]];
const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = { pending: "secondary", issued: "default", void: "outline" };

export default function InvoicesPage() {
  const { has } = useAdmin();
  const canRead = has("order.read");
  const canOperate = has("order.operate");
  const [items, setItems] = useState<AdminInvoiceRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [busy, run] = useBusy();
  const [voidFor, setVoidFor] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");

  useEffect(() => {
    if (!canRead) return;
    let alive = true;
    setError("");
    void run(async () => {
      try {
        const r = await call<Paged<AdminInvoiceRow> & { counts_by_status?: Record<string, number> }>("admin/invoices", {
          token: "admin", query: { status: status || undefined, offset },
        });
        if (alive) { setItems(r.items); setHasMore(!!r.has_more); setCounts(r.counts_by_status ?? {}); }
      } catch (e) {
        if (alive) setError(errText(e));
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead, status, offset, tick]);

  async function action(invoiceId: string, kind: "issue" | "void") {
    setError("");
    const body: Record<string, unknown> = { invoice_id: invoiceId, action: kind };
    if (kind === "void") {
      if (voidReason.trim().length < 2) { setError("作废原因至少 2 个字"); return; }
      body.void_reason = voidReason.trim();
    }
    await run(async () => {
      try {
        await call("admin/invoice/action", { method: "POST", token: "admin", idem: newIdem(), body });
        setVoidFor(null);
        setVoidReason("");
        setTick((k) => k + 1);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "confirm_required")) setError(errText(e));
      }
    });
  }

  if (!canRead) {
    return <p className="text-sm text-muted-foreground">当前账号缺少 order.read 权限，无法查看发票申请。</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="发票管理" desc="订单维度发票申请：开具（待开具→已开具，电子发票发到买家邮箱）、作废（→已作废，买家可就同一订单重新申请）。金额取下单实付快照（权限点 order.operate）" />
      <Toolbar>
        <span className="flex flex-wrap items-center gap-2">
          {TABS.map(([key, label]) => (
            <Button key={key || "all"} size="sm" variant={status === key ? "default" : "outline"}
              onClick={() => { setStatus(key); setOffset(0); }}>
              {label}{key && counts[key] ? ` · ${counts[key]}` : ""}
            </Button>
          ))}
        </span>
        <Button variant="ghost" onClick={() => setTick((k) => k + 1)}>刷新</Button>
      </Toolbar>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="overflow-x-auto border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>订单号</TableHead><TableHead>买家</TableHead><TableHead>类型</TableHead>
              <TableHead>抬头 / 税号</TableHead><TableHead>接收邮箱</TableHead><TableHead>金额</TableHead>
              <TableHead>状态</TableHead><TableHead>申请时间</TableHead><TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((r) => (
              <TableRow key={r.invoice_id}>
                <TableCell className="font-mono text-xs">{r.order_no ?? "—"}</TableCell>
                <TableCell className="text-xs">{r.buyer ?? r.user_id.slice(0, 8)}</TableCell>
                <TableCell className="text-sm">{INVOICE_TYPE_TEXT[r.invoice_type] ?? r.invoice_type}</TableCell>
                <TableCell className="max-w-52 text-xs">
                  <div className="truncate" title={r.title}>{r.title}</div>
                  {r.tax_no && <div className="text-muted-foreground">税号 {r.tax_no}</div>}
                </TableCell>
                <TableCell className="max-w-40 truncate text-xs text-muted-foreground" title={r.email}>{r.email}</TableCell>
                <TableCell className="text-sm">{formatBase(r.amount_base)}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{INVOICE_STATUS_TEXT[r.status] ?? r.status}</Badge>
                  {r.status === "void" && r.void_reason && <div className="mt-0.5 max-w-40 truncate text-[11px] text-muted-foreground" title={r.void_reason}>{r.void_reason}</div>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.created_at.slice(0, 16).replace("T", " ")}</TableCell>
                <TableCell>
                  {!canOperate ? <span className="text-xs text-muted-foreground">—</span> : r.status === "pending" ? (
                    <span className="flex items-center gap-1">
                      <Button size="sm" disabled={busy} onClick={() => void action(r.invoice_id, "issue")}>开具</Button>
                      {voidFor === r.invoice_id ? (
                        <span className="flex items-center gap-1">
                          <Input autoFocus className="h-8 w-32" placeholder="作废原因" value={voidReason} maxLength={200}
                            onChange={(e) => setVoidReason(e.target.value)} />
                          <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => void action(r.invoice_id, "void")}>确认</Button>
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setVoidFor(null); setVoidReason(""); }}>取消</Button>
                        </span>
                      ) : (
                        <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => { setVoidFor(r.invoice_id); setVoidReason(""); }}>作废</Button>
                      )}
                    </span>
                  ) : r.status === "issued" ? (
                    voidFor === r.invoice_id ? (
                      <span className="flex items-center gap-1">
                        <Input autoFocus className="h-8 w-32" placeholder="作废原因" value={voidReason} maxLength={200}
                          onChange={(e) => setVoidReason(e.target.value)} />
                        <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => void action(r.invoice_id, "void")}>确认</Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setVoidFor(null); setVoidReason(""); }}>取消</Button>
                      </span>
                    ) : (
                      <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => { setVoidFor(r.invoice_id); setVoidReason(""); }}>作废</Button>
                    )
                  ) : <span className="text-xs text-muted-foreground">已终结</span>}
                </TableCell>
              </TableRow>
            ))}
            {!items.length && !busy && (
              <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">暂无发票申请</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</Button>
        <span>每页 {PAGE} 条 · 偏移 {offset}</span>
        <Button size="sm" variant="outline" disabled={!hasMore} onClick={() => setOffset(offset + PAGE)}>下一页</Button>
      </div>
    </div>
  );
}
