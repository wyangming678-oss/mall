// 幂等六步（文档A §34 使用契约 / 文档B §0.1 / 文档C §〇.4）
import { AppError, isUniqueViolation } from "./errors.mjs";
import { sha256Hex } from "./crypto.mjs";
import { stableStringify, nowIso } from "./validate.mjs";

const STALE_TAKEOVER_MS = 60000;

function replay(response) {
  return Response.json(response.body, { status: response.status, headers: { "cache-control": "no-store" } });
}

export async function runIdempotent(supabase, { key, principalType, principalId, action, body }, execute) {
  if (!key || typeof key !== "string" || key.length < 8) {
    throw new AppError(400, "missing_idempotency_key", "该操作必须携带 Idempotency-Key");
  }
  const fingerprint = await sha256Hex(stableStringify(body ?? {}));
  const row = {
    id: crypto.randomUUID(),
    idem_key: key,
    principal_type: principalType,
    principal_id: principalId,
    action,
    request_fingerprint: fingerprint,
    state: "in_progress",
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const inserted = await supabase.from("idempotency_keys").insert(row).select("id").maybeSingle();
  if (inserted.error) {
    if (!isUniqueViolation(inserted.error)) throw new AppError(500, "internal_error");
    const { data: existing } = await supabase.from("idempotency_keys")
      .select("id,state,request_fingerprint,result,updated_at").eq("idem_key", key).maybeSingle();
    if (!existing) throw new AppError(409, "idempotency_in_progress");
    if (existing.request_fingerprint !== fingerprint) throw new AppError(409, "idempotency_mismatch", "同键不同请求内容");
    if (existing.state === "completed") {
      if (!existing.result) throw new AppError(409, "idempotency_mismatch");
      return replay(existing.result);
    }
    const cutoff = new Date(Date.now() - STALE_TAKEOVER_MS).toISOString();
    const takeover = await supabase.from("idempotency_keys")
      .update({ updated_at: nowIso() })
      .eq("id", existing.id).eq("state", "in_progress").lt("updated_at", cutoff)
      .select("id");
    if ((takeover.data?.length ?? 0) !== 1) throw new AppError(409, "idempotency_in_progress", "请求正在处理中");
  }

  const keyRow = inserted.data ? inserted.data.id : null;
  const finalize = async (response) => {
    const now = nowIso();
    if (keyRow) {
      await supabase.from("idempotency_keys")
        .update({ state: "completed", result: { status: response.status, body: response.body }, updated_at: now })
        .eq("id", keyRow);
    } else {
      await supabase.from("idempotency_keys")
        .update({ state: "completed", result: { status: response.status, body: response.body }, updated_at: now })
        .eq("idem_key", key);
    }
  };

  try {
    const result = await execute();
    const response = result instanceof Response
      ? { status: result.status, body: await result.json() }
      : { status: 200, body: { ok: true, data: result } };
    await finalize(response);
    return replay(response);
  } catch (error) {
    if (error instanceof AppError) {
      const response = {
        status: error.status,
        body: { ok: false, error: { code: error.code, message: error.message, details: error.details } },
      };
      await finalize(response);
      return replay(response);
    }
    // 未知结果：保持 in_progress，不自动重放写操作（文档B §0.1 ⑤）
    throw error;
  }
}
