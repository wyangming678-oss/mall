// site_config 读写 + 默认值 + 校验（方案 §14 保存即生效；文档C S1/AN2/AN4）
import { AppError } from "./errors.mjs";
import { vStr, vInt, vBool, vEnum, vI18nMap, nowIso } from "./validate.mjs";

const HEX = /^#[0-9a-fA-F]{6}$/;
const LANGS = ["zh", "en", "ja", "ko", "es"];

export const CONFIG_KEYS = ["brand", "theme", "nav", "home_modules", "pay_channels", "service", "switches", "invite_rules", "coin_rules", "theme_presets", "active_theme", "second_floor", "pages", "currency", "default_lang", "withdraw"];

const obj = (v, field) => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new AppError(400, "invalid_request", "必须为对象", { field });
  return v;
};

const strOpt = (v, field, max = 500) => (v === undefined || v === null || v === "" ? null : vStr(v, field, { max }));

// 加密货币/多币种收款地址列表（渠道内的可选数组，数据驱动、零迁移）：symbol 必填、network/note 选填、address 必填
function coinChains(v, field) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new AppError(400, "invalid_request", "必须为数组", { field });
  if (v.length > 8) throw new AppError(400, "invalid_request", "币种地址≤8 条", { field });
  return v.map((raw, idx) => {
    const o = obj(raw, `${field}[${idx}]`);
    const noteI18n = vI18nMap(o.note_i18n, `${field}[${idx}].note_i18n`, 120);
    const row = {
      symbol: vStr(o.symbol, `${field}[${idx}].symbol`, { min: 1, max: 12 }),
      network: strOpt(o.network, `${field}[${idx}].network`, 24) ?? "",
      address: vStr(o.address, `${field}[${idx}].address`, { min: 1, max: 160 }),
      note: strOpt(o.note, `${field}[${idx}].note`, 120) ?? "",
      // 文档L：1 个该币折多少本位币「分」。0=店主未设汇率 ⇒ 买家端不出币价、该币种置灰
      rate_base_per_coin: vInt(o.rate_base_per_coin ?? 0, `${field}[${idx}].rate_base_per_coin`, { min: 0, max: 1e15 }),
      decimals: vInt(o.decimals ?? 2, `${field}[${idx}].decimals`, { min: 1, max: 8 }),
    };
    // 该币专属收款码：留空回落渠道级 image_key（避免客户选了 BTC 却扫到 USDT 的码）
    const chainImage = strOpt(o.image_key, `${field}[${idx}].image_key`, 200);
    if (chainImage) row.image_key = chainImage;
    // 译文只存非空语种，缺语由买家端回落 note 原文（同 #204 商品译文口径）
    if (Object.keys(noteI18n).length) row.note_i18n = noteI18n;
    return row;
  });
}

const PAGE_SLUG = /^[a-z0-9_-]{1,40}$/;
// 语言子集映射：仅收录 LANGS 内、值为非空字符串的项；全空返回 null
function langMap(v, field, max) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new AppError(400, "invalid_request", "必须为语言对象", { field });
  const out = {};
  for (const lang of LANGS) {
    const raw = v[lang];
    if (raw === undefined || raw === null || raw === "") continue;
    out[lang] = vStr(raw, `${field}.${lang}`, { max });
  }
  return Object.keys(out).length ? out : null;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
// 可选 ISO8601 时刻；给出则必须可解析
const isoOpt = (v, field) => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !ISO_RE.test(v) || !Number.isSafeInteger(Date.parse(v))) {
    throw new AppError(400, "invalid_request", "必须为 ISO8601 时刻", { field });
  }
  return v;
};

const UUID36 = /^[0-9a-fA-F-]{36}$/;
const AMT_MAX = 999999999; // 分
const COIN_MAX = 1000000000; // 金币（无量纲正整数上限）
const INVITE_REWARD_TYPES = ["balance", "coupon", "coin"];

// CY3 单个触发点规则；first_order 额外带结算口径与门槛
function inviteTriggerRule(v, field, { withBasis = false } = {}) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new AppError(400, "invalid_request", "必须为对象", { field });
  }
  const rewardType = vEnum(v.reward_type ?? "balance", `${field}.reward_type`, INVITE_REWARD_TYPES);
  const templateId = rewardType === "coupon"
    ? vStr(v.coupon_template_id, `${field}.coupon_template_id`, { max: 36, pattern: UUID36 })
    : null;
  return {
    enabled: vBool(v.enabled ?? false, `${field}.enabled`),
    reward_type: rewardType,
    // balance 走分（reward_value_base）；coin 走无量纲金币；coupon 无金额
    reward_value_base: rewardType === "coupon" ? 0
      : vInt(v.reward_value_base ?? 0, `${field}.reward_value_base`, { min: 0, max: rewardType === "coin" ? COIN_MAX : AMT_MAX }),
    coupon_template_id: templateId,
    delay_minutes: vInt(v.delay_minutes ?? 0, `${field}.delay_minutes`, { min: 0, max: 43200 }),
    ...(withBasis ? {
      basis: vEnum(v.basis ?? "paid", `${field}.basis`, ["paid", "completed"]),
      min_amount_base: vInt(v.min_amount_base ?? 0, `${field}.min_amount_base`, { min: 0, max: AMT_MAX }),
    } : {}),
  };
}

