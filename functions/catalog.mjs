// 商品目录 M2a（文档C §三 P1–P3、§六.4 PR1–PR4；表定义见文档A §二；流水转换表见文档B §六）
import { AppError, ok, fail, isUniqueViolation } from "./errors.mjs";
import { adminGuard, writeAudit } from "./permissions.mjs";
import { vStr, vEnum, vInt, vRating, vUuid, vJson, vI18nMap, nowIso, countRows } from "./validate.mjs";
import { applyStockChange, readStock, writeStockLog } from "./inventory.mjs";
import { INSTALLMENT_PERIODS, parseInstallmentConfig } from "./installments.mjs";

const PRODUCT_STATUS = ["draft", "on", "off"];
const ON_OFF = ["on", "off"];
const SKU_CODE_RE = /^[A-Za-z0-9_-]{4,40}$/;
const IMAGE_KEY_RE = /^[a-z]+\/[0-9a-f-]{36}\.(png|jpg|webp)$/;

// 品牌名：字母/数字开头，可含空格与常见连接符，1–40 字符（中英文均可）
const BRAND_RE = /^[\p{L}\p{N}][\p{L}\p{N} .&'-]{0,39}$/u;

function vBrand(v, field) {
  return typeof v === "string" && v.trim() ? vStr(v, field, { min: 1, max: 40, pattern: BRAND_RE }) : null;
}

function keywordFilter(query, q) {
  const kw = typeof query.keyword === "string" ? query.keyword.trim().replace(/[%*(),".]/g, "") : "";
  return kw ? q.or(`title.ilike.*${kw}*,subtitle.ilike.*${kw}*,brand.ilike.*${kw}*`) : q;
}

/**
 * 目录指纹：随 bootstrap 下发，前端据此判断「后台改过商品/分类没有」。
 * product_skus 必须单独计入：改价/改库存只写 SKU 行，不会顶起 products.updated_at。
 * 每表两趟读（都在 Promise.all 里并发）：
 *   · 总数走 countRows 那条已实测的「limit 1 + count=exact」路径，负责增删；
 *   · 时间戳单独排除 updated_at 为空的历史行——本库 updated_at 可空且无默认值，
 *     而 PostgREST 的 desc 默认把空值排在最前，若不排除，一条空行就能把整段永远钉成 "-"，
 *     于是「只改价、不加行」这类编辑再也进不了指纹。
 * 任一表读失败就整体返回 null —— 指纹缺失只是不触发重取，不能让 bootstrap 挂掉。
 */
export async function catalogFingerprint(supabase) {
  const stamp = async (table) => {
    const [total, latest] = await Promise.all([
      supabase.from(table).select("id", { count: "exact" }).is("deleted_at", null).limit(1),
      supabase.from(table).select("updated_at").is("deleted_at", null).not("updated_at", "is", null)
        .order("updated_at", { ascending: false }).limit(1),
    ]);
    if (total?.error || latest?.error) return null;
    return `${total.count ?? 0}@${latest.data?.[0]?.updated_at ?? "-"}`;
  };
  const [products, skus, categories] = await Promise.all([
    stamp("products"), stamp("product_skus"), stamp("categories"),
  ]);
  if (!products || !skus || !categories) return null;
  return `p=${products}|s=${skus}|c=${categories}`;
}

async function queryCategories(supabase, onlyOn) {
  let q = supabase.from("categories")
    .select("id,parent_id,name,name_i18n,icon_key,sort_order,status")
    .is("deleted_at", null);
  if (onlyOn) q = q.eq("status", "on");
  const { data, error } = await q.order("sort_order", { ascending: true }).order("created_at", { ascending: false });
  if (error) throw new AppError(500, "internal_error");
  return data ?? [];
}

// —— P1 分类树（on + 未删，两级）——
export async function categoriesList(supabase) {
  const rows = await queryCategories(supabase, true);
  const childMap = {};
  for (const r of rows) {
    if (r.parent_id) (childMap[r.parent_id] ??= []).push(r);
  }
  return ok({ items: rows.filter((r) => !r.parent_id).map((r) => ({ ...r, children: childMap[r.id] ?? [] })) });
}

async function skuStats(supabase, productIds) {
  const stats = new Map();
  if (!productIds.length) return stats;
  const { data: skus } = await supabase.from("product_skus")
    .select("product_id,price_base,available_stock,frozen_stock,sold_count,status")
    .in("product_id", productIds).eq("status", "on").is("deleted_at", null);
  for (const s of skus ?? []) {
    const cur = stats.get(s.product_id) ?? { min_price: null, total_stock: 0, frozen_stock: 0, total_sold: 0 };
    const p = Number(s.price_base);
    cur.min_price = cur.min_price === null ? p : Math.min(cur.min_price, p);
    cur.total_stock += Number(s.available_stock);
    cur.frozen_stock += Number(s.frozen_stock);
    cur.total_sold += Number(s.sold_count ?? 0);
    stats.set(s.product_id, cur);
  }
  return stats;
}

// —— P2 商品列表（status=on；offset+20，读 21 判 hasMore）——
// query.installment=true 时切换为「分期专区」扫描模式：平台无 jsonb 路径过滤，按 SCAN_LIMIT 拉全量后在函数层筛
// extra.installment.enabled 的商品再分页（与 catalogBrands 同一套扫描聚合口径）。
const PRODUCTS_COLS = "id,category_id,title,title_i18n,subtitle,subtitle_i18n,brand,images,tags,extra,"
  + "rating_avg,rating_count,sold_total,sort_order";

async function decorateProducts(supabase, items) {
  const stats = await skuStats(supabase, items.map((p) => p.id));
  const names = new Map();
  const catIds = [...new Set(items.map((p) => p.category_id))];
  if (catIds.length) {
    const { data: cats } = await supabase.from("categories").select("id,name,name_i18n").in("id", catIds);
    for (const c of cats ?? []) names.set(c.id, c);
  }
  return items.map((p) => {
    const inst = parseInstallmentConfig(p.extra);
    return {
      ...p,
      category_name: names.get(p.category_id)?.name ?? null,
      category_name_i18n: names.get(p.category_id)?.name_i18n ?? null,
      min_price: stats.get(p.id)?.min_price ?? null,
      total_stock: stats.get(p.id)?.total_stock ?? 0,
      rating_avg: p.rating_avg === null || p.rating_avg === undefined ? null : Number(p.rating_avg),
      rating_count: Number(p.rating_count ?? 0),
      // 后台手填的 sold_total 优先；留空则回落到 Σ SKU 实际销量（与 productDetail 同一口径）
      sold_total: Number(p.sold_total ?? 0) || (stats.get(p.id)?.total_sold ?? 0),
      installment: inst,
    };
  });
}

export async function productsList(supabase, query) {
  const offset = vInt(query.offset ?? 0, "offset", { min: 0, max: 100000 });
  const limit = 20;
  const installmentOnly = query.installment === "true" || query.installment === "1";

  if (installmentOnly) {
    const SCAN_LIMIT = 1000;
    let sq = supabase.from("products").select(PRODUCTS_COLS).eq("status", "on").is("deleted_at", null);
    if (query.category_id) sq = sq.eq("category_id", vUuid(query.category_id, "category_id"));
    if (query.brand) sq = sq.eq("brand", vStr(query.brand, "brand", { min: 1, max: 40 }));
    sq = keywordFilter(query, sq);
    const { data, error } = await sq.order("sort_order", { ascending: true }).order("created_at", { ascending: false }).limit(SCAN_LIMIT + 1);
    if (error) throw new AppError(500, "internal_error");
    const enabled = (data ?? []).filter((p) => parseInstallmentConfig(p.extra).enabled);
    const page = enabled.slice(offset, offset + limit);
    const hasMore = enabled.length > offset + limit || (data ?? []).length > SCAN_LIMIT;
    return ok({
      offset, limit, has_more: hasMore,
      next_offset: hasMore ? offset + limit : null,
      items: await decorateProducts(supabase, page),
    });
  }

  let q = supabase.from("products").select(PRODUCTS_COLS).eq("status", "on").is("deleted_at", null);
  if (query.category_id) q = q.eq("category_id", vUuid(query.category_id, "category_id"));
  if (query.brand) q = q.eq("brand", vStr(query.brand, "brand", { min: 1, max: 40 }));
  q = keywordFilter(query, q);
  const { data, error } = await q.order("sort_order", { ascending: true }).order("created_at", { ascending: false }).range(offset, offset + limit);
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  const items = rows.slice(0, limit);
  return ok({
    offset,
    limit,
    has_more: rows.length > limit,
    next_offset: rows.length > limit ? offset + limit : null,
    items: await decorateProducts(supabase, items),
  });
}

// —— P4 品牌聚合（在售未删商品的非空品牌去重 + 计数；可按分类收窄，供前台品牌筛选条）——
// 平台无 group by 能力，故限量拉取 brand 列后在函数层聚合；超出 SCAN_LIMIT 时 has_more=true。
export async function catalogBrands(supabase, query) {
  const SCAN_LIMIT = 1000;
  let q = supabase.from("products").select("brand").eq("status", "on").is("deleted_at", null).not("brand", "is", null);
  if (query.category_id) q = q.eq("category_id", vUuid(query.category_id, "category_id"));
  const { data, error } = await q.limit(SCAN_LIMIT + 1);
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  const count = new Map();
  for (const r of rows.slice(0, SCAN_LIMIT)) {
    if (typeof r.brand !== "string" || !r.brand) continue;
    count.set(r.brand, (count.get(r.brand) ?? 0) + 1);
  }
  const items = [...count.entries()]
    .map(([brand, products]) => ({ brand, products }))
    .sort((a, b) => b.products - a.products || a.brand.localeCompare(b.brand));
  return ok({ items, has_more: rows.length > SCAN_LIMIT });
}

// —— P3 商品详情（含 on SKU；currency_prices 仅供展示换算，下单快照在 M2b）——
export async function productDetail(supabase, query) {
  const id = vUuid(query.id, "id");
  const { data: product } = await supabase.from("products")
    .select("id,category_id,title,title_i18n,subtitle,subtitle_i18n,brand,description,description_i18n,images,tags,extra,rating_avg,rating_count,sold_total,sort_order,status")
    .eq("id", id).maybeSingle();
  if (!product || product.status !== "on" || product.deleted_at) {
    return fail("not_found", "商品不存在或已下架", null, 404);
  }
  const { data: skus } = await supabase.from("product_skus")
    .select("id,spec_name,spec_name_i18n,sku_code,price_base,original_price_base,currency_prices,available_stock,sold_count")
    .eq("product_id", id).eq("status", "on").is("deleted_at", null)
    .order("price_base", { ascending: true });
  const { data: category } = await supabase.from("categories")
    .select("id,name,name_i18n").eq("id", product.category_id).eq("status", "on").is("deleted_at", null).maybeSingle();
  const soldTotal = (skus ?? []).reduce((s, k) => s + Number(k.sold_count ?? 0), 0);
  return ok({
    product: {
      ...product,
      installment: parseInstallmentConfig(product.extra),
      rating_avg: product.rating_avg === null || product.rating_avg === undefined ? null : Number(product.rating_avg),
      rating_count: Number(product.rating_count ?? 0),
      sold_total: Number(product.sold_total ?? 0) || soldTotal,
    },
    skus: skus ?? [], category: category ?? null,
  });
}

// —— PR2 后台分类列表（含 off）——
export async function adminCategories(supabase, request) {
  await adminGuard(supabase, request, "product.read");
  return ok({ items: await queryCategories(supabase, false) });
}

export async function adminCategorySave(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "product.manage");
  const id = body.category_id ? vUuid(body.category_id, "category_id") : null;
  const parentId = body.parent_id ? vUuid(body.parent_id, "parent_id") : null;
  if (parentId) {
    const { data: parent } = await supabase.from("categories")
      .select("id,parent_id").eq("id", parentId).is("deleted_at", null).maybeSingle();
    if (!parent) return fail("not_found", "父分类不存在", null, 404);
    if (parent.parent_id) return fail("invalid_request", "分类树仅支持两级");
    if (id && parent.id === id) return fail("invalid_request", "不能以自身为父分类");
  }
  const values = {
    parent_id: parentId,
    name: vStr(body.name, "name", { min: 1, max: 60 }),
    name_i18n: vJson(body.name_i18n ?? {}, "name_i18n"),
    icon_key: body.icon_key ? vStr(body.icon_key, "icon_key", { max: 120, pattern: IMAGE_KEY_RE }) : null,
    sort_order: vInt(body.sort_order ?? 0, "sort_order", { min: 0, max: 9999 }),
    status: vEnum(body.status ?? "on", "status", ON_OFF),
  };
  if (id) {
    const { error } = await supabase.from("categories")
      .update({ ...values, updated_at: nowIso() }).eq("id", id).is("deleted_at", null);
    if (error) throw new AppError(500, "internal_error");
  } else {
    const newId = crypto.randomUUID();
    const { error } = await supabase.from("categories")
      .insert({ id: newId, ...values, created_at: nowIso(), updated_at: nowIso() });
    if (error) throw new AppError(500, "internal_error");
    values.id = newId;
  }
  await writeAudit(supabase, {
    adminId: actor.id, action: "category.save", targetType: "category", targetId: values.id ?? id,
    detail: { name: values.name, status: values.status },
  });
  return ok({ category_id: values.id ?? id });
}

// —— PR1 后台商品编辑回读（任意状态；文档C 只增不改，作为 admin/products 的 detail 伴生端点）——
export async function adminProductDetail(supabase, request, query) {
  await adminGuard(supabase, request, "product.read");
  const id = vUuid(query.id, "id");
  const { data: product } = await supabase.from("products")
    .select("id,category_id,title,title_i18n,subtitle,subtitle_i18n,brand,description,description_i18n,images,tags,extra,rating_avg,rating_count,sold_total,sort_order,status,created_at,updated_at")
    .eq("id", id).is("deleted_at", null).maybeSingle();
  if (!product) return fail("not_found", "商品不存在", null, 404);
  const { data: skus } = await supabase.from("product_skus")
    .select("id,spec_name,spec_name_i18n,sku_code,price_base,original_price_base,currency_prices,available_stock,frozen_stock,sold_count,status")
    .eq("product_id", id).is("deleted_at", null).order("created_at", { ascending: true });
  return ok({ product, skus: skus ?? [] });
}

// —— PR1 后台商品列表（全状态 + SKU 聚合含冻结）——
export async function adminProducts(supabase, request, query) {
  await adminGuard(supabase, request, "product.read");
  const offset = vInt(query.offset ?? 0, "offset", { min: 0, max: 100000 });
  const limit = 20;
  const status = query.status ? vEnum(query.status, "status", PRODUCT_STATUS) : null;
  const categoryId = query.category_id ? vUuid(query.category_id, "category_id") : null;
  const mkQuery = (cols, opts) => {
    let q = supabase.from("products").select(cols, opts).is("deleted_at", null);
    if (status) q = q.eq("status", status);
    if (categoryId) q = q.eq("category_id", categoryId);
    return keywordFilter(query, q);
  };
  const total = await countRows(mkQuery("id", { count: "exact" }));
  const { data, error } = await mkQuery(
    "id,category_id,title,brand,subtitle,images,status,sort_order,created_at,updated_at",
  ).order("sort_order", { ascending: true }).order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw new AppError(500, "internal_error");
  const items = data ?? [];
  const stats = await skuStats(supabase, items.map((p) => p.id));
  const { data: skusAll } = items.length
    ? await supabase.from("product_skus").select("product_id").in("product_id", items.map((p) => p.id)).is("deleted_at", null)
    : { data: [] };
  const skuCount = {};
  for (const s of skusAll ?? []) skuCount[s.product_id] = (skuCount[s.product_id] ?? 0) + 1;
  return ok({
    total,
    offset, limit,
    items: items.map((p) => ({
      ...p,
      min_price: stats.get(p.id)?.min_price ?? null,
      total_stock: stats.get(p.id)?.total_stock ?? 0,
      frozen_stock: stats.get(p.id)?.frozen_stock ?? 0,
      sku_count: skuCount[p.id] ?? 0,
    })),
  });
}

// 规范化 products.extra.installment（后台录入落库前清洗）：只保留合法期数、enabled 与 periods 一致。
// 保留 extra 其他键不动（extra 是通用 jsonb，可能有别的功能在用）。
function normalizeInstallmentExtra(rawExtra) {
  const extra = { ...(rawExtra && typeof rawExtra === "object" && !Array.isArray(rawExtra) ? rawExtra : {}) };
  const input = extra.installment;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    delete extra.installment;
    return extra;
  }
  const periods = [...new Set((Array.isArray(input.periods) ? input.periods : [])
    .map((p) => Number(p)).filter((p) => INSTALLMENT_PERIODS.includes(p)))]
    .sort((a, b) => a - b);
  const enabled = input.enabled === true && periods.length > 0;
  extra.installment = { enabled, periods };
  if (!enabled) extra.installment.periods = [];
  return extra;
}

// —— PR1 SPU+SKU 整体保存（改价不影响历史订单快照；库存变化只走 PR3/下单链路）——
function validateSpu(body) {
  return {
    category_id: vUuid(body.category_id, "category_id"),
    title: vStr(body.title, "title", { min: 1, max: 200 }),
    title_i18n: vJson(body.title_i18n ?? {}, "title_i18n"),
    subtitle: body.subtitle ? vStr(body.subtitle, "subtitle", { max: 200 }) : null,
    subtitle_i18n: vI18nMap(body.subtitle_i18n, "subtitle_i18n", 200),
    brand: vBrand(body.brand, "brand"),
    description: body.description ? vStr(body.description, "description", { max: 5000 }) : "",
    description_i18n: vI18nMap(body.description_i18n, "description_i18n", 5000),
    images: Array.isArray(body.images) && body.images.length <= 9
      ? body.images.map((k, i) => vStr(k, `images[${i}]`, { min: 8, max: 120, pattern: IMAGE_KEY_RE }))
      : [],
    tags: Array.isArray(body.tags) && body.tags.length <= 10
      ? body.tags.map((tag, i) => vStr(tag, `tags[${i}]`, { min: 1, max: 30 }))
      : [],
    status: vEnum(body.status, "status", PRODUCT_STATUS),
    // 三项为后台可直接维护的展示数据：留空即回落（评分不显示、已售回到 Σ SKU 销量）
    rating_avg: vRating(body.rating_avg, "rating_avg"),
    rating_count: vInt(body.rating_count, "rating_count", { min: 0, max: 999999, optional: true }),
    sold_total: vInt(body.sold_total, "sold_total", { min: 0, max: 9999999, optional: true }),
    sort_order: vInt(body.sort_order ?? 0, "sort_order", { min: 0, max: 9999 }),
    extra: normalizeInstallmentExtra(vJson(body.extra ?? {}, "extra")),
  };
}

function validateSkuIn(s, i) {
  return {
    id: s.id ? vUuid(s.id, `skus[${i}].id`) : null,
    spec_name: vStr(s.spec_name, `skus[${i}].spec_name`, { min: 1, max: 60 }),
    spec_name_i18n: vI18nMap(s.spec_name_i18n, `skus[${i}].spec_name_i18n`, 60),
    sku_code: vStr(s.sku_code, `skus[${i}].sku_code`, { min: 4, max: 40, pattern: SKU_CODE_RE }),
    price_base: vInt(s.price_base, `skus[${i}].price_base`, { min: 1, max: 999999999 }),
    original_price_base: s.original_price_base ? vInt(s.original_price_base, `skus[${i}].original_price_base`, { min: 1, max: 999999999 }) : null,
    currency_prices: vJson(s.currency_prices ?? {}, `skus[${i}].currency_prices`),
    available_stock: vInt(s.available_stock ?? 0, `skus[${i}].available_stock`, { min: 0, max: 999999 }),
    status: vEnum(s.status ?? "on", `skus[${i}].status`, ON_OFF),
  };
}

// —— 批量导入单行（前端已解析 CSV 并把元→分；此处仅按商品表单字段口径再校验一遍）——
function validateBulkRow(r, i) {
  return {
    category_name: vStr(r.category_name, `rows[${i}].category_name`, { min: 1, max: 60 }),
    group_key: r.group_key ? vStr(r.group_key, `rows[${i}].group_key`, { max: 60 }) : "",
    title: vStr(r.title, `rows[${i}].title`, { min: 1, max: 200 }),
    brand: vBrand(r.brand, `rows[${i}].brand`),
    subtitle: r.subtitle ? vStr(r.subtitle, `rows[${i}].subtitle`, { max: 200 }) : "",
    description: r.description ? vStr(r.description, `rows[${i}].description`, { max: 5000 }) : "",
    spec_name: r.spec_name ? vStr(r.spec_name, `rows[${i}].spec_name`, { min: 1, max: 60 }) : "标准",
    sku_code: vStr(r.sku_code, `rows[${i}].sku_code`, { min: 4, max: 40, pattern: SKU_CODE_RE }),
    price_base: vInt(r.price_base, `rows[${i}].price_base`, { min: 1, max: 999999999 }),
    original_price_base: r.original_price_base ? vInt(r.original_price_base, `rows[${i}].original_price_base`, { min: 1, max: 999999999 }) : null,
    available_stock: vInt(r.available_stock ?? 0, `rows[${i}].available_stock`, { min: 0, max: 999999 }),
    status: vEnum(r.status ?? "on", `rows[${i}].status`, PRODUCT_STATUS),
  };
}

async function initialStockLog(supabase, actorId, skuId, stock) {
  await writeStockLog(supabase, {
    skuId, changeType: "adjust", quantity: stock,
    before: { available: 0, frozen: 0, sold: 0 },
    after: { available: stock, frozen: 0, sold: 0 },
    referenceType: "admin_create", operator: actorId, reason: "新建 SKU 初始库存",
  });
}

export async function adminProductSave(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "product.manage");
  const productId = body.product_id ? vUuid(body.product_id, "product_id") : null;
  const spu = validateSpu(body);
  const skusIn = Array.isArray(body.skus) && body.skus.length <= 30
    ? body.skus.map(validateSkuIn)
    : [];
  const seenCodes = new Set();
  const seenSpecs = new Set();
  for (const s of skusIn) {
    if (seenCodes.has(s.sku_code)) return fail("invalid_request", "SKU 编码重复", { sku_code: s.sku_code });
    if (seenSpecs.has(s.spec_name)) return fail("invalid_request", "规格名重复", { spec_name: s.spec_name });
    seenCodes.add(s.sku_code);
    seenSpecs.add(s.spec_name);
  }
  const { data: category } = await supabase.from("categories")
    .select("id").eq("id", spu.category_id).is("deleted_at", null).maybeSingle();
  if (!category) return fail("invalid_request", "分类不存在", { field: "category_id" });

  let finalId = productId;
  if (productId) {
    const { data: existing } = await supabase.from("products")
      .select("id,status").eq("id", productId).is("deleted_at", null).maybeSingle();
    if (!existing) return fail("not_found", "商品不存在", null, 404);
    const { error } = await supabase.from("products")
      .update({ ...spu, updated_at: nowIso() }).eq("id", productId);
    if (error) throw new AppError(500, "internal_error");
    // SKU 同步：更新已有（库存列不在此变更）、新增（初始库存记 adjust 流水）、未含者软删
    const { data: existingSkus } = await supabase.from("product_skus")
      .select("id,available_stock,frozen_stock,sold_count").eq("product_id", productId).is("deleted_at", null);
    const keepIds = new Set(skusIn.filter((s) => s.id).map((s) => s.id));
    for (const s of skusIn) {
      const fields = {
        spec_name: s.spec_name, spec_name_i18n: s.spec_name_i18n, sku_code: s.sku_code, price_base: s.price_base,
        original_price_base: s.original_price_base, currency_prices: s.currency_prices, status: s.status,
      };
      if (s.id) {
        const target = (existingSkus ?? []).find((e) => e.id === s.id);
        if (!target) return fail("invalid_request", "SKU 不属于该商品", { sku_id: s.id });
        const { error } = await supabase.from("product_skus").update({ ...fields, updated_at: nowIso() }).eq("id", s.id);
        if (error) {
          if (isUniqueViolation(error)) return fail("claim_conflict", "SKU 编码或规格名已被占用", { sku_code: s.sku_code }, 409);
          throw new AppError(500, "internal_error");
        }
      } else {
        const newId = crypto.randomUUID();
        const { error } = await supabase.from("product_skus").insert({
          id: newId, product_id: productId, ...fields,
          available_stock: s.available_stock, frozen_stock: 0, sold_count: 0, created_at: nowIso(), updated_at: nowIso(),
        });
        if (error) {
          if (isUniqueViolation(error)) return fail("claim_conflict", "SKU 编码或规格名已被占用", { sku_code: s.sku_code }, 409);
          throw new AppError(500, "internal_error");
        }
        if (s.available_stock > 0) {
          await initialStockLog(supabase, actor.id, newId, s.available_stock);
        }
      }
    }
    // 未出现在提交列表中的既有 SKU 软删（前端编辑页始终回传完整 SKU 集合）
    for (const e of existingSkus ?? []) {
      if (!keepIds.has(e.id)) {
        const { error } = await supabase.from("product_skus")
          .update({ deleted_at: nowIso(), status: "off", updated_at: nowIso() }).eq("id", e.id);
        if (error) throw new AppError(500, "internal_error");
      }
    }
  } else {
    finalId = crypto.randomUUID();
    const { error } = await supabase.from("products").insert({
      id: finalId, ...spu, created_at: nowIso(), updated_at: nowIso(),
    });
    if (error) throw new AppError(500, "internal_error");
    for (const s of skusIn) {
      const newId = crypto.randomUUID();
      const { error: e2 } = await supabase.from("product_skus").insert({
        id: newId, product_id: finalId,
        spec_name: s.spec_name, spec_name_i18n: s.spec_name_i18n, sku_code: s.sku_code, price_base: s.price_base,
        original_price_base: s.original_price_base, currency_prices: s.currency_prices, status: s.status,
        available_stock: s.available_stock, frozen_stock: 0, sold_count: 0, created_at: nowIso(), updated_at: nowIso(),
      });
      if (e2) {
        if (isUniqueViolation(e2)) return fail("claim_conflict", "SKU 编码或规格名已被占用", { sku_code: s.sku_code }, 409);
        throw new AppError(500, "internal_error");
      }
      if (s.available_stock > 0) {
        await initialStockLog(supabase, actor.id, newId, s.available_stock);
      }
    }
  }
  await writeAudit(supabase, {
    adminId: actor.id, action: "product.save", targetType: "product", targetId: finalId,
    detail: { title: spu.title, status: spu.status, sku_count: skusIn.length },
  });
  return ok({ product_id: finalId });
}

