// 顶栏动态层：商品图标从中心向外扩散，随 Logo/搜索栏一起铺满；后台可上传节日背景图（site_config brand.hero_bg_key）
import { useSite } from "../site";
import { DiffuseField } from "./DiffuseField";
import { useAssetUrl } from "./BrandMark";

export function HeroBand() {
  const { config } = useSite();
  const bgUrl = useAssetUrl(config?.brand?.hero_bg_key);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {bgUrl && <img src={bgUrl} alt="" className="absolute inset-0 size-full object-cover" />}
      {bgUrl && <div className="absolute inset-0 bg-background/55" />}
      <DiffuseField count={14} axis="x" />
    </div>
  );
}
