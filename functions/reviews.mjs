// 商品评价/评分 A7（文档A 新增 product_reviews；文档C 新增 RV1/RV2 + 后台审核）
// 口径：一个用户对同一商品仅一条有效评价（UNIQUE(user_id, product_id)，再提交即覆盖更新）；
//       仅展示 status=on 且未软删的评价；verified 在提交瞬间按「买家是否有含该商品的已发货/已完成订单」定格。
import { AppError, ok } from "./errors.mjs";
import { adminGuard, writeAudit } from "./permissions.mjs";
import { nowIso, pageParams, pageResult, vEnum, vInt, vJson, vStr, vUuid, countRows } from "./validate.mjs";

const REVIEW_COLS = "id,product_id,user_id,order_id,rating,content,images,status,verified,created_at,updated_at";
const REVIEW_STATUS = ["on", "hidden"];
const SCAN_CAP = 1000; // 平均分/星级分布单次扫描上限（量大再物化到 products 冗余列）

function reviewView(r, userName) {
  return {
    review_id: r.id,
    product_id: r.product_id,
    rating: Number(r.rating),
    content: r.content ?? "",
    images: Array.isArray(r.images) ? r.images : [],
    verified: Boolean(r.verified),
    created_at: r.created_at,
    updated_at: r.updated_at,
    user_name: userName ?? "匿名用户",
  };
}

function summarize(rows) {
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const r of rows) {
    const n = Number(r.rating);
    if (n >= 1 && n <= 5) { dist[n] += 1; sum += n; }
  }
  const count = rows.length;
  return { count, avg_rating: count ? Math.round((sum / count) * 10) / 10 : 0, distribution: dist };
}

// 是否存在「含该商品且已发货/已完成」的买家订单 → verified + 关联 order_id
async function purchaseRef(supabase, productId, userId) {
  const { data: items } = await supabase.from("order_items")
    .select("order_id,product_id").eq("product_id", productId);
  const orderIds = [...new Set((items ?? []).map((i) => i.order_id))];
  if (!orderIds.length) return { verified: false, order_id: null };
  const { data: orders } = await supabase.from("orders")
    .select("id,created_at").eq("user_id", userId).in("id", orderIds).in("status_order", ["SHIPPED", "COMPLETED"])
    .order("created_at", { ascending: false });
  const hit = (orders ?? [])[0];
  return { verified: Boolean(hit), order_id: hit?.id ?? null };
}

// —— RV1 商品评价列表 + 汇总（公开；登录附带「我的评价」）——
export async function reviewList(supabase, principal, query) {
  const productId = vUuid(query.product_id, "product_id");
  const { offset, limit } = pageParams(query);

  const { data: allRatings, error: e1 } = await supabase.from("product_reviews")
    .select("rating").eq("product_id", productId).eq("status", "on").is("deleted_at", null).limit(SCAN_CAP);
  if (e1) throw new AppError(500, "internal_error");
  const summary = summarize(allRatings ?? []);

  let q = supabase.from("product_reviews").select(REVIEW_COLS)
    .eq("product_id", productId).eq("status", "on").is("deleted_at", null)
    .order("created_at", { ascending: false }).range(offset, offset + limit);
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];

  const nameMap = new Map();
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  if (userIds.length) {
    const { data: users } = await supabase.from("users").select("id,username,nickname").in("id", userIds);
    for (const u of users ?? []) nameMap.set(u.id, u.nickname || u.username);
  }

  let myReview = null;
  if (principal?.id) {
    const { data: mine } = await supabase.from("product_reviews").select(REVIEW_COLS)
      .eq("product_id", productId).eq("user_id", principal.id).is("deleted_at", null).maybeSingle();
    if (mine) myReview = reviewView(mine, nameMap.get(mine.user_id));
  }

  return ok({
    product_id: productId,
    summary,
    ...pageResult(rows.map((r) => reviewView(r, nameMap.get(r.user_id))), offset, limit),
    my_review: myReview,
  });
}