// —— 批量导入（前端解析 CSV → 结构化行，元→分已折算；以 sku_code 为 upsert 键，款号||标题分组建品）——
// 建品分组：组内若已有匹配到既有 SKU，则复用其所属商品；否则按首行 SPU 新建商品。逐行：既有 SKU 改价/状态并按差额设库存，新品 SKU 落库并记初始库存流水。不处理图片。
export async function adminProductBulk(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "product.manage");
  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  if (!rawRows.length) return fail("invalid_request", "没有可导入的数据行");
  if (rawRows.length > 200) return fail("invalid_request", "单次导入不超过 200 行", { count: rawRows.length });

  const rows = [];
  const results = [];
  for (let i = 0; i < rawRows.length; i += 1) {
    try {
      rows.push({ index: i, ...validateBulkRow(rawRows[i], i) });
    } catch (e) {
      results.push({ index: i, sku_code: rawRows[i]?.sku_code ?? "", action: "error", error: e?.message ?? "字段校验失败" });
    }
  }

  const { data: cats } = await supabase.from("categories").select("id,name").is("deleted_at", null);
  const catMap = new Map();
  for (const c of cats ?? []) if (!catMap.has(c.name)) catMap.set(c.name, c.id);

  const codes = [...new Set(rows.map((r) => r.sku_code))];
  const { data: existingSkus } = codes.length
    ? await supabase.from("product_skus").select("id,sku_code,product_id,available_stock").in("sku_code", codes).is("deleted_at", null)
    : { data: [] };
  const skuMap = new Map();
  for (const s of existingSkus ?? []) skuMap.set(s.sku_code, s);

  const groupKey = (r) => r.group_key || r.title;
  const groupOrder = [];
  const groupMeta = new Map();
  for (const r of rows) {
    const g = groupKey(r);
    if (!groupMeta.has(g)) { groupMeta.set(g, r); groupOrder.push(g); }
  }

  const groupProduct = new Map();
  let productsCreated = 0;
  let failed = results.length;
  for (const g of groupOrder) {
    const meta = groupMeta.get(g);
    let pid = null;
    for (const r of rows) {
      if (groupKey(r) !== g) continue;
      const ex = skuMap.get(r.sku_code);
      if (ex) { pid = ex.product_id; break; }
    }
    if (pid) { groupProduct.set(g, pid); continue; }
    const categoryId = catMap.get(meta.category_name);
    if (!categoryId) {
      for (const r of rows) {
        if (groupKey(r) === g) {
          results.push({ index: r.index, sku_code: r.sku_code, action: "error", error: `分类「${meta.category_name}」不存在` });
          failed += 1;
        }
      }
      groupProduct.set(g, null);
      continue;
    }
    const newId = crypto.randomUUID();
    const spu = {
      category_id: categoryId, title: meta.title, title_i18n: {},
      subtitle: meta.subtitle || null, subtitle_i18n: {},
      description: meta.description || "", description_i18n: {},
      brand: meta.brand,
      images: [], tags: [], status: meta.status, sort_order: 0, extra: {},
    };
    const { error } = await supabase.from("products").insert({ id: newId, ...spu, created_at: nowIso(), updated_at: nowIso() });
    if (error) {
      for (const r of rows) {
        if (groupKey(r) === g) {
          results.push({ index: r.index, sku_code: r.sku_code, action: "error", error: "商品创建失败" });
          failed += 1;
        }
      }
      groupProduct.set(g, null);
      continue;
    }
    groupProduct.set(g, newId);
    productsCreated += 1;
  }

  let created = 0;
  let updated = 0;
  for (const r of rows) {
    const pid = groupProduct.get(groupKey(r));
    if (!pid) continue; // 建品阶段已记错
    const skuStatus = r.status === "on" ? "on" : "off";
    const ex = skuMap.get(r.sku_code);
    if (ex) {
      // CSV 无译文列，此处刻意不回写 spec_name_i18n：清空会毁掉已有译文，保留则最坏只是改名后译文偏旧，由编辑页修正
      const { error } = await supabase.from("product_skus").update({
        spec_name: r.spec_name, price_base: r.price_base, original_price_base: r.original_price_base,
        status: skuStatus, updated_at: nowIso(),
      }).eq("id", ex.id);
      if (error) {
        results.push({ index: r.index, sku_code: r.sku_code, action: "error", error: isUniqueViolation(error) ? "SKU 编码或规格名已被占用" : "更新失败" });
        failed += 1;
        continue;
      }
      const delta = r.available_stock - Number(ex.available_stock);
      if (delta !== 0) {
        const res = await applyStockChange(supabase, {
          skuId: ex.id, changeType: "adjust", quantity: delta,
          referenceType: "admin_adjust", operator: actor.id, reason: "批量导入设置库存",
        });
        if (!res.ok) {
          results.push({ index: r.index, sku_code: r.sku_code, action: "error", error: `库存写入失败（${res.reason}）` });
          failed += 1;
          continue;
        }
      }
      results.push({ index: r.index, sku_code: r.sku_code, action: "updated", product_id: ex.product_id });
      updated += 1;
    } else {
      const newSkuId = crypto.randomUUID();
      const { error } = await supabase.from("product_skus").insert({
        id: newSkuId, product_id: pid,
        spec_name: r.spec_name, spec_name_i18n: {}, sku_code: r.sku_code, price_base: r.price_base,
        original_price_base: r.original_price_base, currency_prices: {}, status: skuStatus,
        available_stock: r.available_stock, frozen_stock: 0, sold_count: 0, created_at: nowIso(), updated_at: nowIso(),
      });
      if (error) {
        results.push({ index: r.index, sku_code: r.sku_code, action: "error", error: isUniqueViolation(error) ? "SKU 编码或规格名已被占用" : "SKU 创建失败" });
        failed += 1;
        continue;
      }
      if (r.available_stock > 0) await initialStockLog(supabase, actor.id, newSkuId, r.available_stock);
      skuMap.set(r.sku_code, { id: newSkuId, product_id: pid, available_stock: r.available_stock });
      results.push({ index: r.index, sku_code: r.sku_code, action: "created", product_id: pid });
      created += 1;
    }
  }

  await writeAudit(supabase, {
    adminId: actor.id, action: "product.bulk", targetType: "product", targetId: null,
    detail: { rows: rawRows.length, products_created: productsCreated, created, updated, failed },
  });
  return ok({
    total: rawRows.length,
    products_created: productsCreated,
    created, updated, failed,
    results: results.sort((a, b) => a.index - b.index),
  });
}

