// 后台提现审核 AN-WD1/AN-WD2（文档O）：列表 + 详情 + 线下打款完成 / 驳回退余额，均为高危操作。
// 提现无网关：申请时已扣余额，「已完成」只翻状态（钱线下已给用户），「驳回」才原路退回余额。
import { useCallback, useEffect, useState } from "react";
import { call } from "../../api";
import { formatBase } from "../../const";
import { useAdmin } from "../AdminAuth";
import { PageTitle, errText, isConfirmCancel, riskyPost } from "../ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "../../trade";
import { WD_FIELDS, type WdPayoutEntry } from "../../withdraw";

const WITHDRAW_STATUS_TEXT: Record<string, string> = {
  PENDING: "待审核", COMPLETED: "已到账", REJECTED: "已驳回/已撤销",
};
// 决策 4：收款方式固定四种；CRYPTO 是旧版自由填写时代的历史值，只用于回显旧单
const METHOD_TEXT: Record<string, string> = {
  BANK: "银行卡", USDT: "USDT", USDC: "USDC", PAYPAL: "PayPal", CRYPTO: "加密货币",
};
const methodText = (method: string | null) => (method ? METHOD_TEXT[method] ?? method : "未填写方式");
const payoutLabel = (key: string) => (key === "RAW" ? "原填写内容" : WD_FIELDS[key]?.zh ?? key);
/** 后端已把 payout_account 拆成条目；旧版自由文本单回落成一条 RAW */
const payoutEntries = (row: { payout?: WdPayoutEntry[]; payout_account: string }) =>
  row.payout?.length ? row.payout : [{ key: "RAW", value: row.payout_account }];
const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  PENDING: "secondary", COMPLETED: "default", REJECTED: "outline",
};
const TABS: Array<[string, string]> = [["", "全部"], ["PENDING", "待审核"], ["COMPLETED", "已到账"], ["REJECTED", "已驳回/已撤销"]];

interface WithdrawUser { id: string; username: string; nickname: string; email: string | null; phone: string | null; currency_code: string; balance: number }
interface WithdrawRow {
  id: string; user_id: string; amount_base: number; currency_code: string; fee_base: number | null;
  method: string | null; payout_account: string; payout?: WdPayoutEntry[]; status: string; review_note: string | null;
  reviewed_by: string | null; reviewed_at: string | null; payout_ref: string | null; created_at: string; updated_at: string;
  user?: WithdrawUser | null;
}
interface ListPage { offset: number; limit: number; has_more: boolean; next_offset: number | null; items: WithdrawRow[] }
interface DetailResult extends WithdrawRow {
  user: WithdrawUser | null;
  withdraw_txn: { id: string; amount: number; balance_before: number; balance_after: number; created_at: string } | null;
}

function WithdrawBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "outline"}>{WITHDRAW_STATUS_TEXT[status] ?? status}</Badge>;
}

