// 凭证审核工作台 PF1–PF4（文档C §六.3；审核位认领 + 心跳续期 + 高危审核）
import { useCallback, useEffect, useState } from "react";
import { ApiError, call, newIdem } from "../../api";
import { useSite } from "../../site";
import { formatBase } from "../../const";
import { useAdmin } from "../AdminAuth";
import { PageTitle, errText, isConfirmCancel, riskyPost } from "../ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  METHOD_TEXT, PAYMENT_ROW_TEXT, PAYMENT_TYPE_TEXT, coinOf, fmtTime, money, symbolOf,
} from "../../trade";

interface QueueItem {
  id: string;
  payment_type: string;
  target_id: string;
  user_id: string;
  method: string;
  amount_base: number;
  amount_currency: number;
  currency_code: string;
  installment_index: number | null;
  // 文档L §2.5：加密货币分项在出票/上传凭证当刻定格的币种快照，非加密货币分项为 null
  coin_symbol: string | null;
  coin_network: string | null;
  coin_units: number | null;
  coin_decimals: number | null;
  status: string;
  created_at: string;
  order: { id: string; order_no: string; actual_paid_amount_base: number; payment_deadline: string; status_payment: string } | null;
  proof: { id: string; transaction_no: string | null; amount_declared: number; review_status: string; created_at: string; image_url: string | null } | null;
  slot: { held: boolean; mine: boolean; reserved_at: string | null };
}
interface QueuePage {
  offset: number; limit: number; has_more: boolean; next_offset: number | null;
  items: QueueItem[]; counts_by_type: Record<string, number>;
}

const TABS: Array<[string, string]> = [
  ["", "全部"],
  ["ORDER_PAYMENT", "订单付款"],
  ["WALLET_RECHARGE", "钱包充值"],
];

/** PF2 续期间隔：审核位 TTL 15 分钟，取 4 分钟留三次余量 */
const HEARTBEAT_MS = 4 * 60 * 1000;

/** 分期分项的期序标签（1=首付，其余「第 N 期」；普通全额/历史单为 null） */
const periodLabel = (idx: number | null | undefined) =>
  idx === null || idx === undefined ? null : Number(idx) === 1 ? "首付" : `第 ${Number(idx)} 期`;