// —— PR1 上/下架/软删（下架与删除为 ⚠：confirm 由端点内部按动作要求）——
export async function adminProductStatus(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "product.manage");
  const id = vUuid(body.product_id, "product_id");
  const action = vEnum(body.action, "action", ["on", "off", "del"]);
  if (action !== "on" && body.confirm !== true) {
    throw new AppError(400, "confirm_required", "高危操作需二次确认");
  }
  const { data: product } = await supabase.from("products")
    .select("id,title,status").eq("id", id).is("deleted_at", null).maybeSingle();
  if (!product) return fail("not_found", "商品不存在", null, 404);
  // 前端价格/库存只统计 status=on 的 SKU：
  //   · 一个规格都没有 → 上架只会得到「没有价格、加不了购」的卡片，直接拒（写库前先拒，避免半途状态）
  //   · 有规格但全关 → 整批打开（保留后台按单个规格下架的能力，只在「完全不可售」时兜底）
  let skusToOpen = [];
  if (action === "on") {
    const { data: skus, error: skuErr } = await supabase.from("product_skus")
      .select("id,status").eq("product_id", id).is("deleted_at", null);
    if (skuErr) throw new AppError(500, "internal_error");
    if (!skus?.length) return fail("invalid_request", "该商品还没有规格，请先在编辑页添加规格再上架", { product_id: id });
    if (!skus.some((s) => s.status === "on")) skusToOpen = skus.map((s) => s.id);
  }
  const patch = action === "del"
    ? { status: "off", deleted_at: nowIso(), updated_at: nowIso() }
    : { status: action, updated_at: nowIso() };
  const { data: updated } = await supabase.from("products")
    .update(patch).eq("id", id).eq("status", product.status).is("deleted_at", null).select("id");
  if (!updated?.length) return fail("state_conflict", "商品状态已变化，请刷新重试", null, 409);
  let skusOpened = 0;
  if (skusToOpen.length) {
    const { data: opened } = await supabase.from("product_skus")
      .update({ status: "on", updated_at: nowIso() }).in("id", skusToOpen).is("deleted_at", null).select("id");
    skusOpened = opened?.length ?? 0;
  }
  if (action === "del") {
    await supabase.from("product_skus")
      .update({ deleted_at: nowIso(), status: "off", updated_at: nowIso() })
      .eq("product_id", id).is("deleted_at", null);
  }
  await writeAudit(supabase, {
    adminId: actor.id, action: `product.${action}`, targetType: "product", targetId: id,
    detail: { title: product.title, from: product.status, skus_opened: skusOpened },
  });
  return ok({ product_id: id, status: action === "del" ? "deleted" : action, skus_opened: skusOpened });
}

