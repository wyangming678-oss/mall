// 后台邀请返利：CY3 规则配置 / CY4 关系与奖励报表 / CY5 奖励撤销（权限点 invite.read / invite.manage）
import { useEffect, useState } from "react";
import { call, newIdem } from "../../api";
import { baseUnit, formatBase } from "../../const";
import { useSite, type InviteRulesConfig, type InviteTriggerRule } from "../../site";
import { useAdmin } from "../AdminAuth";
import { PageTitle, Toolbar, errText, isConfirmCancel, riskyPost, useBusy } from "../ui";
import type {
  CouponTemplateRow, InviteRewardBrief, InviteRewardRow, InviteRelationRow, Paged, UserRow,
} from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { couponRuleText, yuanToCents } from "../../trade";

const PAGE = 20;
type TriggerKey = "first_register" | "first_order" | "first_recharge";
const TRIGGER_KEYS: TriggerKey[] = ["first_register", "first_order", "first_recharge"];
const TRIGGER_TEXT: Record<string, string> = {
  first_register: "注册奖励", first_order: "首单奖励", first_recharge: "首充奖励",
};
const REWARD_STATUS_TEXT: Record<string, string> = { PENDING: "待到账", AVAILABLE: "已到账", REVOKED: "已撤销" };
const REWARD_TYPE_TEXT: Record<string, string> = { balance: "余额", coupon: "优惠券", coin: "金币" };
type RewardType = "balance" | "coupon" | "coin";
const STATUS_TONE: Record<string, "default" | "secondary" | "destructive"> = {
  PENDING: "secondary", AVAILABLE: "default", REVOKED: "destructive",
};
const TRIGGER_TONE: Record<string, "default" | "secondary" | "outline"> = {
  first_register: "outline", first_order: "secondary", first_recharge: "secondary",
};

// —— CY3 规则草稿（金额以「元」录入，提交换算为分；coin 的数额在「金币规则」页，不在这里）——
interface TriggerDraft {
  enabled: boolean;
  reward_type: RewardType;
  reward_yuan: string;
  template_id: string;
  delay_minutes: string;
  basis: "paid" | "completed";
  min_yuan: string;
}
interface RuleDraft {
  triggers: Record<TriggerKey, TriggerDraft>;
  invitee_template_id: string;
  total_cap: string;
  daily_cap: string;
  note: string;
}

const OFF_TRIGGER: TriggerDraft = {
  enabled: false, reward_type: "balance", reward_yuan: "", template_id: "",
  delay_minutes: "0", basis: "paid", min_yuan: "",
};

const toTriggerDraft = (r: InviteTriggerRule | undefined): TriggerDraft => (r ? {
  enabled: r.enabled === true,
  reward_type: r.reward_type === "coupon" ? "coupon" : r.reward_type === "coin" ? "coin" : "balance",
  reward_yuan: r.reward_type === "balance" && r.reward_value_base ? (r.reward_value_base / 100).toFixed(2) : "",
  template_id: r.coupon_template_id ?? "",
  delay_minutes: String(r.delay_minutes ?? 0),
  basis: r.basis === "completed" ? "completed" : "paid",
  min_yuan: r.min_amount_base ? (r.min_amount_base / 100).toFixed(2) : "",
} : { ...OFF_TRIGGER });

const toRuleDraft = (c: InviteRulesConfig | null): RuleDraft => ({
  triggers: {
    first_register: toTriggerDraft(c?.first_register),
    first_order: toTriggerDraft(c?.first_order),
    first_recharge: toTriggerDraft(c?.first_recharge),
  },
  invitee_template_id: c?.invitee_coupon_template_id ?? "",
  total_cap: String(c?.caps?.per_inviter_total ?? 0),
  daily_cap: String(c?.caps?.per_inviter_daily ?? 0),
  note: c?.note ?? "",
});

const centsOf = (v: string): number => yuanToCents(v) ?? 0;
const intOf = (v: string): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
};