function ReviewPanel({ item, symbol, onDone }: {
  item: QueueItem; symbol: string; onDone: (msg: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function decide(decision: "approve" | "reject") {
    if (decision === "reject" && reason.trim().length < 2) {
      setError("驳回原因至少 2 个字");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await riskyPost<{ order_paid?: boolean; order_status_after?: string; credited_balance_after: number | null }>(
        "admin/proof/review",
        { payment_id: item.id, decision, reject_reason: decision === "reject" ? reason.trim() : undefined },
        decision === "approve" ? "确认到账" : "驳回凭证",
      );
      onDone(decision === "approve"
        ? (item.payment_type === "WALLET_RECHARGE"
          ? `充值已入账，余额 ${money(Number(r.credited_balance_after ?? 0), symbol)}`
          : item.installment_index !== null && item.installment_index !== undefined
            ? `分期「${periodLabel(item.installment_index)}」款项已确认到账`
            : r.order_paid ? "凭证已通过，订单已转「已付款」并扣减库存" : "凭证已通过，订单仍有未付分项，暂未转「已付款」")
        : "已驳回，订单支付维转为「已驳回」，支付时限不变");
    } catch (e) {
      if (!isConfirmCancel(e)) setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/30 p-3">
      <span className="flex flex-col gap-1">
        <Label htmlFor="pf-reason">驳回原因（驳回时必填）</Label>
        <Input id="pf-reason" className="h-8 w-64" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      </span>
      <Button size="sm" disabled={busy} onClick={() => void decide("approve")}>确认到账</Button>
      <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => void decide("reject")}>驳回</Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

export default function AdminProofsPage() {
  const { has } = useAdmin();
  const { currencies } = useSite();
  const [type, setType] = useState("");
  const [rows, setRows] = useState<QueueItem[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ has_more: boolean; next_offset: number | null }>({ has_more: false, next_offset: null });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [held, setHeld] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setError("");
    try {
      const r = await call<QueuePage>("admin/proof/queue", { token: "admin", query: { offset } });
      setRows(type ? r.items.filter((it) => it.payment_type === type) : r.items);
      setCounts(r.counts_by_type ?? {});
      setPage({ has_more: r.has_more, next_offset: r.next_offset });
    } catch (e) {
      setRows([]);
      setError(errText(e));
    }
  }, [offset, type, tick]);

  useEffect(() => { void load(); }, [load]);

  // 持有审核位期间续期（PF2），失败即视为失效
  useEffect(() => {
    if (!held) return undefined;
    const timer = window.setInterval(() => {
      call("admin/proof/heartbeat", { method: "POST", token: "admin", body: { payment_id: held } })
        .then(() => setNotice("审核位已续期（剩余有效期 15 分钟）"))
        .catch(() => { setHeld(null); setOpenId(null); setNotice("审核位已失效，请重新认领"); void load(); });
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [held, load]);

  if (!has("payment.review")) {
    return <p className="text-sm text-muted-foreground">当前账号缺少凭证审核权限（payment.review）。</p>;
  }

  async function claim(item: QueueItem) {
    setError("");
    setNotice("");
    try {
      const r = await call<{ payment_id: string; renewed?: boolean; taken_over?: boolean }>(
        "admin/proof/claim", { method: "POST", token: "admin", idem: newIdem(), body: { payment_id: item.id } },
      );
      setHeld(r.payment_id);
      setOpenId(item.id);
      setNotice(r.renewed ? "已续期当前审核位" : r.taken_over ? "已接管上一位审核人的审核位" : "已认领审核位（15 分钟内有效）");
    } catch (e) {
      if (e instanceof ApiError && e.code === "audit_slot_held") setError("该凭证正被其他管理员审核，请稍后重试");
      else setError(errText(e));
    }
  }

  const list = rows ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="凭证审核" desc="PF4 待审队列 → PF1 认领审核位 → PF3 确认到账 / 驳回（⚠ 二次确认并写入审计）" />

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map(([key, label]) => (
          <Button
            key={key || "all"} size="sm" variant={type === key ? "default" : "outline"}
            onClick={() => { setType(key); setOffset(0); }}
          >
            {label}{key && counts[key] ? ` · ${counts[key]}` : ""}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => { setTick((t) => t + 1); setNotice(""); }}>刷新</Button>
        {held && (
          <Button size="sm" variant="outline" onClick={() => { setHeld(null); setNotice("已放弃当前审核位视图（服务端审核位到期自动释放）"); }}>
            放弃当前审核位
          </Button>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && <p className="text-sm text-primary">{notice}</p>}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>类型</TableHead><TableHead>订单号</TableHead><TableHead>渠道</TableHead>
              <TableHead>应到账</TableHead><TableHead>申报 / 流水号</TableHead><TableHead>凭证</TableHead>
              <TableHead>提交时间</TableHead><TableHead>审核位</TableHead><TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((it) => {
              const symbol = symbolOf(currencies, it.currency_code);
              const mine = held === it.id || it.slot.mine;
              const declared = it.proof ? Number(it.proof.amount_declared) : null;
              const mismatch = declared !== null && declared !== Number(it.amount_currency);
              // 加密货币收款：本位币数字对不上链上到账，审核真正要比的是这串币数（文档L §2.2 向上取整，到账 ≥ 即通过）
              const coin = it.coin_symbol ? coinOf(it.coin_units, it.coin_decimals) : null;
              return (
                <TableRow key={it.id}>
                  <TableCell className="text-sm">{PAYMENT_TYPE_TEXT[it.payment_type] ?? it.payment_type}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {it.order?.order_no ?? <span className="text-muted-foreground">充值 · {it.user_id.slice(0, 8)}</span>}
                    {periodLabel(it.installment_index) && (
                      <div className="text-[11px] font-normal text-primary">分期 · {periodLabel(it.installment_index)}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{METHOD_TEXT[it.method] ?? it.method}</TableCell>
                  <TableCell className="text-sm">
                    {formatBase(Number(it.amount_base))}
                    <div className="text-xs text-muted-foreground">{money(Number(it.amount_currency), symbol)}</div>
                    {coin !== null && it.coin_symbol && (
                      <div className="text-xs font-medium text-primary">
                        应收 {coin} {it.coin_symbol}{it.coin_network ? `（${it.coin_network}）` : ""}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {it.proof ? (
                      <span className={mismatch ? "text-destructive" : ""}>
                        {money(declared ?? 0, symbol)} / {it.proof.transaction_no ?? "—"}
                        {mismatch && <div>申报金额与分项不符</div>}
                      </span>
                    ) : <span className="text-muted-foreground">凭证未提交</span>}
                  </TableCell>
                  <TableCell className="text-xs">
                    {it.proof?.image_url
                      ? <a href={it.proof.image_url} target="_blank" rel="noreferrer" className="text-primary underline">查看截图</a>
                      : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtTime(it.created_at)}</TableCell>
                  <TableCell className="text-xs">
                    {mine
                      ? <Badge>我持有</Badge>
                      : it.slot.held
                        ? <Badge variant="destructive">他人审核中</Badge>
                        : <Badge variant="outline">空闲</Badge>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {!mine && <Button size="sm" variant="outline" disabled={it.slot.held} onClick={() => void claim(it)}>认领</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setOpenId(openId === it.id ? null : it.id)}>
                        {openId === it.id ? "收起" : "审核"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {!list.length && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  {rows ? "没有待审核的转账凭证" : error || "加载中…"}
                </TableCell>
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

      {list.filter((it) => openId === it.id).map((it) => {
        const symbol = symbolOf(currencies, it.currency_code);
        const coin = it.coin_symbol ? coinOf(it.coin_units, it.coin_decimals) : null;
        return (
          <Card key={it.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <span>{it.order?.order_no ?? `充值 ${it.user_id.slice(0, 8)}`}</span>
                {periodLabel(it.installment_index) && (
                  <Badge variant="outline" className="border-primary text-primary">分期 · {periodLabel(it.installment_index)}</Badge>
                )}
                <Badge variant="secondary">{PAYMENT_ROW_TEXT[it.status] ?? it.status}</Badge>
                {it.order && (
                  <span className="text-xs font-normal text-muted-foreground">
                    订单应付 {formatBase(Number(it.order.actual_paid_amount_base))} · 支付时限 {fmtTime(it.order.payment_deadline)}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {coin !== null && it.coin_symbol && (
                <p className="border-l-4 border-primary bg-muted/30 px-3 py-2 text-sm">
                  客户所选币种 <b>{it.coin_symbol}{it.coin_network ? ` / ${it.coin_network}` : ""}</b>，
                  应付 <b className="text-primary">{coin} {it.coin_symbol}</b>
                  <span className="text-xs text-muted-foreground">
                    ——这是出票当刻按当时参考汇率算出的数，客户照它转账；链上到账 ≥ 它即可通过。
                    本位币 {formatBase(Number(it.amount_base))} 只作记账口径，不与币数比对。
                  </span>
                </p>
              )}
              {it.proof?.image_url
                ? <img src={it.proof.image_url} alt="转账凭证" className="max-h-96 rounded-lg border object-contain" />
                : <p className="text-sm text-muted-foreground">该分项还没有上传转账截图。</p>}
              {it.proof && (
                <p className="text-sm text-muted-foreground">
                  流水号 {it.proof.transaction_no ?? "—"} · 申报 {money(Number(it.proof.amount_declared), symbol)} · 上传于 {fmtTime(it.proof.created_at)}
                </p>
              )}
              {held === it.id
                ? <ReviewPanel item={it} symbol={symbol} onDone={(msg) => { setNotice(msg); setHeld(null); setOpenId(null); setTick((t) => t + 1); }} />
                : <p className="text-sm text-muted-foreground">需先「认领」审核位，才能通过或驳回该凭证。</p>}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