// —— PR3 库存调整（⚠ route highRisk；三态 CAS 防负 + 流水，见 inventory.mjs 契约）——
export async function adminStockAdjust(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "stock.adjust");
  const skuId = vUuid(body.sku_id, "sku_id");
  const delta = vInt(body.delta, "delta", { min: -999999, max: 999999 });
  if (delta === 0) throw new AppError(400, "invalid_request", "变动数量不能为 0");
  const reason = vStr(body.reason, "reason", { min: 1, max: 200 });
  const res = await applyStockChange(supabase, {
    skuId, changeType: "adjust", quantity: delta, referenceType: "admin_adjust", operator: actor.id, reason,
  });
  if (!res.ok) {
    if (res.reason === "not_found") throw new AppError(404, "not_found", "SKU 不存在");
    if (res.reason === "insufficient") {
      const stock = await readStock(supabase, skuId);
      throw new AppError(409, "insufficient_stock", "可售库存不足，调整后不可为负",
        { available: stock?.available ?? null, delta });
    }
    if (res.reason === "conflict") throw new AppError(409, "claim_conflict", "库存正在被其他操作修改，请重试");
    throw new AppError(500, "internal_error", "库存流水写入失败");
  }
  await writeAudit(supabase, {
    adminId: actor.id, action: "stock.adjust", targetType: "sku", targetId: skuId,
    detail: { delta, reason, available_before: res.before.available, available_after: res.after.available },
  });
  return ok({ sku_id: skuId, available_before: res.before.available, available_after: res.after.available });
}