function ruleError(d: RuleDraft, coinInviter: number | null): string {
  for (const k of TRIGGER_KEYS) {
    const t = d.triggers[k];
    if (!t.enabled) continue;
    const label = TRIGGER_TEXT[k];
    if (t.reward_type === "balance") {
      if (!yuanToCents(t.reward_yuan)) return `${label}：奖励金额需大于 0`;
    } else if (t.reward_type === "coupon") {
      if (!t.template_id) return `${label}：请选择奖励券模板`;
    } else if (coinInviter === 0) {
      return `${label}：金币奖励的数额取自「金币商城」页的「邀请人得金币」，当前为 0，填成大于 0 再保存`;
    }
    const delay = intOf(t.delay_minutes);
    if (!Number.isInteger(delay) || delay > 43200) return `${label}：延迟结算分钟数需为 0–43200 的整数`;
  }
  const total = intOf(d.total_cap);
  const daily = intOf(d.daily_cap);
  if (!Number.isInteger(total) || total > 1000000) return "每人累计上限需为 0–1000000 的整数（0 表示不限）";
  if (!Number.isInteger(daily) || daily > 100000) return "每人每日上限需为 0–100000 的整数（0 表示不限）";
  if (d.note.length > 500) return "用户可见说明不超过 500 字";
  return "";
}

const triggerBody = (t: TriggerDraft, withBasis: boolean) => ({
  enabled: t.enabled,
  reward_type: t.reward_type,
  reward_value_base: t.reward_type === "balance" ? centsOf(t.reward_yuan) : 0,
  coupon_template_id: t.reward_type === "coupon" && t.template_id ? t.template_id : null,
  delay_minutes: intOf(t.delay_minutes) || 0,
  ...(withBasis ? { basis: t.basis, min_amount_base: centsOf(t.min_yuan) } : {}),
});

const rulesBody = (d: RuleDraft) => ({
  first_register: triggerBody(d.triggers.first_register, false),
  first_order: triggerBody(d.triggers.first_order, true),
  first_recharge: triggerBody(d.triggers.first_recharge, false),
  invitee_coupon_template_id: d.invitee_template_id || null,
  caps: { per_inviter_total: intOf(d.total_cap) || 0, per_inviter_daily: intOf(d.daily_cap) || 0 },
  note: d.note.trim(),
});

const selectCls = "h-9 w-full rounded-md border bg-background px-2 text-sm";

const tplOptionText = (t: CouponTemplateRow) =>
  `${t.name}（${couponRuleText(t)}）${t.status === "on" ? "" : t.status === "archived" ? " · 已归档" : " · 已停用"}`;

