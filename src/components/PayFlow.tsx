// 扫码支付共享件：收款码凭据（Y3/W2 响应）+ 转账凭证上传（Y4）
import { useState, type ChangeEvent } from "react";
import { call, newIdem, uploadImageKey } from "../api";
import { getBaseSymbol, pickLocalized } from "../const";
import { money, methodLabel, shopErr, symbolOf, type CoinChain, type PaymentRow } from "../trade";
import { useSite } from "../site";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface QrTicket {
  payment_id: string;
  amount_base: number;
  amount_currency: number;
  currency_code: string;
  payment_deadline?: string | null;
  channel: {
    method: string; image_url: string | null;
    holder_name?: string; account_no?: string; pay_link?: string; account_note?: string | null;
    account_note_i18n?: Record<string, string> | null;
    chains?: CoinChain[];
  };
  transfer_reference: string;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useSite();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 break-all font-mono text-foreground">{value}</code>
      <Button
        type="button" size="sm" variant="outline"
        onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      >{t("common.copy", "复制")}</Button>
      {copied && <span className="text-xs text-primary">{t("common.copied", "已复制")}</span>}
    </div>
  );
}

function ChainPicker({ chains, idx, onIdx }: { chains: CoinChain[]; idx: number; onIdx: (i: number) => void }) {
  const { t, tf, lang } = useSite();
  const cur = chains[Math.min(idx, chains.length - 1)];
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <span className="text-sm font-medium">{t("pay.chain_pick", "选择收款币种")}</span>
      <div className="flex flex-wrap gap-2">
        {chains.map((c, i) => (
          <button
            key={`${c.symbol}-${i}`} type="button"
            aria-pressed={i === idx}
            // 店主没给该币设参考汇率就禁用：否则客户会看到「应付 30000」这种本位币数字去转币
            disabled={!c.quote}
            title={c.quote ? undefined : t("pay.coin_no_rate", "该币种尚未设置参考汇率，请改选其他币种或联系客服")}
            onClick={() => onIdx(i)}
            className={
              "border px-3 py-1 text-sm " +
              (i === idx ? "border-primary bg-primary text-primary-foreground"
                : c.quote ? "bg-background text-foreground" : "border-muted bg-muted text-muted-foreground line-through")
            }
          >{c.symbol}</button>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <CopyRow label={tf("pay.coin_address", { symbol: cur.symbol }, "{symbol} 地址")} value={cur.address} />
        {cur.network && <CopyRow label={t("pay.network", "网络 / 链")} value={cur.network} />}
      </div>
      {pickLocalized(cur.note_i18n, cur.note ?? "", lang) && (
        <p className="whitespace-pre-line text-sm text-muted-foreground">{pickLocalized(cur.note_i18n, cur.note ?? "", lang)}</p>
      )}
      <p className="text-xs text-muted-foreground">{t("pay.chain_warn", "请核对币种与网络后再转账，充错币种或链无法退回。")}</p>
    </div>
  );
}

export function QrTicketCard({ ticket, coinIdx, onCoinIdx }: {
  ticket: QrTicket;
  /** 所选收款币种下标（文档L）：由页面持有，出票与上传凭证都按它提交，票据上的金额/地址/收款码三处同步跟随 */
  coinIdx: number;
  onCoinIdx: (i: number) => void;
}) {
  const { config, currencies, t, tf, lang } = useSite();
  const symbol = symbolOf(currencies, ticket.currency_code);
  const { channel } = ticket;
  const channelName = methodLabel(config?.pay_channels, channel.method, t);
  const accountNote = pickLocalized(channel.account_note_i18n, channel.account_note ?? "", lang);
  const [copied, setCopied] = useState("");
  const chains = channel.chains ?? [];
  const cur = chains[Math.min(coinIdx, chains.length - 1)] ?? null;
  // quote 由后端按本分项金额算好：有 quote 才按币种计价，店主没设参考汇率时整张票据仍是账户币种旧样式
  const coin = cur?.quote ?? null;
  // 出票时后端已把「该币专属码，留空回落渠道级码」算进 chain.image_url，这里只需再兜一层旧数据
  const qrUrl = cur?.image_url ?? channel.image_url;
  const hasInfo = Boolean(channel.image_url || channel.holder_name || channel.account_no || channel.pay_link || accountNote || chains.length);
  return (
    <div className="flex flex-col gap-3 border bg-card p-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium">{t("pay.amount_due", "应付金额")}</span>
          <span className="text-2xl font-bold text-primary">{coin ? `${coin.amount} ${cur.symbol}` : money(ticket.amount_currency, symbol)}</span>
          {!coin && <span className="text-xs text-muted-foreground">{tf("common.paren", { v: ticket.currency_code }, "（{v}）")}</span>}
        </div>
        {coin && (
          <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            <span>{tf("pay.coin_equal", { amount: money(ticket.amount_currency, symbol) }, "等值 {amount}")}{tf("common.paren", { v: ticket.currency_code }, "（{v}）")}</span>
            <span>{tf("pay.coin_rate", { symbol: cur.symbol, rate: money(cur.rate_base_per_coin ?? 0, getBaseSymbol()) }, "1 {symbol} = {rate}")}</span>
          </div>
        )}
      </div>
      <ol className="flex flex-col gap-1 border-b pb-3 text-xs text-muted-foreground">
        <li>{t("pay.step1", "① 按下方收款信息，在对应 App／网银完成付款")}</li>
        <li>{t("pay.step2", "② 取得付款截图与流水号，在下方「上传付款凭证」提交")}</li>
        <li>{t("pay.step3", "③ 后台核对到账后订单自动生效，请耐心等待")}</li>
      </ol>
      {qrUrl && (
        <div className="grid place-items-center overflow-hidden border bg-muted p-2">
          <img src={qrUrl} alt={tf("pay.qr_alt", { method: coin ? cur.symbol : channelName }, "{method} 收款码")} className="max-h-60 object-contain" />
        </div>
      )}
      <div className="flex flex-col gap-2">
        {channel.holder_name && <CopyRow label={t("pay.holder_name", "收款户名")} value={channel.holder_name} />}
        {channel.account_no && <CopyRow label={t("pay.account_no", "收款账号")} value={channel.account_no} />}
        {channel.pay_link && <CopyRow label={t("pay.pay_link", "收款链接")} value={channel.pay_link} />}
      </div>
      {chains.length > 0 && <ChainPicker chains={chains} idx={coinIdx} onIdx={onCoinIdx} />}
      {accountNote && <p className="whitespace-pre-line text-sm text-muted-foreground">{accountNote}</p>}
      {!hasInfo && <p className="py-2 text-center text-xs text-muted-foreground">{t("pay.no_channel", "后台尚未配置该渠道收款信息，请联系客服确认收款方式")}</p>}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{t("pay.transfer_ref", "转账备注 / 单号")}</span>
        <code className="bg-accent px-2 py-1 font-mono text-accent-foreground">{ticket.transfer_reference}</code>
        <Button
          type="button" size="sm" variant="outline"
          onClick={() => { void navigator.clipboard?.writeText(ticket.transfer_reference); setCopied(t("common.copied", "已复制")); }}
        >{t("common.copy", "复制")}</Button>
        {copied && <span className="text-xs text-primary">{copied}</span>}
      </div>
    </div>
  );
}

const NO_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** 凭证上传只依赖分项的金额与身份，订单分项与会员开通分项共用 */
export function ProofUploadForm({ payment, chainIndex, onDone }: {
  payment: Pick<PaymentRow, "id" | "currency_code" | "amount_currency">;
  /** 票据上当前选中的收款币种下标；后端据此把「客户所选币种 + 应付币数」落进分项快照给审核看 */
  chainIndex?: number | null;
  onDone: () => void;
}) {
  const { currencies, t, tf } = useSite();
  const symbol = symbolOf(currencies, payment.currency_code);
  const [file, setFile] = useState<File | null>(null);
  const [txnNo, setTxnNo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!file) { setError(t("pay.err_file", "请选择转账截图")); return; }
    if (!NO_RE.test(txnNo.trim())) { setError(t("pay.err_txn_fmt", "流水号需为 4–64 位字母、数字、- 或 _")); return; }
    setBusy(true);
    setError("");
    try {
      const key = await uploadImageKey(file, "proofs");
      await call("pay/proof", {
        method: "POST", token: "user", idem: newIdem(),
        body: {
          payment_id: payment.id, image_key: key, transaction_no: txnNo.trim(),
          amount_declared: payment.amount_currency,
          ...(chainIndex === undefined || chainIndex === null ? {} : { chain_index: chainIndex }),
        },
      });
      setFile(null);
      setTxnNo("");
      onDone();
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setBusy(false);
    }
  }

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] ?? null);
    setError("");
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border bg-accent/40 p-4">
      <p className="text-sm font-medium">{tf("pay.proof_title", { id: payment.id.slice(0, 8) }, "上传转账凭证（分项 {id}）")}</p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">{t("pay.declared", "申报金额")}</span>
        <b>{money(payment.amount_currency, symbol)}</b>
        <span className="text-xs text-muted-foreground">{t("pay.declared_hint", "必须与实转金额一致")}</span>
      </div>
      <div className="flex flex-col gap-1">
        <Label>{t("pay.screenshot_label", "转账截图（jpg / png / webp，≤5MB）")}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={`pf-file-${payment.id}`}
            className={
              "inline-flex h-9 cursor-pointer items-center border px-3 text-sm " +
              (busy ? "pointer-events-none opacity-60" : "border-input bg-background hover:bg-accent")
            }
          >{t("pay.pick_file", "选择截图")}</label>
          {/* 裸 <input type=file> 的「选择文件 / 未选择任何文件」是浏览器控件文案，跟访客浏览器语言走，t() 管不到 ⇒ 藏起来自绘 */}
          <input
            id={`pf-file-${payment.id}`} type="file" accept="image/png,image/jpeg,image/webp"
            className="sr-only" onChange={pick} disabled={busy}
          />
          <span className="max-w-48 truncate text-xs text-muted-foreground">
            {file ? file.name : t("pay.no_file", "未选择文件")}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`pf-${payment.id}`}>{t("pay.txn_no", "转账流水号")}</Label>
        <Input id={`pf-${payment.id}`} maxLength={64} value={txnNo} onChange={(e) => setTxnNo(e.target.value)} placeholder={t("pay.txn_no_ph", "付款账单里的交易单号，或链上流水号（TxHash）")} disabled={busy} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button size="sm" onClick={() => void submit()} disabled={busy || !file}>
        {busy ? t("common.submitting", "提交中…") : t("pay.submit_proof", "提交凭证等待审核")}
      </Button>
    </div>
  );
}
