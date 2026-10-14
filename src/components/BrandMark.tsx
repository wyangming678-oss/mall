// 品牌资源：storage key → 签名 URL 的模块级缓存（同帧合并成一次 F2b 批量请求）+ 品牌标记组件 + favicon 同步
import { useEffect, useState } from "react";
import { call, tokenStore } from "../api";
import { useSite } from "../site";

/** 内置默认 Logo（public/brand/logo.png）；后台装修上传的 Logo 优先于此 */
export const DEFAULT_BRAND_LOGO = "/brand/logo.png";

// 签名地址是短时效的：F2/F2b 会返回 expires_in，缓存必须比它先过期，否则重挂组件会拿到失效地址。
type CachedUrl = { promise: Promise<string | null>; expiresAt: number };
const urlCache = new Map<string, CachedUrl>();
const REFRESH_MARGIN_MS = 60_000;

// —— F2b 批量取址（#350）：图片地址原先一图一个 GET，一屏 25–45 请求里近半是取址。
// 现在同一渲染帧内未命中的键合并成一次 POST（后端上限 20 键/批），20 张图 = 1 个请求。 ——
const MAX_BATCH_KEYS = 20;
const COALESCE_MS = 16;
// 与后端 PUBLIC_URL_PREFIXES 同表：这三类公开内容匿名可取，其余前缀必须带主体令牌。
const PUBLIC_PREFIXES = ["brand", "products", "announcements"];

type TokenKind = "user" | "admin" | "chat";

// 非公开前缀在无任何登录态时必定 401 ⇒ 直接判定取不到，连请求都不发（既省配额，也不会把整批拖成 401）
function bearerForNonPublic(): TokenKind | null {
  if (tokenStore.user.get()) return "user";
  if (tokenStore.admin.get()) return "admin";
  if (tokenStore.guest.get()) return "chat";
  return null;
}

type Waiting = { key: string; resolve: (url: string | null) => void };
const queue = new Map<TokenKind | "", Waiting[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushQueued() {
  flushTimer = null;
  const buckets = [...queue.entries()];
  queue.clear();
  for (const [bucket, waiting] of buckets) {
    const token: TokenKind | null = bucket === "" ? null : (bucket as TokenKind);
    const seen = new Set<string>();
    const uniq = waiting.filter((w) => (seen.has(w.key) ? false : (seen.add(w.key), true)));
    for (let i = 0; i < uniq.length; i += MAX_BATCH_KEYS) {
      const chunk = uniq.slice(i, i + MAX_BATCH_KEYS);
      try {
        const data = await call<{ items: { key: string; url: string }[]; expires_in?: number }>(
          "file/url/batch", { method: "POST", token, body: { keys: chunk.map((w) => w.key) } });
        const byKey = new Map(data.items.map((row) => [row.key, row.url]));
        const ttl = Math.max(120, data.expires_in ?? 300);
        const expiresAt = Date.now() + ttl * 1000 - REFRESH_MARGIN_MS;
        for (const w of chunk) {
          const url = byKey.get(w.key) ?? null;
          // 后端逐键降级的那些（对象已删/悬空键）不缓存，下次挂载重试；其余按 expires_in 缓存
          if (url) urlCache.set(w.key, { promise: Promise.resolve(url), expiresAt });
          else urlCache.delete(w.key);
          w.resolve(url);
        }
      } catch {
        for (const w of chunk) {
          urlCache.delete(w.key); // 整批失败不缓存，下次重试
          w.resolve(null);
        }
      }
    }
  }
}

export function resolveAssetUrl(key: string): Promise<string | null> {
  const hit = urlCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.promise;
  const bucket: TokenKind | "" | null = PUBLIC_PREFIXES.includes(key.split("/")[0]) ? "" : bearerForNonPublic();
  if (bucket === null) return Promise.resolve(null);
  // 未解析完先占位（expiresAt 设为极大），同键的并发调用共用同一批请求，不重复排队
  const promise = new Promise<string | null>((resolve) => {
    queue.set(bucket, [...(queue.get(bucket) ?? []), { key, resolve }]);
    if (!flushTimer) flushTimer = setTimeout(flushQueued, COALESCE_MS);
  });
  urlCache.set(key, { promise, expiresAt: Number.MAX_SAFE_INTEGER });
  return promise;
}

export function useAssetUrl(key: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!key) {
      setUrl(null);
      return;
    }
    let alive = true;
    void resolveAssetUrl(key).then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [key]);
  return url;
}

/** 品牌 Logo 地址：装修上传 > 内置默认图 */
export function useBrandLogoUrl(logoKey?: string | null): string {
  return useAssetUrl(logoKey) ?? DEFAULT_BRAND_LOGO;
}

/** 品牌标记：默认用内置 Logo，后台上传后自动替换；图片加载失败时回退渐变首字母 */
export function BrandMark({ logoKey, siteName, size = "md", plain = false }: {
  logoKey?: string | null; siteName: string; size?: "sm" | "md" | "lg"; plain?: boolean;
}) {
  const url = useBrandLogoUrl(logoKey);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const box = { sm: "size-7 rounded-lg", md: "size-9 rounded-xl", lg: "size-12 rounded-2xl" }[size];
  const fontSize = { sm: "text-sm", md: "text-xl", lg: "text-2xl" }[size];
  if (!broken) {
    return (
      <img
        src={url}
        alt=""
        onError={() => setBroken(true)}
        className={`${box} bg-white object-contain p-0.5 shadow-sm ring-1 ring-black/5`}
      />
    );
  }
  return (
    <span className={`grid ${box} place-items-center font-black shadow-sm ${plain ? "bg-white/95 text-primary" : "brand-gradient text-white shadow-primary/40"}`}>
      <span className={fontSize}>{siteName.charAt(0)}</span>
    </span>
  );
}

/** favicon：优先 favicon_key，其次 logo_key，最后内置默认 Logo，写回 <link rel="icon"> */
export function FaviconSync() {
  const { config } = useSite();
  const key = config?.brand?.favicon_key ?? config?.brand?.logo_key ?? null;
  const uploaded = useAssetUrl(key);
  const href = uploaded ?? DEFAULT_BRAND_LOGO;
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = href;
  }, [href]);
  return null;
}