// 邀请返利规则（文档C CY3；发放时按此快照，只约束后续发放）
export function validateInviteRules(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "invalid_request", "invite_rules 必须为对象", { field: "invite_rules" });
  }
  const caps = raw.caps ?? {};
  const out = {
    first_register: inviteTriggerRule(raw.first_register ?? {}, "invite_rules.first_register"),
    first_order: inviteTriggerRule(raw.first_order ?? {}, "invite_rules.first_order", { withBasis: true }),
    first_recharge: inviteTriggerRule(raw.first_recharge ?? {}, "invite_rules.first_recharge"),
    invitee_coupon_template_id: raw.invitee_coupon_template_id
      ? vStr(raw.invitee_coupon_template_id, "invite_rules.invitee_coupon_template_id", { max: 36, pattern: UUID36 })
      : null,
    caps: {
      per_inviter_total: vInt(caps.per_inviter_total ?? 0, "invite_rules.caps.per_inviter_total", { min: 0, max: 1000000 }),
      per_inviter_daily: vInt(caps.per_inviter_daily ?? 0, "invite_rules.caps.per_inviter_daily", { min: 0, max: 100000 }),
    },
    note: strOpt(raw.note, "invite_rules.note", 500) ?? "",
  };
  return out;
}

// 金币规则（文档F §二 coin_rules；发放/兑换时按此快照，只约束后续）
export function validateCoinRules(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "invalid_request", "coin_rules 必须为对象", { field: "coin_rules" });
  }
  const checkin = obj(raw.checkin ?? {}, "coin_rules.checkin");
  const schedule = Array.isArray(checkin.bonus_schedule) ? checkin.bonus_schedule : [];
  if (schedule.length > 10) throw new AppError(400, "invalid_request", "bonus_schedule 最多 10 档", { field: "coin_rules.checkin.bonus_schedule" });
  const bonusSchedule = schedule.map((s, i) => ({
    streak: vInt(s.streak, `coin_rules.checkin.bonus_schedule[${i}].streak`, { min: 1, max: 3650 }),
    bonus: vInt(s.bonus ?? 0, `coin_rules.checkin.bonus_schedule[${i}].bonus`, { min: 0, max: COIN_MAX }),
  }));
  bonusSchedule.sort((a, b) => a.streak - b.streak);

  const order = obj(raw.order_reward ?? {}, "coin_rules.order_reward");
  const oMin = vInt(order.min ?? 0, "coin_rules.order_reward.min", { min: 0, max: COIN_MAX });
  const oMax = vInt(order.max ?? 0, "coin_rules.order_reward.max", { min: 0, max: COIN_MAX });
  if (oMin > oMax) throw new AppError(400, "invalid_request", "返币下限不得大于上限", { field: "coin_rules.order_reward" });

  const invite = obj(raw.invite_reward ?? {}, "coin_rules.invite_reward");
  return {
    checkin: {
      base: vInt(checkin.base ?? 0, "coin_rules.checkin.base", { min: 0, max: COIN_MAX }),
      bonus_schedule: bonusSchedule,
      cycle_days: vInt(checkin.cycle_days ?? 0, "coin_rules.checkin.cycle_days", { min: 0, max: 3650 }),
    },
    order_reward: {
      enabled: vBool(order.enabled ?? false, "coin_rules.order_reward.enabled"),
      rate_bp: vInt(order.rate_bp ?? 0, "coin_rules.order_reward.rate_bp", { min: 0, max: 10000 }),
      min: oMin,
      max: oMax,
    },
    invite_reward: {
      inviter: vInt(invite.inviter ?? 0, "coin_rules.invite_reward.inviter", { min: 0, max: COIN_MAX }),
      invitee: vInt(invite.invitee ?? 0, "coin_rules.invite_reward.invitee", { min: 0, max: COIN_MAX }),
    },
  };
}

