// 独立地址簿 AD1（文档C §二）：列表 / 新增 / 编辑 / 删除 / 设为默认
// 后端 address/list|save|delete 已在结算页复用，这里给「我的」一个不依赖下单流程的独立入口。
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { call, newIdem } from "../api";
import { RedirectTo } from "../router";
import { useSite } from "../site";
import { AddressFields, addressDraftError, toDraft, type AddressDraft } from "../components/AddressFields";
import { CartLoading } from "../components/CartLoading";
import { SubHeader } from "../components/SubHeader";
import { shopErr, type AddressRow } from "../trade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const MAX_ADDRESSES = 20;

function AddressForm({ initial, editingId, asDefault, onDone, onCancel }: {
  initial: AddressRow | null;
  editingId: string | null;
  asDefault: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useSite();
  const [draft, setDraft] = useState<AddressDraft>(toDraft(initial, t("af.country_default", "中国")));
  const [def, setDef] = useState(asDefault);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const invalid = addressDraftError(draft, t);
    if (invalid) { setError(invalid); return; }
    setBusy(true);
    setError("");
    try {
      await call("address/save", {
        method: "POST", token: "user", idem: newIdem(),
        body: {
          ...(editingId ? { address_id: editingId } : {}),
          ...draft,
          district: draft.district || undefined,
          postal_code: draft.postal_code || undefined,
          is_default: def,
        },
      });
      onDone();
    } catch (err) {
      setError(shopErr(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3 border-y border-border/70 py-4" onSubmit={submit}>
      <p className="text-sm font-medium">{editingId ? t("addr.edit_title", "编辑收货地址") : t("checkout.address_add", "新增收货地址")}</p>
      <AddressFields value={draft} onChange={(patch) => { setDraft((d) => ({ ...d, ...patch })); setError(""); }} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={def} onChange={(e) => setDef(e.target.checked)} />
        {t("checkout.address_default_set", "设为默认地址")}
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>{busy ? t("checkout.address_saving", "保存中…") : t("checkout.address_save", "保存地址")}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>{t("common.cancel", "取消")}</Button>
      </div>
    </form>
  );
}

export function AddressesPage() {
  const { user, ready, t, tf } = useSite();
  const [items, setItems] = useState<AddressRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [editRow, setEditRow] = useState<AddressRow | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await call<{ items: AddressRow[] }>("address/list", { token: "user" });
      setItems(r.items);
      setError("");
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  if (!ready) return <div className="grid place-items-center py-16"><CartLoading label={t("addr.loading", "正在加载地址…")} /></div>;
  if (!user) return <RedirectTo to="/login" />;

  function startAdd() {
    setEditing(true); setEditRow(null); setEditId(null);
  }
  function startEdit(a: AddressRow) {
    setEditing(true); setEditRow(a); setEditId(a.id);
  }
  async function setDefault(a: AddressRow) {
    setBusy(a.id); setError("");
    try {
      await call("address/save", {
        method: "POST", token: "user", idem: newIdem(),
        body: {
          address_id: a.id,
          receiver_name: a.receiver_name, phone: a.phone, country: a.country,
          province: a.province, city: a.city, district: a.district || undefined,
          detail: a.detail, postal_code: a.postal_code || undefined,
          is_default: true,
        },
      });
      await load();
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setBusy("");
    }
  }
  async function remove(a: AddressRow) {
    if (!window.confirm(tf("addr.delete_confirm", { name: a.receiver_name, phone: a.phone }, "删除收货地址「{name} {phone}」？"))) return;
    setBusy(a.id); setError("");
    try {
      await call("address/delete", { method: "POST", token: "user", idem: newIdem(), body: { address_id: a.id } });
      await load();
    } catch (e) {
      setError(shopErr(e));
    } finally {
      setBusy("");
    }
  }

  const list = items ?? [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
      <SubHeader
        title={t("checkout.address", "收货地址")}
        extra={!editing && (
          <Button size="sm" disabled={list.length >= MAX_ADDRESSES} onClick={startAdd}>
            {list.length >= MAX_ADDRESSES ? tf("addr.limit_max", { n: MAX_ADDRESSES }, "已达上限 {n} 条") : t("addr.add", "新增地址")}
          </Button>
        )}
      />

      {error && <p className="border-y border-border/70 px-1 py-3 text-sm text-destructive">{error}</p>}

      {loading && !items && <div className="grid place-items-center py-14"><CartLoading label={t("addr.loading", "正在加载地址…")} /></div>}

      {editing && (
        <AddressForm
          initial={editRow}
          editingId={editId}
          asDefault={list.length === 0}
          onDone={() => { setEditing(false); void load(); }}
          onCancel={() => setEditing(false)}
        />
      )}

      {!loading && items && list.length === 0 && !editing && (
        <div className="flex flex-col items-center gap-2 border-y border-border/70 py-12 text-center">
          <p className="text-sm text-muted-foreground">{t("addr.empty", "还没有收货地址")}</p>
          <p className="max-w-md text-xs text-muted-foreground">{t("addr.empty_hint", "添加常用地址后，下单结算可直接选用，也能在这里随时修改默认地址。")}</p>
        </div>
      )}

      {list.length > 0 && !editing && (
        <section className="border-t border-border/70">
          {list.map((a) => (
            <div key={a.id} className="flex flex-col gap-2 border-b border-border/70 px-1 py-3 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{a.receiver_name}</span>
                <span className="text-sm text-muted-foreground">{a.phone}</span>
                {a.is_default && <Badge variant="default">{t("checkout.address_default_tag", "默认")}</Badge>}
              </div>
              <p className="text-sm leading-6 text-muted-foreground">
                {a.country}{a.province}{a.city}{a.district ?? ""}{a.detail}
                {a.postal_code ? tf("common.paren", { v: a.postal_code }, "（{v}）") : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy === a.id} onClick={() => startEdit(a)}>{t("common.edit", "编辑")}</Button>
                {!a.is_default && (
                  <Button size="sm" variant="ghost" disabled={busy === a.id} onClick={() => void setDefault(a)}>{t("addr.set_default", "设为默认")}</Button>
                )}
                <Button size="sm" variant="ghost" className="text-destructive" disabled={busy === a.id} onClick={() => void remove(a)}>{t("common.delete", "删除")}</Button>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
