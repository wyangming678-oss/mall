// 后台商品评价审核（A7）：列表 + 隐藏/恢复（权限点 product.manage）
// 隐藏=status→hidden，前台 RV1 列表不再展示；恢复=status→on。买家软删走 deleted_at，不在本表操作。
import { useEffect, useState } from "react";
import { ApiError, call, newIdem } from "../../api";
import { useAdmin } from "../AdminAuth";
import { PageTitle, Toolbar, errText, useBusy } from "../ui";
import type { AdminReviewRow, Paged } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE = 20;
const STATUS_TEXT: Record<string, string> = { on: "展示中", hidden: "已隐藏" };

function StarScore({ value }: { value: number }) {
  return (
    <span className="tabular-nums" aria-label={`${value} 分`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= value ? "text-primary" : "text-muted-foreground/40"}>★</span>
      ))}
    </span>
  );
}

export default function ReviewsPage() {
  const { has } = useAdmin();
  const canManage = has("product.manage");
  const [items, setItems] = useState<AdminReviewRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [busy, run] = useBusy();

  useEffect(() => {
    if (!canManage) return;
    let alive = true;
    setError("");
    void run(async () => {
      try {
        const r = await call<Paged<AdminReviewRow>>("admin/reviews", {
          token: "admin", query: { status: status || undefined, offset },
        });
        if (alive) { setItems(r.items); setHasMore(!!r.has_more); }
      } catch (e) {
        if (alive) setError(errText(e));
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, status, offset, tick]);

  async function toggle(r: AdminReviewRow) {
    setError("");
    await run(async () => {
      try {
        await call("admin/review/status", {
          method: "POST", token: "admin", idem: newIdem(),
          body: { review_id: r.review_id, status: r.status === "on" ? "hidden" : "on" },
        });
        setTick((k) => k + 1);
      } catch (e) {
        if (!(e instanceof ApiError && e.code === "confirm_required")) setError(errText(e));
      }
    });
  }

  if (!canManage) {
    return <p className="text-sm text-muted-foreground">当前账号缺少 product.manage 权限，无法管理商品评价。</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="商品评价" desc="RV1/RV2 评价审核：隐藏后前台商品详情页不再展示该评价，可随时恢复（权限点 product.manage）" />
      <Toolbar>
        <span className="flex flex-col gap-1">
          <Label htmlFor="rv-status">状态</Label>
          <select id="rv-status" className="h-9 border bg-background px-2 text-sm" value={status}
            onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
            <option value="">全部</option>
            <option value="on">展示中</option>
            <option value="hidden">已隐藏</option>
          </select>
        </span>
        <Button variant="outline" onClick={() => setTick((k) => k + 1)}>刷新</Button>
      </Toolbar>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>商品</TableHead><TableHead>买家</TableHead><TableHead>评分</TableHead>
            <TableHead>内容</TableHead><TableHead>标识</TableHead><TableHead>时间</TableHead><TableHead>状态</TableHead><TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((r) => (
            <TableRow key={r.review_id}>
              <TableCell className="max-w-40 truncate text-sm">{r.product_title}</TableCell>
              <TableCell className="text-xs">{r.user_name}</TableCell>
              <TableCell><StarScore value={r.rating} /></TableCell>
              <TableCell className="max-w-64 truncate text-xs text-muted-foreground">{r.content || "（未填写文字）"}</TableCell>
              <TableCell className="text-xs">{r.verified ? <Badge variant="secondary">已购买</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.created_at.slice(0, 16).replace("T", " ")}</TableCell>
              <TableCell><Badge variant={r.status === "on" ? "default" : "outline"}>{STATUS_TEXT[r.status] ?? r.status}</Badge></TableCell>
              <TableCell>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void toggle(r)}>
                  {r.status === "on" ? "隐藏" : "恢复"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {!items.length && (
            <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">暂无评价</TableCell></TableRow>
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