const validators = {
  brand(v) {
    const o = obj(v, "brand");
    return {
      site_name: vStr(o.site_name, "brand.site_name", { max: 60 }),
      logo_key: strOpt(o.logo_key, "brand.logo_key", 200),
      favicon_key: strOpt(o.favicon_key, "brand.favicon_key", 200),
      hero_bg_key: strOpt(o.hero_bg_key, "brand.hero_bg_key", 200),
    };
  },
  theme(v) {
    const o = obj(v, "theme");
    for (const k of ["primary", "secondary", "background", "text"]) {
      if (typeof o[k] !== "string" || !HEX.test(o[k])) throw new AppError(400, "invalid_request", "必须为 #RRGGBB", { field: `theme.${k}` });
    }
    return {
      primary: o.primary, secondary: o.secondary,
      background: o.background, text: o.text,
      radius: vEnum(o.radius, "theme.radius", ["sm", "md", "lg", "xl"]),
      font: vEnum(o.font, "theme.font", ["sans", "serif", "display"]),
    };
  },
  nav(v) {
    if (!Array.isArray(v) || v.length > 20) throw new AppError(400, "invalid_request", "导航为数组≤20", { field: "nav" });
    return v.map((item, i) => ({
      label: vStr(item.label, `nav[${i}].label`, { max: 30 }),
      label_i18n: item.label_i18n && typeof item.label_i18n === "object" ? item.label_i18n : null,
      target: vStr(item.target, `nav[${i}].target`, { max: 200 }),
      visible: vBool(item.visible ?? true, `nav[${i}].visible`),
    }));
  },
  home_modules(v) {
    if (!Array.isArray(v) || v.length > 12) throw new AppError(400, "invalid_request", "模块数组≤12", { field: "home_modules" });
    return v.map((m, i) => ({
      module: vEnum(m.module, `home_modules[${i}].module`, ["banner", "image_nav", "announce", "recommend", "hot", "activity", "brand_story"]),
      enabled: vBool(m.enabled ?? false, `home_modules[${i}].enabled`),
      sort: vInt(m.sort ?? i, `home_modules[${i}].sort`, { min: 0, max: 999 }),
      title: strOpt(m.title, `home_modules[${i}].title`, 60),
      // 楼层标题译名：留空则前台按语言回落内置词表（见 src/pages/Home.tsx 的 moduleTitle）
      title_i18n: langMap(m.title_i18n, `home_modules[${i}].title_i18n`, 60),
      items: Array.isArray(m.items) && m.items.length <= 20
        ? m.items.map((it, j) => ({
          title: strOpt(it.title, `home_modules[${i}].items[${j}].title`, 60),
          image_key: strOpt(it.image_key, `home_modules[${i}].items[${j}].image_key`, 200),
          link: strOpt(it.link, `home_modules[${i}].items[${j}].link`, 200),
          // 海报条目级开关：关=该张海报不在前台渲染（默认开）
          enabled: vBool(it.enabled ?? true, `home_modules[${i}].items[${j}].enabled`),
        }))
        : [],
    }));
  },
  pay_channels(v) {
    const o = obj(v, "pay_channels");
    const out = {
      payment_timeout_hours: vInt(o.payment_timeout_hours ?? 48, "pay_channels.payment_timeout_hours", { min: 1, max: 720 }),
      // 墓碑：后台删掉的渠道码；读时补齐据此跳过，避免默认值把它再塞回前台
      removed_methods: Array.isArray(o.removed_methods)
        ? [...new Set(o.removed_methods.map((m) => vStr(m, "pay_channels.removed_methods[]", { min: 2, max: 32, pattern: /^[A-Z][A-Z0-9_]{1,31}$/ })))]
        : [],
    };
    const methodKeys = Object.keys(o).filter((k) => k !== "payment_timeout_hours" && k !== "removed_methods");
    if (methodKeys.length > 20) throw new AppError(400, "invalid_request", "收款渠道≤20 个", { field: "pay_channels" });
    for (const key of methodKeys) {
      if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(key)) {
        throw new AppError(400, "invalid_request", "渠道码需为大写字母开头的 A-Z0-9_（2–32 位）", { field: `pay_channels.${key}` });
      }
      const c = obj(o[key], `pay_channels.${key}`);
      const fulfillment = vEnum(c.fulfillment ?? "manual", `pay_channels.${key}.fulfillment`, ["manual", "online"]);
      const entry = {
        enabled: vBool(c.enabled ?? false, `pay_channels.${key}.enabled`),
        fulfillment,
        display_name: vStr(c.display_name ?? key, `pay_channels.${key}.display_name`, { min: 1, max: 40 }),
      };
      // 字段按到账方式分叉：manual 存收款码+户名/收款账号/收款链接/备注，online 只存 provider（本期不驱动行为）
      if (fulfillment === "manual") {
        entry.image_key = strOpt(c.image_key, `pay_channels.${key}.image_key`, 200);
        entry.holder_name = strOpt(c.holder_name, `pay_channels.${key}.holder_name`, 60) ?? "";
        entry.account_no = strOpt(c.account_no, `pay_channels.${key}.account_no`, 120) ?? "";
        entry.pay_link = strOpt(c.pay_link, `pay_channels.${key}.pay_link`, 300) ?? "";
        entry.account_note = strOpt(c.account_note, `pay_channels.${key}.account_note`, 300) ?? "";
        // 收款说明译文：account_note 仍是中文原文（后台主框 + 缺语回落），这里只装非空语种
        const noteI18n = vI18nMap(c.account_note_i18n, `pay_channels.${key}.account_note_i18n`, 300);
        if (Object.keys(noteI18n).length) entry.account_note_i18n = noteI18n;
        entry.chains = coinChains(c.chains, `pay_channels.${key}.chains`);
      } else {
        entry.provider = vEnum(c.provider ?? "custom", `pay_channels.${key}.provider`, ["stripe", "wechat_pay", "alipay", "custom"]);
      }
      out[key] = entry;
    }
    return out;
  },
  // 站点本位币（记账币种）：所有 price_base / 分账金额均以本位币「分」记账。
  // 切换本位币只重贴记账标签并影响未来展示换算，历史订单已按下单时刻汇率快照锁定，不受影响。
  currency(v) {
    const o = obj(v, "currency");
    return { base: vStr(o.base ?? "CNY", "currency.base", { min: 3, max: 3, pattern: /^[A-Z]{3}$/ }) };
  },
  default_lang(v) {
    if (v === undefined || v === null) return "zh";
    return vEnum(v, "default_lang", LANGS);
  },
  service(v) {
    const o = obj(v, "service");
    return {
      auto_reply: strOpt(o.auto_reply, "service.auto_reply", 1000) ?? "",
      // 这句会在顾客进线时落进会话，所以和收款说明一样带语言子集；auto_reply 仍是中文原文
      auto_reply_i18n: langMap(o.auto_reply_i18n, "service.auto_reply_i18n", 1000),
      working_hours: strOpt(o.working_hours, "service.working_hours", 100) ?? "",
      offline_notice: strOpt(o.offline_notice, "service.offline_notice", 500) ?? "",
      // 忘记密码/锁在门外的顾客可联系的公开客服渠道（邮箱/QQ/微信/电话，多行）；无需登录即可见
      contact: strOpt(o.contact, "service.contact", 500) ?? "",
      // 文档J §2.1：免注册客服开关 + 单 IP 每小时可新开的访客会话数（超出即 429）
      guest_chat_open: vBool(o.guest_chat_open ?? true, "service.guest_chat_open"),
      guest_ip_limit: vInt(o.guest_ip_limit ?? 20, "service.guest_ip_limit", { min: 1, max: 500 }),
    };
  },
  // A5 静态内容页：slug -> {title, title_i18n, body, body_i18n, updated_at}，纯 site_config 无迁移
  pages(v) {
    const o = obj(v, "pages");
    const slugs = Object.keys(o);
    if (slugs.length > 20) throw new AppError(400, "invalid_request", "静态页≤20 篇", { field: "pages" });
    const out = {};
    for (const slug of slugs) {
      if (!PAGE_SLUG.test(slug)) throw new AppError(400, "invalid_request", "slug 只允许小写字母/数字/-/_", { field: `pages.${slug}` });
      const p = obj(o[slug], `pages.${slug}`);
      out[slug] = {
        title: strOpt(p.title, `pages.${slug}.title`, 60) ?? "",
        title_i18n: langMap(p.title_i18n, `pages.${slug}.title_i18n`, 60),
        body: vStr(p.body ?? "", `pages.${slug}.body`, { max: 20000 }),
        body_i18n: langMap(p.body_i18n, `pages.${slug}.body_i18n`, 20000),
        updated_at: isoOpt(p.updated_at, `pages.${slug}.updated_at`),
      };
    }
    return out;
  },
  switches(v) {
    const o = obj(v, "switches");
    return {
      register_open: vBool(o.register_open ?? true, "switches.register_open"),
      order_open: vBool(o.order_open ?? true, "switches.order_open"),
      maintenance: vBool(o.maintenance ?? false, "switches.maintenance"),
      // 方案 §10：VIP 折扣与券默认可叠加
      vip_coupon_stack: vBool(o.vip_coupon_stack ?? true, "switches.vip_coupon_stack"),
      // 防滥用价值门控：默认 register = M3b 冻结的注册即发行为
      invite_reward_trigger: vEnum(o.invite_reward_trigger ?? "register", "switches.invite_reward_trigger", ["register", "first_order"]),
      // 支付密码不再是站点开关：它由买家自己在「我的」里设置，后台可代改/清除（文档A users.payment_password_hash）
      // 金币兑换商城：全站总开关，默认关；关→购物端入口隐藏 + 用户端点 410 coins_disabled（文档F 决策 D-6）
      coins: vBool(o.coins ?? false, "switches.coins"),
      // 分期付款专区：全站总开关，默认关；关→/installment 专区隐藏、海报入口不出、结算不出现选期（文档N 决策 D6）
      installment: vBool(o.installment ?? false, "switches.installment"),
    };
  },
  // 文档O 提现门槛（site_config 整键，零迁移）：默认关；不收手续费故无 fee 字段；⚠ 保存须发全字段（整键替换）
  withdraw(v) {
    const o = obj(v, "withdraw");
    const min = vInt(o.min_amount_base ?? 1, "withdraw.min_amount_base", { min: 1, max: 999999999999 });
    const max = vInt(o.max_amount_base ?? 999999999999, "withdraw.max_amount_base", { min: 1, max: 999999999999 });
    if (min > max) throw new AppError(400, "invalid_request", "最低提现额不能大于单笔上限", { field: "withdraw" });
    return {
      enabled: vBool(o.enabled ?? false, "withdraw.enabled"),
      min_amount_base: min,
      max_amount_base: max,
      daily_limit: vInt(o.daily_limit ?? 1, "withdraw.daily_limit", { min: 1, max: 100 }),
    };
  },
  invite_rules(v) {
    return validateInviteRules(v);
  },
  coin_rules(v) {
    return validateCoinRules(v);
  },
  // —— M5 运营换肤：主题预设数组 + 生效指针（均落 site_config，无迁移）——
  theme_poster(v, field, withOnce) {
    if (v === undefined || v === null) {
      return withOnce
        ? { enabled: false, image_key: null, link: null, once_per_day: true }
        : { enabled: false, image_key: null, link: null };
    }
    const o = obj(v, field);
    return {
      enabled: vBool(o.enabled ?? false, `${field}.enabled`),
      image_key: strOpt(o.image_key, `${field}.image_key`, 200),
      link: strOpt(o.link, `${field}.link`, 200),
      ...(withOnce ? { once_per_day: vBool(o.once_per_day ?? true, `${field}.once_per_day`) } : {}),
    };
  },
  theme_presets(v) {
    if (!Array.isArray(v) || v.length > 20) throw new AppError(400, "invalid_request", "主题预设数组≤20", { field: "theme_presets" });
    return v.map((p, i) => {
      const field = `theme_presets[${i}]`;
      const startAt = isoOpt(p.start_at, `${field}.start_at`);
      const endAt = isoOpt(p.end_at, `${field}.end_at`);
      if (startAt && endAt && Date.parse(startAt) >= Date.parse(endAt)) {
        throw new AppError(400, "invalid_request", "start_at 必须早于 end_at", { field });
      }
      return {
        id: vStr(p.id, `${field}.id`, { max: 36, pattern: UUID36 }),
        name: vStr(p.name, `${field}.name`, { max: 30 }),
        theme: validators.theme(p.theme),
        home_modules: validators.home_modules(p.home_modules ?? []),
        hero_bg_key: strOpt(p.hero_bg_key, `${field}.hero_bg_key`, 200),
        page_bg_key: strOpt(p.page_bg_key, `${field}.page_bg_key`, 200),
        splash_poster: validators.theme_poster(p.splash_poster, `${field}.splash_poster`, false),
        daily_popup: validators.theme_poster(p.daily_popup, `${field}.daily_popup`, true),
        start_at: startAt,
        end_at: endAt,
        enabled: vBool(p.enabled ?? false, `${field}.enabled`),
        sort: vInt(p.sort ?? i, `${field}.sort`, { min: 0, max: 999 }),
      };
    });
  },
  active_theme(v) {
    const o = obj(v, "active_theme");
    const pid = o.preset_id;
    return {
      preset_id: pid === null || pid === undefined || pid === "default"
        ? "default"
        : vStr(pid, "active_theme.preset_id", { max: 36, pattern: UUID36 }),
      override: vBool(o.override ?? false, "active_theme.override"),
    };
  },
  // —— M8 商城二楼（文档G）：活动期专用下拉会场，落 decor 命名空间的 site_config 键，无新表无迁移 ——
  // 内容结构复用 home_modules 楼层白名单（不得引入 seckill 等合约不供数据的楼层）
  second_floor(v) {
    const o = obj(v, "second_floor");
    const startAt = isoOpt(o.start_at, "second_floor.start_at");
    const endAt = isoOpt(o.end_at, "second_floor.end_at");
    if (startAt && endAt && Date.parse(startAt) >= Date.parse(endAt)) {
      throw new AppError(400, "invalid_request", "start_at 必须早于 end_at", { field: "second_floor" });
    }
    const theme = o.theme === null || o.theme === undefined ? null : validators.theme(o.theme);
    const hint = o.trigger_hint === null || o.trigger_hint === undefined ? {} : obj(o.trigger_hint, "second_floor.trigger_hint");
    const cta = o.cta === null || o.cta === undefined ? {} : obj(o.cta, "second_floor.cta");
    return {
      enabled: vBool(o.enabled ?? false, "second_floor.enabled"),
      start_at: startAt,
      end_at: endAt,
      title: strOpt(o.title, "second_floor.title", 60) ?? "",
      title_i18n: o.title_i18n && typeof o.title_i18n === "object" && !Array.isArray(o.title_i18n) ? o.title_i18n : null,
      background_key: strOpt(o.background_key, "second_floor.background_key", 200),
      theme,
      trigger_hint: {
        text: strOpt(hint.text, "second_floor.trigger_hint.text", 30) ?? "",
        icon_key: strOpt(hint.icon_key, "second_floor.trigger_hint.icon_key", 200),
      },
      cta: {
        label: strOpt(cta.label, "second_floor.cta.label", 30) ?? "",
        link: strOpt(cta.link, "second_floor.cta.link", 200) ?? "",
      },
      modules: validators.home_modules(o.modules ?? []),
    };
  },
};
// 本地桩复用同一份校验器：保存时按真实口径归一（缺省字段回填默认值），否则桩永远测不出「整键替换把配置清了」
export { validators as CONFIG_VALIDATORS };

