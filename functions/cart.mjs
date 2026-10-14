// 购物车 C1–C4（文档C §三；carts 为全库唯一允许物理 delete 的表，文档A §12）
import { AppError, isUniqueViolation } from "./errors.mjs";
import { vInt, vBool, vUuid, nowIso } from "./validate.mjs";
import { parseInstallmentConfig } from "./installments.mjs";

const QTY_MAX = 999;

async function loadSkuForCart(supabase, skuId) {
  const { data: sku } = await supabase.from("product_skus")
    .select("id,product_id,spec_name,spec_name_i18n,sku_code,price_base,available_stock,status")
    .eq("id", skuId).is("deleted_at", null).maybeSingle();
  if (!sku) throw new AppError(404, "not_found", "商品不存在");
  const { data: product } = await supabase.from("products")
    .select("id,title,images,status").eq("id", sku.product_id).is("deleted_at", null).maybeSingle();
  if (!product || product.status !== "on" || sku.status !== "on") {
    throw new AppError(409, "state_conflict", "商品已下架", { sku_id: skuId });
  }
  return { sku, product };
}

// —— C1 购物车列表（实时可购校验）——
export async function cartList(supabase, principal) {
  const { data: carts, error } = await supabase.from("carts")
    .select("id,sku_id,quantity,selected,created_at,updated_at")
    .eq("user_id", principal.id).order("created_at", { ascending: false });
  if (error) throw new AppError(500, "internal_error");
  const rows = carts ?? [];
  const skuIds = [...new Set(rows.map((c) => c.sku_id))];
  const skuMap = new Map();
  const productMap = new Map();
  if (skuIds.length) {
    const { data: skus } = await supabase.from("product_skus")
      .select("id,product_id,spec_name,spec_name_i18n,sku_code,price_base,available_stock,status").in("id", skuIds);
    for (const s of skus ?? []) skuMap.set(s.id, s);
    const productIds = [...new Set((skus ?? []).map((s) => s.product_id))];
    if (productIds.length) {
      const { data: products } = await supabase.from("products")
        .select("id,category_id,title,title_i18n,images,status,deleted_at,extra").in("id", productIds);
      for (const p of products ?? []) {
        if (!p.deleted_at) productMap.set(p.id, p);
      }
    }
  }
  const items = rows.map((c) => {
    const sku = skuMap.get(c.sku_id) ?? null;
    const product = sku ? productMap.get(sku.product_id) ?? null : null;
    const quantity = Number(c.quantity);
    const available = sku ? Number(sku.available_stock) : 0;
    const purchasable = !!sku && !sku.deleted_at && sku.status === "on" && !!product
      && product.status === "on" && quantity <= available;
    let reason = null;
    if (!sku || !product) reason = "gone";
    else if (product.status !== "on" || sku.status !== "on") reason = "off";
    else if (quantity > available) reason = "stock";
    return {
      ...c,
      quantity,
      sku: sku ? { id: sku.id, spec_name: sku.spec_name, spec_name_i18n: sku.spec_name_i18n ?? {}, sku_code: sku.sku_code, price_base: Number(sku.price_base) } : null,
      product: product ? { id: product.id, title: product.title, title_i18n: product.title_i18n ?? {}, images: product.images ?? [], category_id: product.category_id, installment: parseInstallmentConfig(product.extra) } : null,
      available_stock: available,
      purchasable,
      reason,
    };
  });
  const selectedAmount = items.reduce((sum, it) => (
    it.selected && it.purchasable ? sum + (it.sku?.price_base ?? 0) * it.quantity : sum
  ), 0);
  return {
    items,
    summary: {
      count: items.length,
      selected_count: items.filter((it) => it.selected).length,
      selected_amount_base: selectedAmount,
    },
  };
}

// —— C2 加购（upsert UNIQUE(user_id,sku_id)）——
export async function cartAdd(supabase, principal, body) {
  const skuId = vUuid(body.sku_id, "sku_id");
  const quantity = vInt(body.quantity ?? 1, "quantity", { min: 1, max: QTY_MAX });
  const selected = vBool(body.selected ?? true, "selected");
  const { sku } = await loadSkuForCart(supabase, skuId);
  const now = nowIso();
  const cartId = crypto.randomUUID();
  const { error } = await supabase.from("carts").insert({
    id: cartId, user_id: principal.id, sku_id: sku.id, quantity, selected,
    created_at: now, updated_at: now,
  });
  if (error) {
    if (!isUniqueViolation(error)) throw new AppError(500, "internal_error");
    const { data: existing } = await supabase.from("carts")
      .select("id,quantity").eq("user_id", principal.id).eq("sku_id", sku.id).maybeSingle();
    if (!existing) throw new AppError(409, "claim_conflict", "购物车条目冲突", null, 409);
    const merged = Math.min(QTY_MAX, Number(existing.quantity) + quantity);
    const { error: e2 } = await supabase.from("carts")
      .update({ quantity: merged, selected, updated_at: nowIso() }).eq("id", existing.id);
    if (e2) throw new AppError(500, "internal_error");
    return { cart_id: existing.id, quantity: merged, merged: true };
  }
  return { cart_id: cartId, quantity, merged: false };
}

// —— C3 改数量 / 勾选 ——
export async function cartUpdate(supabase, principal, body) {
  const id = vUuid(body.cart_id ?? body.id, "cart_id");
  const patch = { updated_at: nowIso() };
  if (body.quantity !== undefined) patch.quantity = vInt(body.quantity, "quantity", { min: 1, max: QTY_MAX });
  if (body.selected !== undefined) patch.selected = vBool(body.selected, "selected");
  if (Object.keys(patch).length === 1) throw new AppError(400, "invalid_request", "没有需要更新的字段");
  const { data, error } = await supabase.from("carts")
    .update(patch).eq("id", id).eq("user_id", principal.id).select("id");
  if (error) throw new AppError(500, "internal_error");
  if (!data?.length) throw new AppError(404, "not_found", "购物车条目不存在");
  return { cart_id: id, ...patch, updated_at: patch.updated_at };
}

// —— C4 移除（物理 delete）——
export async function cartRemove(supabase, principal, body) {
  const id = vUuid(body.cart_id ?? body.id, "cart_id");
  const { data, error } = await supabase.from("carts")
    .delete().eq("id", id).eq("user_id", principal.id).select("id");
  if (error) throw new AppError(500, "internal_error");
  if (!data?.length) throw new AppError(404, "not_found", "购物车条目不存在");
  return { removed: id };
}