// —— PR4 库存流水查询 ——
export async function adminInventoryLogs(supabase, request, query) {
  await adminGuard(supabase, request, "product.read");
  const offset = vInt(query.offset ?? 0, "offset", { min: 0, max: 100000 });
  const limit = 20;
  let q = supabase.from("inventory_logs")
    .select("id,sku_id,change_type,quantity,available_before,available_after,frozen_after,sold_after,reference_type,reference_id,operator,reason,created_at");
  if (query.sku_id) q = q.eq("sku_id", vUuid(query.sku_id, "sku_id"));
  if (query.product_id) {
    const { data: skusOfProduct } = await supabase.from("product_skus")
      .select("id").eq("product_id", vUuid(query.product_id, "product_id"));
    const ids = (skusOfProduct ?? []).map((s) => s.id);
    if (!ids.length) return ok({ offset, limit, items: [] });
    q = q.in("sku_id", ids);
  }
  if (query.reference_type) q = q.eq("reference_type", vStr(query.reference_type, "reference_type", { min: 3, max: 30 }));
  if (query.reference_id) q = q.eq("reference_id", vUuid(query.reference_id, "reference_id"));
  const { data, error } = await q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw new AppError(500, "internal_error");
  const items = data ?? [];
  const skuIds = [...new Set(items.map((r) => r.sku_id))];
  const skuMap = new Map();
  if (skuIds.length) {
    const { data: skus } = await supabase.from("product_skus")
      .select("id,sku_code,spec_name,product_id").in("id", skuIds);
    for (const s of skus ?? []) skuMap.set(s.id, s);
  }
  return ok({
    offset, limit,
    items: items.map((r) => ({ ...r, sku: skuMap.get(r.sku_id) ?? null })),
  });
}
