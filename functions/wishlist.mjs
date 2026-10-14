// 收藏/心愿单 A8（文档A 新增 wishlist_items；文档C 新增 WL1/WL2/WL3）
// 口径：一个用户对同一商品仅一条收藏（UNIQUE(user_id, product_id)），toggle 语义——已收藏则取消、未收藏则加入。
//       商品下架/删除不阻断收藏读取：列表回读时标注 available=false，前台据此灰显。
import { AppError, ok } from "./errors.mjs";
import { nowIso, pageParams, pageResult, vUuid } from "./validate.mjs";

const ITEM_COLS = "id,product_id,created_at";

async function productOn(supabase, productId) {
  const { data: product } = await supabase.from("products").select("id,status").eq("id", productId).is("deleted_at", null).maybeSingle();
  if (!product || product.status !== "on") throw new AppError(404, "not_found", "商品不存在或已下架", { product_id: productId });
}

// —— WL1 我的收藏列表（登录；分页 + 商品摘要 + 起价 + 是否在售）——
export async function wishlistList(supabase, principal, query) {
  const { offset, limit } = pageParams(query);
  const { data, error } = await supabase.from("wishlist_items").select(ITEM_COLS)
    .eq("user_id", principal.id).order("created_at", { ascending: false }).range(offset, offset + limit);
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];
  const productIds = rows.map((r) => r.product_id);

  const prodMap = new Map();
  const minPrice = new Map();
  if (productIds.length) {
    const { data: products } = await supabase.from("products")
      .select("id,title,title_i18n,images,subtitle,subtitle_i18n,status,deleted_at").in("id", productIds);
    for (const p of products ?? []) prodMap.set(p.id, p);
    const { data: skus } = await supabase.from("product_skus")
      .select("product_id,price_base,status,deleted_at").in("product_id", productIds).eq("status", "on").is("deleted_at", null);
    for (const s of skus ?? []) {
      const cur = minPrice.get(s.product_id);
      const p = Number(s.price_base);
      minPrice.set(s.product_id, cur == null ? p : Math.min(cur, p));
    }
  }

  const items = rows.map((r) => {
    const p = prodMap.get(r.product_id);
    return {
      product_id: r.product_id,
      added_at: r.created_at,
      title: p?.title ?? "（商品已删除）",
      title_i18n: p?.title_i18n ?? {},
      subtitle: p?.subtitle ?? null,
      subtitle_i18n: p?.subtitle_i18n ?? {},
      images: Array.isArray(p?.images) ? p.images : [],
      min_price: minPrice.get(r.product_id) ?? null,
      available: Boolean(p) && p.status === "on" && !p.deleted_at,
    };
  });
  return ok({ ...pageResult(items, offset, limit) });
}

// —— WL2 收藏状态（可选登录；未登录一律 false，供商品页心形按钮初值）——
export async function wishlistStatus(supabase, principal, query) {
  const productId = vUuid(query.product_id, "product_id");
  if (!principal?.id) return ok({ product_id: productId, favorited: false });
  const { data } = await supabase.from("wishlist_items").select("id")
    .eq("user_id", principal.id).eq("product_id", productId).maybeSingle();
  return ok({ product_id: productId, favorited: Boolean(data) });
}

// —— WL3 收藏开关（登录；存在即删、不存在即插）——
export async function wishlistToggle(supabase, principal, body) {
  const productId = vUuid(body.product_id, "product_id");
  const { data: existing } = await supabase.from("wishlist_items").select("id")
    .eq("user_id", principal.id).eq("product_id", productId).maybeSingle();
  if (existing) {
    await supabase.from("wishlist_items").delete().eq("id", existing.id).eq("user_id", principal.id);
    return ok({ product_id: productId, favorited: false });
  }
  await productOn(supabase, productId); // 仅加入在售商品；取消收藏不受此限
  const row = { id: crypto.randomUUID(), user_id: principal.id, product_id: productId, created_at: nowIso() };
  const { error } = await supabase.from("wishlist_items").insert(row).select("id").maybeSingle();
  if (error) {
    // 并发重复：视作已在列表中
    return ok({ product_id: productId, favorited: true });
  }
  return ok({ product_id: productId, favorited: true });
}