function DoneForm({ id, onDone }: { id: string; onDone: (msg: string) => void }) {
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/30 p-3">
      <span className="flex flex-col gap-1">
        <Label htmlFor="wd-ref">打款流水号 / 凭证号（选填）</Label>
        <Input id="wd-ref" className="h-8 w-52" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="线下转账流水号" maxLength={120} />
      </span>
      <span className="flex flex-col gap-1">
        <Label htmlFor="wd-done-note">备注（选填）</Label>
        <Input id="wd-done-note" className="h-8 w-52" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      </span>
      <Button
        size="sm" disabled={busy}
        onClick={async () => {
          setBusy(true); setError("");
          try {
            await riskyPost("admin/withdraw/done", {
              id, payout_ref: ref.trim() || undefined, review_note: note.trim() || undefined,
            }, "确认已线下打款");
            onDone("已标记到账：状态转「已完成」，余额不再变动（打款发生在线下）");
          } catch (e) {
            if (!isConfirmCancel(e)) setError(errText(e));
          } finally { setBusy(false); }
        }}
      >标记已打款</Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function RejectForm({ id, onDone }: { id: string; onDone: (msg: string) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
      <span className="flex flex-col gap-1">
        <Label htmlFor="wd-reason">驳回原因（≥2 字，买家可见并退回余额）</Label>
        <Input id="wd-reason" className="h-8 w-64" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      </span>
      <Button
        size="sm" variant="outline" className="text-destructive" disabled={busy || reason.trim().length < 2}
        onClick={async () => {
          setBusy(true); setError("");
          try {
            await riskyPost("admin/withdraw/reject", { id, review_note: reason.trim() }, "驳回并退回余额");
            onDone("已驳回：提现金额已原路退回买家余额");
          } catch (e) {
            if (!isConfirmCancel(e)) setError(errText(e));
          } finally { setBusy(false); }
        }}
      >驳回退余额</Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function Detail({ withdrawId, onBack, onChanged }: { withdrawId: string; onBack: () => void; onChanged: () => void }) {
  const [data, setData] = useState<DetailResult | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await call<DetailResult>("admin/withdraw/detail", { token: "admin", query: { id: withdrawId } }));
      setError("");
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [withdrawId]);
  useEffect(() => { void load(); }, [load]);

  if (loading && !data) return <p className="text-sm text-muted-foreground">提现单详情加载中…</p>;
  if (!data) return <p className="text-sm text-destructive">{error || "提现单不存在"}</p>;

  const pending = data.status === "PENDING";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span className="font-mono text-sm">{data.id}</span>
          <WithdrawBadge status={data.status} />
          <span className="text-xs font-normal text-muted-foreground">收款方式 {methodText(data.method)}</span>
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={onBack}>返回列表</Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {notice && <p className="text-sm text-primary">{notice}</p>}

        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <p className="font-medium">提现金额</p>
            <p><b className="text-primary">{formatBase(data.amount_base)}</b><span className="ml-2 text-xs text-muted-foreground">（{data.currency_code}）</span></p>
            {data.fee_base ? <p className="text-muted-foreground">手续费 {formatBase(data.fee_base)}</p> : <p className="text-muted-foreground">无手续费</p>}
            <p className="font-medium">收款信息（{methodText(data.method)}）</p>
            <div className="flex flex-col gap-0.5">
              {payoutEntries(data).map((e) => (
                <p key={e.key} className="text-muted-foreground">
                  <span className="mr-2">{payoutLabel(e.key)}</span>
                  <span className="break-all font-mono text-xs text-foreground">{e.value}</span>
                </p>
              ))}
            </div>
            <p className="text-muted-foreground">提交于 {fmtTime(data.created_at)} · 更新 {fmtTime(data.updated_at)}</p>
            {data.payout_ref && <p className="text-muted-foreground">打款凭证：{data.payout_ref}</p>}
            {data.review_note && <p className="text-destructive">审核备注：{data.review_note}</p>}
          </div>
          <div className="flex flex-col gap-1">
            <p className="font-medium">买家与扣款流水</p>
            <p className="text-muted-foreground">{data.user ? `${data.user.nickname}（${data.user.username}）` : data.user_id}</p>
            {data.user && <p className="text-muted-foreground">邮箱 {data.user.email ?? "—"} · 手机 {data.user.phone ?? "—"}</p>}
            {data.user && <p className="text-muted-foreground">当前余额（计价基准）{formatBase(data.user.balance)}</p>}
            {data.withdraw_txn
              ? <p className="text-xs text-muted-foreground">扣款流水 {data.withdraw_txn.id.slice(0, 8)} · {formatBase(data.withdraw_txn.balance_before)} → {formatBase(data.withdraw_txn.balance_after)}（提现 {formatBase(Math.abs(data.withdraw_txn.amount))}）</p>
              : <p className="text-xs text-muted-foreground">未找到关联扣款流水</p>}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">可执行操作</p>
          {pending ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">请先在线下把钱打给买家，再点「标记已打款」；无法打款则「驳回退余额」（金额原路退回）。</p>
              <DoneForm id={data.id} onDone={(msg) => { setNotice(msg); onChanged(); void load(); }} />
              <RejectForm id={data.id} onDone={(msg) => { setNotice(msg); onChanged(); void load(); }} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {data.status === "COMPLETED" ? "已标记到账，单据终结，不可再次操作。" : "已驳回/撤销，金额已退回买家余额，单据终结。"}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminWithdrawsPage() {
  const { has } = useAdmin();
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<WithdrawRow[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ has_more: boolean; next_offset: number | null }>({ has_more: false, next_offset: null });
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError("");
    call<ListPage>("admin/withdraws", { token: "admin", query: { status: status || undefined, offset } })
      .then((r) => {
        if (!alive) return;
        setRows(r.items);
        setPage({ has_more: r.has_more, next_offset: r.next_offset });
      })
      .catch((e: unknown) => { if (alive) { setRows([]); setError(errText(e)); } });
    return () => { alive = false; };
  }, [status, offset, tick]);

  if (!has("withdraw.review")) {
    return <p className="text-sm text-muted-foreground">当前账号缺少提现审核权限（withdraw.review）。</p>;
  }

  if (openId) {
    return (
      <div className="flex flex-col gap-4">
        <PageTitle title="提现单详情" desc="⚠ 高危：标记已打款 / 驳回退余额（二次确认并写入审计）" />
        <Detail withdrawId={openId} onBack={() => setOpenId(null)} onChanged={() => setTick((t) => t + 1)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="余额提现" desc="买家申请即扣余额建单（待审核）；线下打款后标记已到账，无法打款则驳回退余额。同人同时仅一笔待审、每日限次由后端把关" />

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map(([key, label]) => (
          <Button key={key || "all"} size="sm" variant={status === key ? "default" : "outline"} onClick={() => { setStatus(key); setOffset(0); }}>
            {label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setTick((t) => t + 1)}>刷新</Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>买家</TableHead><TableHead>提现金额</TableHead><TableHead>收款方式</TableHead>
              <TableHead>收款信息</TableHead><TableHead>状态</TableHead><TableHead>提交时间</TableHead><TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-sm">{r.user?.nickname ?? "—"}
                  <div className="text-xs text-muted-foreground">{r.user?.username ?? r.user_id.slice(0, 8)}</div>
                </TableCell>
                <TableCell className="text-sm">{formatBase(r.amount_base)}
                  <div className="text-xs text-muted-foreground">{r.currency_code}</div>
                </TableCell>
                <TableCell className="text-sm">{methodText(r.method)}</TableCell>
                <TableCell className="text-xs">
                  <div className="flex min-w-40 flex-col gap-0.5">
                    {payoutEntries(r).map((e) => (
                      <p key={e.key} className="text-muted-foreground">
                        <span className="mr-1">{payoutLabel(e.key)}</span>
                        <span className="break-all text-foreground">{e.value}</span>
                      </p>
                    ))}
                  </div>
                </TableCell>
                <TableCell><WithdrawBadge status={r.status} /></TableCell>
                <TableCell className="text-xs text-muted-foreground">{fmtTime(r.created_at)}</TableCell>
                <TableCell>
                  <Button size="sm" variant="ghost" onClick={() => setOpenId(r.id)}>{r.status === "PENDING" ? "审核" : "详情"}</Button>
                </TableCell>
              </TableRow>
            ))}
            {!rows?.length && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">{rows ? "没有提现申请" : error || "加载中…"}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center gap-3 text-sm">
        <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</Button>
        <span className="text-muted-foreground">第 {Math.floor(offset / 20) + 1} 页</span>
        <Button size="sm" variant="outline" disabled={!page.has_more || page.next_offset === null} onClick={() => setOffset(page.next_offset ?? offset + 20)}>下一页</Button>
      </div>
    </div>
  );
}
