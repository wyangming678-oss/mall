// 库存三态原子契约（文档B §六）：freeze/unfreeze/deduct/restore/adjust 全 CAS，每次变化必写 inventory_logs
import { AppError } from "./errors.mjs";
import { nowIso } from "./validate.mjs";

const DELTA = {
  freeze: (q) => ({ available: -q, frozen: q, sold: 0 }),
  unfreeze: (q) => ({ available: q, frozen: -q, sold: 0 }),
  deduct: (q) => ({ available: 0, frozen: -q, sold: q }),
  restore: (q) => ({ available: q, frozen: 0, sold: 0 }),
  // adjust 的 quantity 为带符号增量（后台库存调整）
  adjust: (q) => ({ available: q, frozen: 0, sold: 0 }),
};

export async function writeStockLog(supabase, {
  skuId, changeType, quantity, before, after, referenceType, referenceId = null, operator, reason = null,
}) {
  const { error } = await supabase.from("inventory_logs").insert({
    id: crypto.randomUUID(),
    sku_id: skuId,
    change_type: changeType,
    quantity,
    available_before: before.available,
    available_after: after.available,
    frozen_before: before.frozen,
    frozen_after: after.frozen,
    sold_before: before.sold,
    sold_after: after.sold,
    reference_type: referenceType,
    reference_id: referenceId,
    operator,
    reason,
    created_at: nowIso(),
  });
  return !error;
}

export async function readStock(supabase, skuId) {
  const { data } = await supabase.from("product_skus")
    .select("id,product_id,available_stock,frozen_stock,sold_count")
    .eq("id", skuId).is("deleted_at", null).maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    product_id: data.product_id,
    available: Number(data.available_stock),
    frozen: Number(data.frozen_stock),
    sold: Number(data.sold_count),
  };
}

// 返回 { ok:true, before, after } | { ok:false, reason:"not_found"|"insufficient"|"conflict"|"log_failed" }
export async function applyStockChange(supabase, {
  skuId, changeType, quantity, referenceType, referenceId = null, operator, reason = null,
}) {
  const deltaOf = DELTA[changeType];
  if (!deltaOf) throw new AppError(500, "internal_error");
  const before = await readStock(supabase, skuId);
  if (!before) return { ok: false, reason: "not_found" };
  const d = deltaOf(quantity);
  const after = { available: before.available + d.available, frozen: before.frozen + d.frozen, sold: before.sold + d.sold };
  if (after.available < 0 || after.frozen < 0 || after.sold < 0) return { ok: false, reason: "insufficient" };
  const now = nowIso();
  const { data: cas } = await supabase.from("product_skus")
    .update({ available_stock: after.available, frozen_stock: after.frozen, sold_count: after.sold, updated_at: now })
    .eq("id", skuId).eq("available_stock", before.available).eq("frozen_stock", before.frozen).eq("sold_count", before.sold)
    .select("id");
  if (!cas?.length) return { ok: false, reason: "conflict" };
  const logged = await writeStockLog(supabase, {
    skuId, changeType, quantity, before, after, referenceType, referenceId, operator, reason,
  });
  if (!logged) {
    // 流水写失败 → 回滚本次 CAS（方案 §19 原则 4）
    await supabase.from("product_skus")
      .update({ available_stock: before.available, frozen_stock: before.frozen, sold_count: before.sold, updated_at: nowIso() })
      .eq("id", skuId).eq("available_stock", after.available).eq("frozen_stock", after.frozen).eq("sold_count", after.sold);
    return { ok: false, reason: "log_failed" };
  }
  return { ok: true, before, after };
}