const OFF_TRIGGER = { enabled: false, reward_type: "balance", reward_value_base: 0, coupon_template_id: null, delay_minutes: 0 };
export const DEFAULT_CONFIG = {
  brand: { site_name: "ChicCart", logo_key: null, favicon_key: null, hero_bg_key: null },
  theme: { primary: "#2ECC71", secondary: "#16A085", background: "#F6FAF7", text: "#1F2937", radius: "sm", font: "sans" },
  nav: [
    { label: "首页", target: "/", visible: true },
    { label: "全部商品", target: "/category", visible: true },
    { label: "购物车", target: "/cart", visible: true },
    { label: "我的", target: "/me", visible: true },
  ],
  home_modules: [
    { module: "banner", enabled: true, sort: 0, title: null, items: [] },
    { module: "image_nav", enabled: true, sort: 1, title: "快速直达", items: [] },
    { module: "announce", enabled: true, sort: 2, title: "公告", items: [] },
    { module: "recommend", enabled: true, sort: 3, title: "为你推荐", items: [] },
    { module: "hot", enabled: true, sort: 4, title: "热销榜单", items: [] },
    { module: "activity", enabled: false, sort: 5, title: "活动楼层", items: [] },
  ],
  // 默认展示四项收款方式（微信/支付宝/PayPal/CEX 支付＝加密货币）；enabled=true 即开箱显示，后台「显示」开关用来关。
  // removed_methods 是墓碑：后台删掉的渠道码，读时不再被默认值补回来（见 mergePayChannels）。
  pay_channels: {
    payment_timeout_hours: 48,
    removed_methods: [],
    WECHAT_QR: { enabled: true, fulfillment: "manual", display_name: "微信转账", image_key: null, holder_name: "", account_no: "", pay_link: "", account_note: "" },
    ALIPAY_QR: { enabled: true, fulfillment: "manual", display_name: "支付宝转账", image_key: null, holder_name: "", account_no: "", pay_link: "", account_note: "" },
    PAYPAL: { enabled: true, fulfillment: "manual", display_name: "PayPal", image_key: null, holder_name: "", account_no: "", pay_link: "", account_note: "" },
    CRYPTO: {
      enabled: true, fulfillment: "manual", display_name: "CEX支付", image_key: null, holder_name: "", account_no: "", pay_link: "",
      account_note: "请从交易所（CEX）或钱包按上方应付金额转账 USDT / USDC / ETH / BTC，付款后上传付款截图与流水号，核对到账后订单自动生效。",
      account_note_i18n: {
        en: "Send USDT / USDC / ETH / BTC from your exchange (CEX) or wallet for the amount shown, then upload the payment screenshot and transaction reference. The order takes effect once we verify the payment.",
        ja: "取引所（CEX）またはウォレットから、表示されている支払金額分を USDT / USDC / ETH / BTC でお送りください。入金確認後、注文が有効になります。",
        ko: "거래소(CEX) 또는 지갑에서 표시된 금액만큼 USDT / USDC / ETH / BTC 로 전송한 뒤 결제 화면과 거래 번호를 업로드하세요. 입금 확인 후 주문이 확정됩니다.",
        es: "Mandá USDT / USDC / ETH / BTC desde tu exchange (CEX) o billetera por el importe mostrado y subí la captura con el número de transacción. El pedido se confirma cuando verificamos el pago.",
      },
      chains: [],
    },
  },
  currency: { base: "CNY" },
  default_lang: "zh",
  service: { auto_reply: "客服暂时离线，留言后会尽快回复。", working_hours: "09:00-18:00", offline_notice: "", contact: "", guest_chat_open: true, guest_ip_limit: 20 },
  pages: {},
  switches: { register_open: true, order_open: true, maintenance: false, vip_coupon_stack: true, invite_reward_trigger: "register", coins: false, installment: false },
  invite_rules: {
    first_register: { ...OFF_TRIGGER },
    first_order: { ...OFF_TRIGGER, basis: "paid", min_amount_base: 0 },
    first_recharge: { ...OFF_TRIGGER },
    invitee_coupon_template_id: null,
    caps: { per_inviter_total: 0, per_inviter_daily: 0 },
    note: "",
  },
  coin_rules: {
    checkin: { base: 0, bonus_schedule: [], cycle_days: 0 },
    order_reward: { enabled: false, rate_bp: 0, min: 0, max: 0 },
    invite_reward: { inviter: 0, invitee: 0 },
  },
  theme_presets: [],
  active_theme: { preset_id: "default", override: false },
  second_floor: {
    enabled: false, start_at: null, end_at: null,
    title: "", title_i18n: null, background_key: null, theme: null,
    trigger_hint: { text: "", icon_key: null },
    cta: { label: "", link: "" },
    modules: [],
  },
  withdraw: { enabled: false, min_amount_base: 1, max_amount_base: 999999999999, daily_limit: 1 },
};

