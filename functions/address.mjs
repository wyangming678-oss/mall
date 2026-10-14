// 收货地址 AD1（文档C §二；软删 + is_default 唯一性由函数维护）
import { AppError } from "./errors.mjs";
import { vStr, vBool, vUuid, nowIso } from "./validate.mjs";

const COLS = "id,receiver_name,phone,country,province,city,district,detail,postal_code,is_default,created_at,updated_at";

function validateAddress(body) {
  return {
    receiver_name: vStr(body.receiver_name, "receiver_name", { min: 1, max: 30 }),
    phone: vStr(body.phone, "phone", { min: 5, max: 20, pattern: /^[0-9+-]+$/ }),
    country: vStr(body.country, "country", { min: 1, max: 40 }),
    province: vStr(body.province, "province", { min: 1, max: 40 }),
    city: vStr(body.city, "city", { min: 1, max: 40 }),
    district: body.district ? vStr(body.district, "district", { max: 40 }) : null,
    detail: vStr(body.detail, "detail", { min: 2, max: 200 }),
    postal_code: body.postal_code ? vStr(body.postal_code, "postal_code", { max: 12 }) : null,
    is_default: vBool(body.is_default ?? false, "is_default"),
  };
}

export async function addressList(supabase, principal) {
  const { data, error } = await supabase.from("addresses")
    .select(COLS).eq("user_id", principal.id).is("deleted_at", null)
    .order("is_default", { ascending: false });
  if (error) throw new AppError(500, "internal_error");
  return { items: data ?? [] };
}

export async function addressSave(supabase, principal, body) {
  const values = validateAddress(body);
  const id = body.address_id ? vUuid(body.address_id, "address_id") : null;
  const now = nowIso();
  if (values.is_default) {
    await supabase.from("addresses").update({ is_default: false, updated_at: now })
      .eq("user_id", principal.id).is("deleted_at", null).eq("is_default", true);
  }
  if (id) {
    const { data: existing } = await supabase.from("addresses")
      .select("id").eq("id", id).eq("user_id", principal.id).is("deleted_at", null).maybeSingle();
    if (!existing) throw new AppError(404, "not_found", "地址不存在");
    const { error } = await supabase.from("addresses")
      .update({ ...values, updated_at: now }).eq("id", id);
    if (error) throw new AppError(500, "internal_error");
    return { address_id: id };
  }
  const newId = crypto.randomUUID();
  const { data: first } = await supabase.from("addresses")
    .select("id").eq("user_id", principal.id).is("deleted_at", null).limit(1);
  const defaultNow = values.is_default || !(first?.length); // 首条地址自动成为默认
  const { error } = await supabase.from("addresses").insert({
    id: newId, user_id: principal.id, ...values, is_default: defaultNow, created_at: now, updated_at: now,
  });
  if (error) throw new AppError(500, "internal_error");
  return { address_id: newId };
}

export async function addressDelete(supabase, principal, body) {
  const id = vUuid(body.address_id, "address_id");
  const now = nowIso();
  const { data: existing } = await supabase.from("addresses")
    .select("id,is_default").eq("id", id).eq("user_id", principal.id).is("deleted_at", null).maybeSingle();
  if (!existing) throw new AppError(404, "not_found", "地址不存在");
  const { error } = await supabase.from("addresses")
    .update({ deleted_at: now, updated_at: now }).eq("id", id);
  if (error) throw new AppError(500, "internal_error");
  if (existing.is_default) {
    const { data: rest } = await supabase.from("addresses")
      .select("id").eq("user_id", principal.id).is("deleted_at", null).order("created_at", { ascending: false }).limit(1);
    if (rest?.length) {
      await supabase.from("addresses").update({ is_default: true, updated_at: now }).eq("id", rest[0].id);
    }
  }
  return { deleted: id };
}

// 下单用地址全量快照（文档B §2 ⑤：orders.address_snapshot）
export async function loadAddressSnapshot(supabase, userId, addressId) {
  const id = vUuid(addressId, "address_id");
  const { data } = await supabase.from("addresses")
    .select(COLS).eq("id", id).eq("user_id", userId).is("deleted_at", null).maybeSingle();
  if (!data) throw new AppError(404, "not_found", "地址不存在");
  return {
    receiver_name: data.receiver_name,
    phone: data.phone,
    country: data.country,
    province: data.province,
    city: data.city,
    district: data.district,
    detail: data.detail,
    postal_code: data.postal_code,
  };
}
