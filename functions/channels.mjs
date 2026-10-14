// 收款渠道注册表（文档H：method→fulfillment 数据驱动，不再写死渠道清单）
// 订单扫码（Y3）、充值（W2）与 VIP 扫码（V2）共用同一份渠道配置与换算口径。
import { AppError } from "./errors.mjs";
import { getMergedConfig } from "./config.mjs";
import { signedUrlForKey } from "./files.mjs";

// 到账方式三态（文档H）：instant=站内即时（BALANCE，无需渠道条目）；manual=收款码+人工审核；online=远程会话+回调（本期仅接口，请求→501）
// 站内即时到账方法白名单（无渠道条目时 fulfillmentOfMethod 仍据此判 instant）
export const INSTANT_METHODS = ["BALANCE"];
// pay_channels 里的非渠道键（数值全局键 + 渠道墓碑数组），任何读取方都要跳过
export const NON_METHOD_KEYS = ["payment_timeout_hours", "removed_methods"];

export const toDisplayAmount = (base, rateScaled) => Math.round((base * rateScaled) / 1e6);

const fallbackName = (method) => (method === "WECHAT_QR" ? "微信转账" : method === "ALIPAY_QR" ? "支付宝转账" : method);

// 从 config.pay_channels 取 method→渠道条目；兼容旧数据（无 fulfillment/display_name 时回落 manual）
export async function channelRegistry(supabase) {
  const { config } = await getMergedConfig(supabase);
  const pc = config.pay_channels ?? {};
  const out = {};
  for (const [method, c] of Object.entries(pc)) {
    if (NON_METHOD_KEYS.includes(method) || !c || typeof c !== "object" || Array.isArray(c)) continue;
    out[method] = {
      method,
      enabled: c.enabled === true,
      fulfillment: c.fulfillment === "online" ? "online" : "manual",
      display_name: c.display_name || fallbackName(method),
      image_key: c.image_key ?? null,
      holder_name: c.holder_name ?? "",
      account_no: c.account_no ?? "",
      pay_link: c.pay_link ?? "",
      account_note: c.account_note ?? "",
      account_note_i18n: c.account_note_i18n ?? null,
      provider: c.provider ?? null,
      chains: Array.isArray(c.chains)
        ? c.chains
            .filter((x) => x && typeof x === "object" && x.symbol && x.address)
            .map((x) => ({
              symbol: String(x.symbol), network: x.network ?? "", address: String(x.address),
              note: x.note ?? "", note_i18n: x.note_i18n ?? null,
              rate_base_per_coin: Number.isSafeInteger(Number(x.rate_base_per_coin)) ? Number(x.rate_base_per_coin) : 0,
              decimals: Number.isSafeInteger(Number(x.decimals)) && Number(x.decimals) >= 1 ? Number(x.decimals) : 2,
              image_key: x.image_key ?? null,
            }))
        : [],
    };
  }
  return out;
}

/**
 * 加密货币按币种计价（文档L §2.2）：把本位币「分」折算成该币的数量。
 * 全程整数运算避免浮点漂移，并且**向上取整**——人工审核按「到账 ≥ 应付」判定，四舍五入会系统性少付。
 * rate_base_per_coin=0 表示店主还没设参考汇率：不出 quote，买家端据此把该币种置灰（绝不按本位币金额去转币）。
 */
export function coinQuoteOf(chain, amountBase) {
  const rate = Number(chain.rate_base_per_coin) || 0;
  const base = Number(amountBase);
  if (!(rate > 0) || !(base > 0)) return null;
  const decimals = Number(chain.decimals) > 0 ? Number(chain.decimals) : 2;
  const scale = 10 ** decimals;
  const units = Math.ceil((base * scale) / rate);
  return { decimals, units, amount: (units / scale).toFixed(decimals) };
}

// 收款码取图：币种自带码优先，留空回落渠道级码（渠道级已由 enabledChannel 签好名）
async function chainImageUrl(chain, fallbackUrl) {
  return chain.image_key ? await signedUrlForKey(chain.image_key) : fallbackUrl;
}

// 出票时给每条 chain 附上 quote 与签名后的收款码；三个出票口（Y3/W2/V2）共用，保证同一口径
export async function pricedChains(channel, amountBase) {
  return Promise.all((channel.chains ?? []).map(async (c) => ({
    ...c,
    image_url: await chainImageUrl(c, channel.image_url ?? null),
    quote: coinQuoteOf(c, amountBase),
  })));
}

// 客户所选币种 → 落库快照（文档L §2.5）。chain_index 是**建议值**：没选、渠道没有币种地址、
// 或后台在我们出票前把该币种删掉了，都只按账户币种记账（返回 null），绝不因此让收款流程失败。
// decimals 必须一起快照：units 只有配上出票当刻的小数位才能还原「应付多少币」，店主事后改小数位不能改动历史单。
// network 也要快照：同一个 symbol 可以配两条链（USDT/TRC20 与 USDT/ERC20 是两个地址），只记符号审核分不开。
export function coinSnapshot(chains, chainIndex) {
  if (chainIndex === null) return null;
  const chain = chains[chainIndex];
  if (!chain?.quote) return null;
  return {
    symbol: chain.symbol,
    network: chain.network || null,
    units: chain.quote.units,
    decimals: chain.quote.decimals,
  };
}

// 采集端取指定 method：不存在→400；是 online 却要 manual 采集→501（本期不开放）；未启用→409；否则返回带签名收款码的渠道
export async function enabledChannel(supabase, method, expectFulfillment = "manual") {
  const reg = await channelRegistry(supabase);
  const channel = reg[method];
  if (!channel) throw new AppError(400, "invalid_request", "不是可用的收款渠道", { field: "method", method });
  if (channel.fulfillment !== expectFulfillment) {
    if (channel.fulfillment === "online") {
      throw new AppError(501, "payment_method_not_ready", "该支付方式尚未开放", { method, fulfillment: "online" });
    }
    throw new AppError(400, "invalid_request", "该渠道不支持此收款方式", { field: "method", method, fulfillment: channel.fulfillment });
  }
  if (!channel.enabled) throw new AppError(409, "state_conflict", "该收款渠道未开启", { method });
  return { ...channel, image_url: channel.image_key ? await signedUrlForKey(channel.image_key) : null };
}

// 后台一个可用渠道都没开时给出可判别的错误，而不是返回 null 让调用方猜
export async function firstEnabledChannel(supabase, fulfillment = "manual") {
  const reg = await channelRegistry(supabase);
  const key = Object.keys(reg).find((m) => reg[m].enabled && reg[m].fulfillment === fulfillment);
  if (!key) throw new AppError(409, "state_conflict", "尚未配置可用收款渠道", { fulfillment });
  return enabledChannel(supabase, key, fulfillment);
}

// 归集历史分项到账方式用（无网络、供 refunds/结算撤销循环调用）：BALANCE→instant，注册表命中→其值，未知→manual
export function fulfillmentOfMethod(reg, method) {
  if (INSTANT_METHODS.includes(method)) return "instant";
  const c = reg[method];
  if (c) return c.fulfillment;
  return method === "BALANCE" ? "instant" : "manual";
}