// A5 静态页读取端本地化回退：目标语言 → zh → 默认字段
export function pageView(pages, slug, lang) {
  const p = pages?.[slug];
  if (!p) return null;
  const pick = (def, map) => (map && map[lang]) || (map && map.zh) || def || "";
  return {
    slug,
    title: pick(p.title, p.title_i18n),
    body: p.body ?? "",
    body_i18n: p.body_i18n ?? null,
    updated_at: p.updated_at ?? null,
    content: pick(p.body, p.body_i18n),
  };
}

// 收款渠道读时补齐：site_config 是整键存储，历史行常常只剩两三个渠道，直接覆盖 DEFAULT 会让后台/前台都看不见其余项。
// 口径：默认集为底 → 存量同名条目覆盖 → 墓碑（removed_methods）里的码不补 → 后台自建的额外渠道原样保留。
// 购物端/后台/本地桩都经本函数取数，保证「渠道不见了」在任一侧都是同一行为。
export function mergePayChannels(stored) {
  const base = DEFAULT_CONFIG.pay_channels;
  if (!stored || typeof stored !== "object") return { ...base, removed_methods: [] };
  const removed = Array.isArray(stored.removed_methods) ? stored.removed_methods : [];
  const out = {
    payment_timeout_hours: Number.isSafeInteger(stored.payment_timeout_hours)
      ? stored.payment_timeout_hours : base.payment_timeout_hours,
    removed_methods: [...removed],
  };
  for (const [method, def] of Object.entries(base)) {
    if (method === "payment_timeout_hours" || method === "removed_methods") continue;
    const cur = stored[method];
    if (cur && typeof cur === "object") out[method] = cur;
    else if (!removed.includes(method)) out[method] = def;
  }
  for (const [method, cur] of Object.entries(stored)) {
    if (method === "payment_timeout_hours" || method === "removed_methods" || method in out) continue;
    if (cur && typeof cur === "object") out[method] = cur;
  }
  return out;
}

