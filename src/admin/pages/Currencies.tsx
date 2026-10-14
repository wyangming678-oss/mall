import { useEffect, useState } from "react";
import { useSite } from "../../site";
import { PageTitle, errText, riskyPost, useBusy } from "../ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CurrencyItem } from "../../site";

export default function CurrenciesPage() {
  const { currencies, config, refresh } = useSite();
  const [busy, run] = useBusy();
  const [error, setError] = useState("");
  const [form, setForm] = useState({ code: "", symbol: "", name_zh: "", rate_scaled: "", status: "on" });
  const [existing, setExisting] = useState<CurrencyItem | null>(null);
  const baseCode = config?.currency?.base ?? "";
  const [base, setBase] = useState(baseCode);
  const [baseBusy, runBase] = useBusy();
  const [baseError, setBaseError] = useState("");
  useEffect(() => { setBase(config?.currency?.base ?? ""); }, [config?.currency?.base]);

  async function saveBase() {
    setBaseError("");
    await runBase(async () => {
      try {
        await riskyPost("admin/currency/base", { base }, `切换站点本位币为 ${base}（记账币种，历史订单汇率快照不受影响）`);
        await refresh();
      } catch (e) {
        setBaseError(errText(e));
      }
    });
  }

  function startEdit(c: CurrencyItem) {
    setExisting(c);
    setForm({
      code: c.code,
      symbol: c.symbol,
      name_zh: c.name_i18n?.zh ?? "",
      rate_scaled: String(c.rate_scaled),
      status: c.status,
    });
  }

  async function save() {
    setError("");
    try {
      await riskyPost("admin/currency/save", {
        code: form.code.toUpperCase(),
        symbol: form.symbol,
        // 币种 name_i18n 是整键替换保存：只带 zh 会把 en/ja/ko/es 名称抹掉，必须带着原行合并
        name_i18n: { ...(existing?.name_i18n ?? {}), zh: form.name_zh || form.code },
        rate_scaled: Number(form.rate_scaled),
        status: form.status,
      }, `维护币种 ${form.code.toUpperCase()} 汇率 ${form.rate_scaled}`);
      setExisting(null);
      setForm({ code: "", symbol: "", name_zh: "", rate_scaled: "", status: "on" });
      await refresh();
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="币种与汇率" desc="记账一律本位币分；下方币种表的汇率是「1 本位币分 = ? ×1e-6 展示分」。改本位币只重贴记账标签、影响未来展示换算；历史订单已按下单时刻汇率快照锁定，不受影响。" />
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-col gap-3 border p-4">
        <div className="text-sm font-medium">站点本位币（记账币种）</div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="cu-base">当前本位币</Label>
            <select id="cu-base" className="h-9 rounded-md border bg-background px-2 text-sm" value={base} onChange={(e) => setBase(e.target.value)}>
              {currencies.filter((c) => c.status === "on").map((c) => (
                <option key={c.code} value={c.code}>{c.symbol} {c.code}（{c.name_i18n?.zh ?? c.code}）</option>
              ))}
            </select>
          </div>
          <Button disabled={baseBusy || base === baseCode || !base} onClick={() => void saveBase()}>
            {baseBusy ? "保存中…" : base === baseCode ? "已是当前本位币" : "保存本位币"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          当前记账本位币为 <b className="font-mono">{baseCode || "未设置"}</b>。切换后，商品与钱包「计价基准」将改用新本位币符号展示，历史金额数值不变。
          若切换记账币种，请按新本位币重新录入各展示币种相对它的汇率，并以新本位币重新定价商品；已下单的历史订单仍按当时汇率与币种快照展示，不会重算。
        </p>
        {baseError && <p className="text-sm text-destructive">{baseError}</p>}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>代码</TableHead><TableHead>符号</TableHead><TableHead>名称(zh)</TableHead>
            <TableHead>汇率(1e-6 缩放)</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {currencies.map((c) => (
            <TableRow key={c.code}>
              <TableCell className="font-mono font-medium">{c.code}</TableCell>
              <TableCell>{c.symbol}</TableCell>
              <TableCell>{c.name_i18n?.zh ?? "—"}</TableCell>
              <TableCell>{c.rate_scaled.toLocaleString()}</TableCell>
              <TableCell><Badge variant={c.status === "on" ? "secondary" : "destructive"}>{c.status}</Badge></TableCell>
              <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => startEdit(c)}>编辑</Button></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border p-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="cu-code">币种代码（3 大写）</Label>
          <Input id="cu-code" value={form.code} disabled={!!existing} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} maxLength={3} className="w-24" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="cu-symbol">符号</Label>
          <Input id="cu-symbol" value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} maxLength={8} className="w-20" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="cu-name">中文名称</Label>
          <Input id="cu-name" value={form.name_zh} onChange={(e) => setForm({ ...form, name_zh: e.target.value })} className="w-32" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="cu-rate">rate_scaled（本位币 1 分 = ? ×1e-6 展示分）</Label>
          <Input id="cu-rate" type="number" value={form.rate_scaled} onChange={(e) => setForm({ ...form, rate_scaled: e.target.value })} className="w-44" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="cu-status">状态</Label>
          <select id="cu-status" className="h-9 rounded-md border bg-background px-2 text-sm" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="on">on</option><option value="off">off</option>
          </select>
        </div>
        <Button disabled={busy} onClick={() => void save()}>{existing ? "保存修改" : "新增币种"}</Button>
        {existing && <Button variant="outline" onClick={() => { setExisting(null); setForm({ code: "", symbol: "", name_zh: "", rate_scaled: "", status: "on" }); }}>取消</Button>}
      </div>
    </div>
  );
}
