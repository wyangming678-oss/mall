// 二级页「我的邀请」：邀请码/链接/海报 + 邀请统计 + 奖励流水
import { useEffect, useState } from "react";
import { call } from "../api";
import { RedirectTo } from "../router";
import { useSite } from "../site";
import { displayAmount, getBaseSymbol } from "../const";
import { usableCurrencyCode } from "../trade";
import { CartLoading } from "../components/CartLoading";
import { InvitePoster } from "../components/InvitePoster";
import { SubHeader } from "../components/SubHeader";
import { Button } from "@/components/ui/button";

interface InviteReward {
  id: string; trigger_type: string; reward_type: "balance" | "coupon" | "coin";
  reward_value: number; status: "PENDING" | "AVAILABLE" | "REVOKED";
  available_at: string | null; created_at: string;
}
interface InviteSummary {
  invite_code: string; invite_link: string; invited_count: number;
  reward_stats: { PENDING: number; AVAILABLE: number; REVOKED: number };
  reward_amounts_base: { PENDING: number; AVAILABLE: number; REVOKED: number };
  reward_coin_amounts: { PENDING: number; AVAILABLE: number; REVOKED: number };
  rewards: InviteReward[];
  rules: { first_register_enabled: boolean; first_order_enabled: boolean; note: string };
}

const TRIGGER_LABEL: Record<string, string> = { /* i18n-fallback */
  first_register: "注册奖励", first_order: "首单奖励", first_recharge: "首充奖励",
};
const REWARD_LABEL: Record<InviteReward["status"], string> = { /* i18n-fallback */
  PENDING: "待到账", AVAILABLE: "已到账", REVOKED: "已撤销",
};
const REWARD_TONE: Record<InviteReward["status"], string> = {
  PENDING: "bg-amber-100 text-amber-800", AVAILABLE: "bg-emerald-100 text-emerald-800", REVOKED: "bg-rose-100 text-rose-700",
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border bg-card px-3 py-2 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-base font-semibold">{value}</p>
    </div>
  );
}

export function InvitePage() {
  const { user, currencies, config, campaign, ready, t, tf } = useSite();
  const [invite, setInvite] = useState<InviteSummary | null>(null);
  const [showPoster, setShowPoster] = useState(false);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    if (!user) return;
    call<InviteSummary>("invite/summary", { token: "user" }).then(setInvite).catch(() => setInvite(null));
  }, [user]);

  if (!ready) return <div className="grid place-items-center py-14"><CartLoading label={t("me.loading", "正在加载账户信息…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  // 奖励金额按账号币种展示；账号币种已下架时回落站点本位币，不再假设人民币存在
  const currency = currencies.find((c) => c.code === usableCurrencyCode(currencies, user.currency_code)) ?? null;
  const inviteLink = invite ? `${location.origin}${invite.invite_link}` : "";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(t("me.copied", "已复制到剪贴板"));
    } catch {
      setCopied(t("me.copy_blocked", "浏览器不允许自动复制，请长按选中上方链接复制"));
    }
    window.setTimeout(() => setCopied(""), 4000);
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5">
      <SubHeader title={t("me.invite_title", "我的邀请")} />

      <div className="flex flex-col gap-3 text-sm">
        {invite ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{t("me.invite_code", "邀请码")}</span>
              <b className="tracking-wider">{invite.invite_code}</b>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyLink()}>{t("me.copy_link", "复制邀请链接")}</Button>
              <Button type="button" size="sm" onClick={() => setShowPoster(true)}>{t("me.gen_poster", "生成邀请海报")}</Button>
              {copied && <span className="text-xs text-muted-foreground">{copied}</span>}
            </div>
            <InvitePoster
              open={showPoster}
              onClose={() => setShowPoster(false)}
              siteName={config?.brand?.site_name ?? t("me.poster_default_name", "好友邀请")}
              primary={(campaign?.theme ?? config?.theme)?.primary ?? "#2ECC71"}
              textColor={(campaign?.theme ?? config?.theme)?.text ?? "#141414"}
              background={(campaign?.theme ?? config?.theme)?.background ?? "#ffffff"}
              code={invite.invite_code}
              link={inviteLink}
              inviterName={user.nickname || user.username}
              hook={invite.rules?.note ?? t("me.poster_hook", "邀请好友注册并下单，你和好友都能拿奖励")}
            />
            <p className="break-all text-xs text-muted-foreground">{inviteLink}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label={t("me.invited_count", "已邀请")} value={`${invite.invited_count} ${t("common.person", "人")}`} />
              <Stat label={t("me.reward_pending", "待到账")} value={`${invite.reward_stats.PENDING} ${t("common.count_unit", "笔")}`} />
              <Stat label={t("me.reward_available", "已到账")} value={`${invite.reward_stats.AVAILABLE} ${t("common.count_unit", "笔")}`} />
              <Stat label={t("me.reward_revoked", "已撤销")} value={`${invite.reward_stats.REVOKED} ${t("common.count_unit", "笔")}`} />
            </div>
            <p className="text-muted-foreground">
              {t("me.reward_total", "余额类奖励合计到账")} {displayAmount(invite.reward_amounts_base.AVAILABLE, currency?.rate_scaled ?? 1e6, currency?.symbol ?? getBaseSymbol())}
              {t("me.reward_no_revoke", "（撤销后不再累计）")}
            </p>
            {invite.reward_coin_amounts.AVAILABLE > 0 && (
              <p className="text-muted-foreground">
                {t("me.reward_coin_total", "金币类奖励合计到账")} {tf("me.coin_reward_n", { n: invite.reward_coin_amounts.AVAILABLE }, "{n} 金币")}
                {t("me.reward_no_revoke", "（撤销后不再累计）")}
              </p>
            )}
            {invite.rewards.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {invite.rewards.slice(0, 6).map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 border-b border-dashed py-1 last:border-0">
                    <span>
                      {t("me.trigger_" + r.trigger_type, TRIGGER_LABEL[r.trigger_type] ?? r.trigger_type)} ·{" "}
                      {r.reward_type === "balance"
                        ? displayAmount(r.reward_value, currency?.rate_scaled ?? 1e6, currency?.symbol ?? getBaseSymbol())
                        : r.reward_type === "coin"
                          ? tf("me.coin_reward_n", { n: r.reward_value }, "{n} 金币")
                          : t("me.coupon_one", "优惠券 1 张")}
                    </span>
                    <span className={"px-2 py-0.5 text-xs " + (REWARD_TONE[r.status] ?? "")}>{t("me.reward_" + r.status.toLowerCase(), REWARD_LABEL[r.status])}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">{t("me.reward_none", "还没有奖励记录，好友注册或下单后会自动登记。")}</p>
            )}
            {(invite.rules.first_register_enabled || invite.rules.first_order_enabled) && invite.rules.note ? (
              <p className="text-xs text-muted-foreground">{invite.rules.note}</p>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">{t("me.invite_load_failed", "邀请信息加载失败")}</p>
        )}
      </div>
    </div>
  );
}
