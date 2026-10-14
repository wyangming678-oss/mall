// 收货地址字段组（AD1 / OD6 共用）：与服务端校验同口径
import type { ChangeEvent } from "react";
import type { AddressRow } from "../trade";
import { useSite } from "../site";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type AddressDraft = Record<keyof Omit<AddressRow, "id" | "is_default" | "created_at" | "updated_at">, string>;

type Translator = (key: string, fallback?: string) => string;

// zh 数据默认值：买家端调用处一律传 t("af.country_default", …)，仅未传参的旧调用（后台）落到此值
const DEFAULT_COUNTRY = "中国"; /* i18n-fallback */

export const toDraft = (a?: Partial<AddressRow> | null, defaultCountry: string = DEFAULT_COUNTRY): AddressDraft => ({
  receiver_name: a?.receiver_name ?? "",
  phone: a?.phone ?? "",
  country: a?.country || defaultCountry,
  province: a?.province ?? "",
  city: a?.city ?? "",
  district: a?.district ?? "",
  detail: a?.detail ?? "",
  postal_code: a?.postal_code ?? "",
});

export function addressDraftError(d: AddressDraft, t: Translator = (_k, fb) => fb ?? ""): string | null {
  if (!d.receiver_name.trim()) return t("af.err_name", "请填写收货人");
  if (!/^[0-9+-]{5,20}$/.test(d.phone.trim())) return t("af.err_phone", "手机号只能包含数字、+、-，长度 5–20");
  if (!d.country.trim() || !d.province.trim() || !d.city.trim()) return t("af.err_region", "国家 / 省 / 市为必填");
  if (d.detail.trim().length < 2) return t("af.err_detail", "详细地址至少 2 个字");
  return null;
}

const CELL = "flex flex-col gap-1";

export function AddressFields({ value, onChange }: { value: AddressDraft; onChange: (patch: Partial<AddressDraft>) => void }) {
  const { t } = useSite();
  const set = (k: keyof AddressDraft) => (e: ChangeEvent<HTMLInputElement>) => onChange({ [k]: e.target.value } as Partial<AddressDraft>);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className={CELL}>
        <Label htmlFor="af-name">{t("af.recipient", "收货人")} *</Label>
        <Input id="af-name" maxLength={30} value={value.receiver_name} onChange={set("receiver_name")} />
      </div>
      <div className={CELL}>
        <Label htmlFor="af-phone">{t("af.phone", "联系电话")} *</Label>
        <Input id="af-phone" maxLength={20} value={value.phone} onChange={set("phone")} placeholder="13800000000" />
      </div>
      <div className={CELL}>
        <Label htmlFor="af-country">{t("af.country", "国家 / 地区")} *</Label>
        <Input id="af-country" maxLength={40} value={value.country} onChange={set("country")} />
      </div>
      <div className={CELL}>
        <Label htmlFor="af-province">{t("af.province", "省 / 州")} *</Label>
        <Input id="af-province" maxLength={40} value={value.province} onChange={set("province")} />
      </div>
      <div className={CELL}>
        <Label htmlFor="af-city">{t("af.city", "城市")} *</Label>
        <Input id="af-city" maxLength={40} value={value.city} onChange={set("city")} />
      </div>
      <div className={CELL}>
        <Label htmlFor="af-district">{t("af.district", "区 / 县")}</Label>
        <Input id="af-district" maxLength={40} value={value.district} onChange={set("district")} />
      </div>
      <div className={CELL + " sm:col-span-2"}>
        <Label htmlFor="af-detail">{t("af.detail", "详细地址")} *</Label>
        <Input id="af-detail" maxLength={200} value={value.detail} onChange={set("detail")} placeholder={t("af.detail_ph", "街道、门牌号、楼层")} />
      </div>
      <div className={CELL}>
        <Label htmlFor="af-postal">{t("af.postal", "邮编")}</Label>
        <Input id="af-postal" maxLength={12} value={value.postal_code} onChange={set("postal_code")} />
      </div>
    </div>
  );
}

export const oneLine = (a: AddressRow | null | undefined): string => (
  a ? `${a.receiver_name} ${a.phone} · ${a.country}${a.province}${a.city}${a.district ?? ""}${a.detail}` : ""
);