function TemplateSelect({ templates, value, placeholder, disabled, onChange }: {
  templates: CouponTemplateRow[];
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const hit = templates.find((t) => t.id === value);
  return (
    <select className={selectCls} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {templates.map((t) => <option key={t.id} value={t.id}>{tplOptionText(t)}</option>)}
      {value && !hit && <option value={value}>当前模板 {value.slice(0, 8)}（不在列表中）</option>}
    </select>
  );
}

function TriggerCard({ k, draft, templates, coinInviter, disabled, onPatch }: {
  k: TriggerKey;
  draft: TriggerDraft;
  templates: CouponTemplateRow[];
  coinInviter: number | null;
  disabled: boolean;
  onPatch: (p: Partial<TriggerDraft>) => void;
}) {
  const label = TRIGGER_TEXT[k];
  const id = `ir-${k}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {label}
          <Badge variant={draft.enabled ? "default" : "secondary"}>{draft.enabled ? "已开启" : "未开启"}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input id={`${id}-on`} type="checkbox" className="size-4 accent-[var(--primary)]"
            disabled={disabled} checked={draft.enabled} onChange={(e) => onPatch({ enabled: e.target.checked })} />
          开启该触发点
        </label>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-type`}>奖励类型</Label>
          <select id={`${id}-type`} className={selectCls} disabled={disabled} value={draft.reward_type}
            onChange={(e) => onPatch({ reward_type: e.target.value as TriggerDraft["reward_type"] })}>
            <option value="balance">余额（直接入账）</option>
            <option value="coupon">优惠券（入券包）</option>
            <option value="coin">金币（入金币中心）</option>
          </select>
        </div>
        {draft.reward_type === "balance" ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-amt`}>{`奖励金额（${baseUnit()}）`}</Label>
            <Input id={`${id}-amt`} disabled={disabled} value={draft.reward_yuan}
              onChange={(e) => onPatch({ reward_yuan: e.target.value })} placeholder="50" />
          </div>
        ) : draft.reward_type === "coin" ? (
          <div className="flex flex-col gap-1">
            <Label>每次到账金币数</Label>
            <p className="text-sm">
              {coinInviter === null ? "数值在「金币商城 → 邀请返金币」里填写（当前账号读不到，请到该页确认）"
                : coinInviter > 0 ? `${coinInviter} 金币` : "当前是 0，这样开启后不会登记任何奖励"}
            </p>
            <p className="text-xs text-muted-foreground">
              金币数额只有一个入口：「金币商城」页的「邀请人得金币」，两处分开填会出现对不上的到账数。
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-tpl`}>奖励券模板</Label>
            <TemplateSelect templates={templates} value={draft.template_id} disabled={disabled}
              placeholder="（选择券模板）" onChange={(v) => onPatch({ template_id: v })} />
          </div>
        )}
        {k === "first_order" && (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-basis`}>结算口径</Label>
              <select id={`${id}-basis`} className={selectCls} disabled={disabled} value={draft.basis}
                onChange={(e) => onPatch({ basis: e.target.value as TriggerDraft["basis"] })}>
                <option value="paid">订单支付成功即登记</option>
                <option value="completed">订单完成后登记</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-min`}>{`订单实付门槛（${baseUnit()}，0 表示不限）`}</Label>
              <Input id={`${id}-min`} disabled={disabled} value={draft.min_yuan}
                onChange={(e) => onPatch({ min_yuan: e.target.value })} placeholder="0" />
            </div>
          </>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-delay`}>延迟结算（分钟，0 表示立即到账）</Label>
          <Input id={`${id}-delay`} type="number" min={0} max={43200} disabled={disabled}
            value={draft.delay_minutes} onChange={(e) => onPatch({ delay_minutes: e.target.value })} />
        </div>
      </CardContent>
    </Card>
  );
}

// —— CY3 规则编辑器 ——
function RuleEditor({ saved, templates, tplError, coinInviter, canManage, onSaved }: {
  saved: InviteRulesConfig | null;
  templates: CouponTemplateRow[];
  tplError: string;
  coinInviter: number | null;
  canManage: boolean;
  onSaved: (saved: InviteRulesConfig) => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(() => toRuleDraft(saved));
  const [error, setError] = useState("");
  const [busy, run] = useBusy();
  const disabled = !canManage;

  const patch = (p: Partial<RuleDraft>) => { setDraft((d) => ({ ...d, ...p })); setError(""); };
  const patchTrigger = (k: TriggerKey, p: Partial<TriggerDraft>) => {
    setDraft((d) => ({ ...d, triggers: { ...d.triggers, [k]: { ...d.triggers[k], ...p } } }));
    setError("");
  };

  async function onSave() {
    const invalid = ruleError(draft, coinInviter);
    if (invalid) { setError(invalid); return; }
    setError("");
    await run(async () => {
      try {
        const saved = await call<InviteRulesConfig>("admin/invite/rule/save", {
          method: "POST", token: "admin", idem: newIdem(), body: { invite_rules: rulesBody(draft) },
        });
        onSaved(saved);
      } catch (e) {
        setError(errText(e));
      }
    });
  }

  const enabledCount = TRIGGER_KEYS.filter((k) => draft.triggers[k].enabled).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TRIGGER_KEYS.map((k) => (
          <TriggerCard key={k} k={k} templates={templates} coinInviter={coinInviter} disabled={disabled}
            draft={draft.triggers[k]} onPatch={(p) => patchTrigger(k, p)} />
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle>被邀请人侧与防刷</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="ir-invitee">被邀请人注册即送券</Label>
              <TemplateSelect templates={templates} value={draft.invitee_template_id} disabled={disabled}
                placeholder="（不送券）" onChange={(v) => patch({ invitee_template_id: v })} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ir-total">每位邀请人累计到账上限（张）</Label>
              <Input id="ir-total" type="number" min={0} disabled={disabled} value={draft.total_cap}
                onChange={(e) => patch({ total_cap: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ir-daily">每位邀请人单日到账上限（张）</Label>
              <Input id="ir-daily" type="number" min={0} disabled={disabled} value={draft.daily_cap}
                onChange={(e) => patch({ daily_cap: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-3">
              <Label htmlFor="ir-note">用户可见说明（个人主页「我的邀请」展示）</Label>
              <textarea id="ir-note" rows={2} maxLength={500} disabled={disabled}
                className="rounded-md border bg-background px-2 py-1 text-sm"
                value={draft.note} onChange={(e) => patch({ note: e.target.value })}
                placeholder="奖励将在满足条件后自动到账，作弊订单可被撤销。" />
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            上限按「已到账」奖励计数，0 表示不限；规则修改只影响之后的发放，已到账奖励不受影响。
          </p>
        </CardContent>
      </Card>

      {tplError && <p className="text-sm text-muted-foreground">券模板列表不可用：{tplError}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {canManage ? (
        <div className="flex items-center gap-2">
          <Button onClick={() => void onSave()} disabled={busy}>{busy ? "保存中…" : "保存规则"}</Button>
          <Button variant="outline" disabled={busy} onClick={() => { setDraft(toRuleDraft(saved)); setError(""); }}>还原为当前生效值</Button>
          <span className="text-sm text-muted-foreground">已开启 {enabledCount} / 3 个触发点</span>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">当前账号缺少 invite.manage 权限，规则为只读。</p>
      )}
    </div>
  );
}

// —— 按邀请人筛选（复用 user.read 的用户搜索）——
function InviterPicker({ canSearch, value, onChange }: {
  canSearch: boolean;
  value: string;
  onChange: (id: string) => void;
}) {
  const [kw, setKw] = useState("");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [busy, run] = useBusy();
  const [error, setError] = useState("");
  if (!canSearch) return null;

  const search = () => {
    setError("");
    void run(async () => {
      try {
        const r = await call<Paged<UserRow>>("admin/users", { token: "admin", query: { keyword: kw || undefined } });
        setUsers(r.items);
      } catch (e) {
        setError(errText(e));
      }
    });
  };

  const picked = users.find((u) => u.id === value);
  return (
    <span className="flex flex-col gap-1">
      <Label htmlFor="ip-kw">按邀请人筛选</Label>
      <span className="flex flex-wrap items-center gap-2">
        <Input id="ip-kw" className="h-9 w-40" placeholder="用户名/昵称" value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }} />
        <Button variant="outline" onClick={search} disabled={busy}>搜索</Button>
        {value && (
          <Button variant="ghost" size="sm" onClick={() => onChange("")}>
            清除：{picked?.username ?? value.slice(0, 8)}
          </Button>
        )}
      </span>
      <span className="flex max-h-20 flex-wrap gap-1 overflow-y-auto">
        {users.map((u) => (
          <button key={u.id} type="button" onClick={() => onChange(u.id === value ? "" : u.id)}
            className={"rounded-md border px-3 py-1 text-xs transition "
              + (u.id === value ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary")}>
            {u.username}
          </button>
        ))}
      </span>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}

const rewardValueText = (v: number): string => `${v} 金币`;

const briefText = (r: InviteRewardBrief): string => {
  const amount = r.reward_type === "coupon" ? "优惠券"
    : r.reward_type === "coin" ? rewardValueText(r.reward_value) : formatBase(r.reward_value);
  return `${TRIGGER_TEXT[r.trigger_type] ?? r.trigger_type} ${amount} · ${REWARD_STATUS_TEXT[r.status] ?? r.status}`;
};

const rewardAmountText = (r: InviteRewardRow, templates: CouponTemplateRow[]): string => {
  if (r.reward_type === "coin") return rewardValueText(r.reward_value);
  if (r.reward_type !== "coupon") return formatBase(r.reward_value);
  const t = templates.find((x) => x.id === r.coupon_template_id);
  return t ? t.name : `券 ${r.coupon_template_id?.slice(0, 8) ?? "—"}`;
};

function Pager({ offset, hasMore, onMove }: { offset: number; hasMore: boolean; onMove: (o: number) => void }) {
  return (
    <div className="flex items-center gap-3 text-sm text-muted-foreground">
      <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => onMove(Math.max(0, offset - PAGE))}>上一页</Button>
      <span>第 {Math.floor(offset / PAGE) + 1} 页 · 每页 {PAGE} 条</span>
      <Button size="sm" variant="outline" disabled={!hasMore} onClick={() => onMove(offset + PAGE)}>下一页</Button>
    </div>
  );
}

export default function InvitesPage() {
  const { has } = useAdmin();
  const { config, refresh } = useSite();
  const [tab, setTab] = useState<"rules" | "relations" | "rewards">("rules");
  const [ruleTick, setRuleTick] = useState(0);
  const [templates, setTemplates] = useState<CouponTemplateRow[]>([]);
  const [tplError, setTplError] = useState("");
  const [rows, setRows] = useState<InviteRelationRow[]>([]);
  const [rewards, setRewards] = useState<InviteRewardRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [inviterId, setInviterId] = useState("");
  const [status, setStatus] = useState("");
  const [trigger, setTrigger] = useState("");
  const [listError, setListError] = useState("");
  const [tick, setTick] = useState(0);
  const [savedRules, setSavedRules] = useState<InviteRulesConfig | null>(null);
  // 金币类邀请奖励的数额来自「金币规则」，这里只读取用于展示与校验；无 coin.manage 权限时为 null（不拦保存）
  const [coinInviter, setCoinInviter] = useState<number | null>(null);
  const [busy, run] = useBusy();

  const canManage = has("invite.manage");

  useEffect(() => {
    let alive = true;
    call<{ invite_reward: { inviter: number } }>("admin/coin/rules", { token: "admin" })
      .then((r) => { if (alive) setCoinInviter(Number(r?.invite_reward?.inviter) || 0); })
      .catch(() => { if (alive) setCoinInviter(null); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    void run(async () => {
      try {
        const r = await call<Paged<CouponTemplateRow>>("admin/coupon-templates", { token: "admin" });
        if (alive) setTemplates(r.items);
      } catch (e) {
        if (alive) setTplError(errText(e));
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === "rules") return;
    let alive = true;
    setListError("");
    void run(async () => {
      try {
        const r = await call<Paged<InviteRelationRow>>("admin/invite/overview", {
          token: "admin",
          query: {
            scope: tab,
            offset,
            inviter_id: inviterId || undefined,
            status: tab === "rewards" && status ? status : undefined,
            trigger_type: tab === "rewards" && trigger ? trigger : undefined,
          },
        });
        if (!alive) return;
        setHasMore(r.has_more === true);
        if (tab === "relations") setRows(r.items);
        else setRewards(r.items as unknown as InviteRewardRow[]);
      } catch (e) {
        if (alive) setListError(errText(e));
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, offset, inviterId, status, trigger, tick]);

  async function revoke(r: InviteRewardRow) {
    const reason = window.prompt(
      `撤销奖励：${TRIGGER_TEXT[r.trigger_type]} · ${rewardAmountText(r, templates)}（${r.inviter.username}）\n`
      + "余额将反向冲正、金币将从金币账户扣回、优惠券将被撤回，原始记录保留。请填写撤销原因（可留空）",
      "",
    );
    if (reason === null) return;
    try {
      await riskyPost("admin/invite/revoke-reward", { reward_id: r.id, reason },
        `撤销 ${r.inviter.username} 的${TRIGGER_TEXT[r.trigger_type]}`);
      setTick((k) => k + 1);
    } catch (e) {
      if (!isConfirmCancel(e)) window.alert(errText(e));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="邀请返利" desc="返利规则配置、邀请关系与奖励台账、违规奖励撤销（文档C CY3/CY4/CY5；权限点 invite.read / invite.manage）" />
      <div className="flex gap-2 text-sm">
        {([["rules", "返利规则"], ["relations", "邀请关系"], ["rewards", "奖励台账"]] as const).map(([k, label]) => (
          <button key={k} type="button"
            onClick={() => { setTab(k); setOffset(0); }}
            className={"rounded-md border px-4 py-1 transition "
              + (tab === k ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary")}>
            {label}
          </button>
        ))}
      </div>

      {tab === "rules" && (config ? (
        <RuleEditor key={ruleTick} saved={savedRules ?? config.invite_rules ?? null} templates={templates}
          tplError={tplError} coinInviter={coinInviter} canManage={canManage}
          onSaved={(rules) => { setSavedRules(rules); setRuleTick((k) => k + 1); void refresh(); }} />
      ) : (
        <p className="text-sm text-muted-foreground">加载站点配置中的返利规则…</p>
      ))}

      {tab !== "rules" && (
        <>
          <Toolbar>
            {tab === "rewards" && (
              <>
                <span className="flex flex-col gap-1">
                  <Label htmlFor="ov-status">奖励状态</Label>
                  <select id="ov-status" className="h-9 rounded-md border bg-background px-2 text-sm" value={status}
                    onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
                    <option value="">全部</option>
                    {Object.entries(REWARD_STATUS_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </span>
                <span className="flex flex-col gap-1">
                  <Label htmlFor="ov-trigger">触发点</Label>
                  <select id="ov-trigger" className="h-9 rounded-md border bg-background px-2 text-sm" value={trigger}
                    onChange={(e) => { setTrigger(e.target.value); setOffset(0); }}>
                    <option value="">全部</option>
                    {TRIGGER_KEYS.map((k) => <option key={k} value={k}>{TRIGGER_TEXT[k]}</option>)}
                  </select>
                </span>
              </>
            )}
            <InviterPicker canSearch={has("user.read")} value={inviterId}
              onChange={(id) => { setInviterId(id); setOffset(0); }} />
            <Button variant="outline" onClick={() => setTick((k) => k + 1)} disabled={busy}>刷新</Button>
          </Toolbar>
          {listError && <p className="text-sm text-destructive">{listError}</p>}

          {tab === "relations" ? (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>邀请人</TableHead><TableHead>被邀请人</TableHead><TableHead>渠道</TableHead>
                    <TableHead>绑定时间</TableHead><TableHead>产生的奖励</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-sm font-medium">
                        {r.inviter.username}{r.inviter.nickname ? `（${r.inviter.nickname}）` : ""}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.invitee.username}{r.invitee.nickname ? `（${r.invitee.nickname}）` : ""}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.channel || "—"}</TableCell>
                      <TableCell className="text-xs">{r.created_at?.slice(0, 16).replace("T", " ")}</TableCell>
                      <TableCell>
                        <span className="flex flex-wrap gap-1">
                          {r.rewards.map((rw) => (
                            <Badge key={rw.id} variant={STATUS_TONE[rw.status] ?? "secondary"}>{briefText(rw)}</Badge>
                          ))}
                          {!r.rewards.length && <span className="text-xs text-muted-foreground">无（规则未开启）</span>}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!rows.length && (
                    <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      暂无邀请关系：用户在注册链接中带上邀请码后自动绑定
                    </TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>邀请人</TableHead><TableHead>触发点</TableHead><TableHead>奖励</TableHead>
                    <TableHead>状态</TableHead><TableHead>登记时间</TableHead><TableHead>到账时间</TableHead><TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rewards.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-sm font-medium">
                        {r.inviter.username}{r.inviter.nickname ? `（${r.inviter.nickname}）` : ""}
                      </TableCell>
                      <TableCell>
                        <Badge variant={TRIGGER_TONE[r.trigger_type] ?? "outline"}>
                          {TRIGGER_TEXT[r.trigger_type] ?? r.trigger_type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {REWARD_TYPE_TEXT[r.reward_type] ?? r.reward_type} · {rewardAmountText(r, templates)}
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <Badge variant={STATUS_TONE[r.status] ?? "secondary"}>{REWARD_STATUS_TEXT[r.status] ?? r.status}</Badge>
                          {r.status === "PENDING" && (
                            <span className="text-xs text-muted-foreground">按现行规则结算</span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">{r.created_at?.slice(0, 16).replace("T", " ")}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.available_at ? r.available_at.slice(0, 16).replace("T", " ") : "—"}
                      </TableCell>
                      <TableCell>
                        {canManage && r.status === "AVAILABLE" && (
                          <Button size="sm" variant="ghost" className="text-destructive"
                            disabled={busy} onClick={() => void revoke(r)}>撤销</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!rewards.length && (
                    <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                      暂无奖励记录：先在「返利规则」中开启触发点
                    </TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
          <Pager offset={offset} hasMore={hasMore} onMove={setOffset} />
          <p className="text-xs text-muted-foreground">
            奖励原始记录只追加不修改：撤销会保留原记录并生成反向流水或撤回券，便于事后核对。
          </p>
        </>
      )}
    </div>
  );
}