export async function getMergedConfig(supabase) {
  const { data, error } = await supabase.from("site_config")
    .select("config_key,config_value,updated_at,created_at");
  if (error) throw new AppError(500, "internal_error");
  const merged = { ...DEFAULT_CONFIG };
  let versionMs = 0;
  for (const row of data ?? []) {
    if (!CONFIG_KEYS.includes(row.config_key)) continue;
    merged[row.config_key] = row.config_key === "pay_channels" ? mergePayChannels(row.config_value) : row.config_value;
    const t = Date.parse(row.updated_at ?? row.created_at ?? 0);
    if (Number.isSafeInteger(t) && t > versionMs) versionMs = t;
  }
  return { config: merged, configVersion: new Date(versionMs).toISOString() };
}

export async function saveConfigKeys(supabase, adminId, patch, opts = {}) {
  obj(patch, "config");
  const keys = Object.keys(patch);
  if (!keys.length || keys.length > CONFIG_KEYS.length) throw new AppError(400, "invalid_request", "config 键不合法");
  // D1 配置历史：先取整份现值与当前版本号做 CAS，落库后再打一条整份快照（version 单调、PK 防并发）
  const pre = await getMergedConfig(supabase);
  const current = await latestConfigVersion(supabase);
  if (opts.expectedConfigVersion != null && Number(opts.expectedConfigVersion) !== current) {
    throw new AppError(409, "config_version_conflict", "配置已被其他保存更新，请刷新后重试", { current_version: current });
  }
  const saved = [];
  for (const key of keys) {
    if (!validators[key]) throw new AppError(400, "invalid_request", "未知配置键", { key });
    const value = validators[key](patch[key]);
    const now = nowIso();
    const { data: existing } = await supabase.from("site_config")
      .select("id").eq("config_key", key).maybeSingle();
    if (existing) {
      const { error } = await supabase.from("site_config")
        .update({ config_value: value, updated_by: adminId, updated_at: now }).eq("id", existing.id);
      if (error) throw new AppError(500, "internal_error");
    } else {
      const { error } = await supabase.from("site_config").insert({
        id: crypto.randomUUID(), config_key: key, config_value: value, updated_by: adminId,
        created_at: now, updated_at: now,
      });
      if (error) throw new AppError(500, "internal_error");
    }
    saved.push(key);
  }
  const post = await getMergedConfig(supabase);
  await writeConfigHistory(supabase, adminId, current, pre.config, post.config, opts.note);
  return saved;
}