// —— RV2 提交/更新评价（登录；(user,product) 幂等覆盖）——
export async function reviewSubmit(supabase, principal, body) {
  const productId = vUuid(body.product_id, "product_id");
  const rating = vInt(body.rating, "rating", { min: 1, max: 5 });
  const content = vStr(body.content ?? "", "content", { max: 500 });
  const images = vJson(body.images ?? [], "images", { maxItems: 9 });
  if (!Array.isArray(images)) throw new AppError(400, "invalid_request", "images 必须为数组", { field: "images" });

  const { data: product } = await supabase.from("products").select("id,status").eq("id", productId).is("deleted_at", null).maybeSingle();
  if (!product || product.status !== "on") {
    throw new AppError(404, "not_found", "商品不存在或已下架", { product_id: productId });
  }

  const now = nowIso();
  const { verified, order_id } = await purchaseRef(supabase, productId, principal.id);
  const payload = {
    rating, content, images: images.map(String), verified, order_id, updated_at: now,
  };

  const { data: existing } = await supabase.from("product_reviews").select(REVIEW_COLS)
    .eq("product_id", productId).eq("user_id", principal.id).is("deleted_at", null).maybeSingle();

  // 已有则覆盖更新：响应体用本地合并对象，不依赖 UPDATE 返回（跨 harness/真实库都成立）
  if (existing) {
    const { error: ue } = await supabase.from("product_reviews")
      .update(payload).eq("id", existing.id).eq("user_id", principal.id);
    if (ue) throw new AppError(500, "internal_error");
    return ok({ review: reviewView({ ...existing, ...payload }, "我"), created: false });
  }

  const row = {
    id: crypto.randomUUID(), product_id: productId, user_id: principal.id,
    status: "on", created_at: now, ...payload,
  };
  const { error } = await supabase.from("product_reviews").insert(row).select("id").maybeSingle();
  if (error) {
    // 并发/重复提交：回读已有行并按更新处理
    const { data: after } = await supabase.from("product_reviews").select(REVIEW_COLS)
      .eq("product_id", productId).eq("user_id", principal.id).is("deleted_at", null).maybeSingle();
    if (after) {
      await supabase.from("product_reviews").update(payload).eq("id", after.id);
      return ok({ review: reviewView({ ...after, ...payload }, "我"), created: false });
    }
    throw new AppError(500, "internal_error");
  }
  return ok({ review: reviewView(row, "我"), created: true });
}

// —— 后台评价列表（perm product.manage）——
export async function adminReviews(supabase, request, query) {
  await adminGuard(supabase, request, "product.manage");
  const { offset, limit } = pageParams(query);
  let q = supabase.from("product_reviews").select(REVIEW_COLS).is("deleted_at", null)
    .order("created_at", { ascending: false }).range(offset, offset + limit);
  if (query.status) q = q.eq("status", vEnum(query.status, "status", REVIEW_STATUS));
  if (query.product_id) q = q.eq("product_id", vUuid(query.product_id, "product_id"));
  const { data, error } = await q;
  if (error) throw new AppError(500, "internal_error");
  const rows = data ?? [];

  const nameMap = new Map();
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  if (userIds.length) {
    const { data: users } = await supabase.from("users").select("id,username,nickname").in("id", userIds);
    for (const u of users ?? []) nameMap.set(u.id, `${u.username}${u.nickname ? `（${u.nickname}）` : ""}`);
  }
  const titleMap = new Map();
  const productIds = [...new Set(rows.map((r) => r.product_id))];
  if (productIds.length) {
    const { data: products } = await supabase.from("products").select("id,title").in("id", productIds);
    for (const p of products ?? []) titleMap.set(p.id, p.title);
  }

  const total = await countRows(supabase.from("product_reviews").select("id", { count: "exact" }).is("deleted_at", null));
  return ok({
    total,
    ...pageResult(rows.map((r) => ({
      ...reviewView(r, nameMap.get(r.user_id)),
      user_id: r.user_id,
      status: r.status,
      product_title: titleMap.get(r.product_id) ?? "（商品已删除）",
      order_id: r.order_id ?? null,
    })), offset, limit),
  });
}

// —— 后台评价状态（隐藏/恢复）——
export async function adminReviewStatus(supabase, request, body) {
  const { actor } = await adminGuard(supabase, request, "product.manage");
  const id = vUuid(body.review_id, "review_id");
  const status = vEnum(body.status, "status", REVIEW_STATUS);
  const { data } = await supabase.from("product_reviews").select(REVIEW_COLS).eq("id", id).is("deleted_at", null).maybeSingle();
  if (!data) throw new AppError(404, "not_found", "评价不存在", { review_id: id });
  const { data: updated } = await supabase.from("product_reviews")
    .update({ status, updated_at: nowIso() }).eq("id", id).eq("user_id", data.user_id).select(REVIEW_COLS).maybeSingle();
  await writeAudit(supabase, {
    adminId: actor.id, action: "review.status", targetType: "product_review", targetId: id,
    detail: { from: data.status, to: status },
  });
  return ok({ review_id: id, status: updated?.status ?? status });
}