// —— D1 配置历史（config_history，v26）：整份快照 + 单调 version + 回滚 ——
async function latestConfigVersion(supabase) {
  const { data, error } = await supabase.from("config_history")
    .select("version").order("version", { ascending: false }).limit(1);
  if (error) throw new AppError(500, "internal_error");
  return data?.[0]?.version ?? 0;
}

async function writeConfigHistory(supabase, adminId, current, preConfig, postConfig, note) {
  let v = current;
  if (v === 0) {
    // baseline：把「启用历史前的原始配置」也存成 v1，保证最早状态仍可回滚
    const { error } = await supabase.from("config_history").insert({
      version: 1, payload: preConfig, saved_by: adminId, note: "baseline", created_at: nowIso(),
    });
    if (error) throw new AppError(409, "config_version_conflict", "并发保存冲突，请刷新后重试");
    v = 1;
  }
  const { error } = await supabase.from("config_history").insert({
    version: v + 1, payload: postConfig, saved_by: adminId, note: note ?? null, created_at: nowIso(),
  });
  if (error) throw new AppError(409, "config_version_conflict", "并发保存冲突，请刷新后重试");
}

export async function listConfigHistory(supabase, { limit = 20, offset = 0 } = {}) {
  const { data, error } = await supabase.from("config_history")
    .select("version,saved_by,note,created_at")
    .order("version", { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw new AppError(500, "internal_error");
  return data ?? [];
}

export async function getConfigHistoryRow(supabase, version) {
  const { data, error } = await supabase.from("config_history")
    .select("version,payload,saved_by,note,created_at").eq("version", version).maybeSingle();
  if (error) throw new AppError(500, "internal_error");
  return data ?? null;
}

// 回滚 = 把该版本的整份快照当作一次新保存写回（自身也产生新版本，历史不被破坏）
export async function rollbackConfig(supabase, adminId, version) {
  const row = await getConfigHistoryRow(supabase, version);
  if (!row) throw new AppError(404, "not_found", "该配置版本不存在");
  const patch = row.payload && typeof row.payload === "object" ? row.payload : null;
  if (!patch) throw new AppError(500, "internal_error");
  return saveConfigKeys(supabase, adminId, patch, { note: `rollback to v${version}` });
}

export const SEED_CURRENCIES = [
  { code: "CNY", symbol: "¥", name_i18n: { zh: "人民币", en: "Chinese Yuan", ja: "中国人民元", ko: "위안", es: "Yuan chino" }, rate_scaled: 1000000 },
  { code: "USD", symbol: "$", name_i18n: { zh: "美元", en: "US Dollar", ja: "米ドル", ko: "달러", es: "Dólar estadounidense" }, rate_scaled: 141000 },
  { code: "EUR", symbol: "€", name_i18n: { zh: "欧元", en: "Euro", ja: "ユーロ", ko: "유로", es: "Euro" }, rate_scaled: 127000 },
  { code: "JPY", symbol: "¥", name_i18n: { zh: "日元", en: "Japanese Yen", ja: "日本円", ko: "엔화", es: "Yen japonés" }, rate_scaled: 212000 },
  { code: "KRW", symbol: "₩", name_i18n: { zh: "韩元", en: "Korean Won", ja: "韓国ウォン", ko: "원", es: "Won surcoreano" }, rate_scaled: 1930000 },
  { code: "GBP", symbol: "£", name_i18n: { zh: "英镑", en: "British Pound", ja: "英ポンド", ko: "파운드", es: "Libra esterlina" }, rate_scaled: 110000 },
  { code: "ARS", symbol: "ARS$ ", name_i18n: { zh: "阿根廷比索", en: "Argentine Peso", ja: "アルゼンチン・ペソ", ko: "아르헨티나 페소", es: "Peso argentino" }, rate_scaled: 197000000 },
];

export async function seedCurrencies(supabase) {
  for (const c of SEED_CURRENCIES) {
    const { error } = await supabase.from("currencies").insert({
      id: crypto.randomUUID(), code: c.code, symbol: c.symbol, name_i18n: c.name_i18n,
      rate_scaled: c.rate_scaled, status: "on", created_at: nowIso(),
    });
    if (error && error.code !== "23505") throw new AppError(500, "internal_error");
  }
}

export async function getCurrencies(supabase) {
  const { data, error } = await supabase.from("currencies")
    .select("code,symbol,name_i18n,rate_scaled,status").eq("status", "on").order("code");
  if (error) throw new AppError(500, "internal_error");
  return data ?? [];
}

export async function getCurrency(supabase, code) {
  const { data } = await supabase.from("currencies")
    .select("code,symbol,name_i18n,rate_scaled,status").eq("code", code).eq("status", "on").maybeSingle();
  return data ?? null;
}

/**
 * 展示币种解析：账号币种 → 站点本位币 → USD → 首个已开通，与 resolveRegisterCurrency 同口径。
 * 后台可以下架任意币种，老账号的 currency_code 因此可能已不存在；这里保证资金类写入不会因下架而硬失败，
 * 且只有站点一个币种都没开通时才报错。调用方必须用返回行的 code 落库，而不是继续用账号里的旧码。
 */
export async function getCurrencyOrBase(supabase, code) {
  const { config } = await getMergedConfig(supabase);
  for (const c of [code, config?.currency?.base, "USD"]) {
    if (!c) continue;
    const hit = await getCurrency(supabase, c);
    if (hit) return hit;
  }
  const all = await getCurrencies(supabase);
  if (!all.length) throw new AppError(500, "internal_error", "站点未配置可用币种");
  return all[0];
}

export async function getStrings(supabase, lang) {
  if (!LANGS.includes(lang)) throw new AppError(400, "invalid_request", "语言不支持", { lang });
  const { data, error } = await supabase.from("ui_strings").select("string_key,lang,content").in("lang", [lang, "zh"]);
  if (error) throw new AppError(500, "internal_error");
  const dict = {};
  for (const row of data ?? []) {
    if (row.lang === lang) dict[row.string_key] = row.content;
    else if (!(row.string_key in dict)) dict[row.string_key] = row.content; // zh 回退
  }
  return dict;
}

export async function saveStrings(supabase, items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    throw new AppError(400, "invalid_request", "items 需为 1–100 条数组", { field: "items" });
  }
  for (const it of items) {
    const stringKey = vStr(it.string_key, "string_key", { max: 100 });
    const lang = vEnum(it.lang, "lang", LANGS);
    const content = typeof it.content === "string" && it.content.length <= 2000 ? it.content
      : (() => { throw new AppError(400, "invalid_request", "content 需 ≤2000 字符"); })();
    const now = nowIso();
    const { data: existing } = await supabase.from("ui_strings")
      .select("id").eq("string_key", stringKey).eq("lang", lang).maybeSingle();
    if (existing) {
      const { error } = await supabase.from("ui_strings").update({ content }).eq("id", existing.id);
      if (error) throw new AppError(500, "internal_error");
    } else {
      const { error } = await supabase.from("ui_strings").insert({
        id: crypto.randomUUID(), string_key: stringKey, lang, content,
      });
      if (error && error.code !== "23505") throw new AppError(500, "internal_error");
    }
  }
  return items.length;
}
