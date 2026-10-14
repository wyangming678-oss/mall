// A10 邀请海报生成：纯前端 canvas 绘制，二维码由 qrcode 本地编码（无后端、无迁移）
// 口径：分享图含站名/主色皮肤、邀请钩子、大字号邀请码、编码注册链接的二维码、邀请人署名；
//       直角无阴影、绿色品牌主色、高对比，预览与操作按钮同屏可见（不产生整页滚动）。
import { useCallback, useEffect, useRef, useState } from "react";
import { toDataURL } from "qrcode";
import { useSite } from "../site";
import { Button } from "@/components/ui/button";

export interface InvitePosterProps {
  open: boolean;
  onClose: () => void;
  siteName: string;
  primary: string;
  textColor: string;
  background: string;
  code: string;
  link: string;
  inviterName: string;
  hook: string;
}

const W = 760;
const H = 1040;
const PAD = 48;
const F_SANS = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif';
const F_MONO = 'ui-monospace,"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace';

function rgba(hex: string, a: number): string {
  let h = (hex || "#000000").trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = Number.parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return `rgba(17,17,17,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function fitFont(ctx: CanvasRenderingContext2D, text: string, maxW: number, weight: string, family: string, start: number, min: number): number {
  let size = start;
  for (; size > min; size -= 2) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  return size;
}

/** 逐字换行（适配中文，无空格分词），超出 maxLines 以省略号收尾 */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, weight: string, size: number, family: string, maxLines: number): string[] {
  ctx.font = `${weight} ${size}px ${family}`;
  const chars = Array.from(text);
  const lines: string[] = [];
  let cur = "";
  for (const ch of chars) {
    if (ctx.measureText(cur + ch).width > maxW && cur) {
      if (lines.length === maxLines - 1) {
        // 末行：溢出则截断并加省略号
        let tail = cur;
        while (tail && ctx.measureText(tail + "…").width > maxW) tail = tail.slice(0, -1);
        lines.push(tail + (tail.length < cur.length ? "…" : ""));
        return lines;
      }
      lines.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number, weight: string, size: number, family: string): string {
  ctx.font = `${weight} ${size}px ${family}`;
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

type PosterTexts = {
  t: (key: string, fallback?: string) => string;
  tf: (key: string, vars: Record<string, string | number>, fallback?: string) => string;
};

function drawPoster(ctx: CanvasRenderingContext2D, p: InvitePosterProps & { qr: HTMLImageElement | null } & PosterTexts) {
  const ink = p.textColor || "#141414";
  const brand = p.primary || "#2ECC71";
  const muted = rgba(ink, 0.62);
  const hair = rgba(ink, 0.16);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = p.background || "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // 顶部主色横幅
  ctx.fillStyle = brand;
  ctx.fillRect(0, 0, W, 168);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const title = p.siteName?.trim() || p.t("poster.title_default", "邀请好友");
  const ts = fitFont(ctx, title, W - PAD * 2, "700", F_SANS, 46, 26);
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${ts}px ${F_SANS}`;
  ctx.fillText(title, W / 2, 84);
  ctx.font = `500 22px ${F_SANS}`;
  ctx.fillStyle = rgba("#ffffff", 0.92);
  ctx.fillText(p.t("poster.subtitle", "扫码注册 · 下单同享邀请奖励"), W / 2, 126);

  // 钩子文案（最多两行）
  let y = 236;
  ctx.fillStyle = ink;
  const hook = (p.hook || p.t("me.poster_hook", "邀请好友注册并下单，你和好友都能拿奖励")).trim();
  const hookLines = wrapLines(ctx, hook, W - PAD * 2, "600", 32, F_SANS, 2);
  for (const line of hookLines) {
    ctx.font = `600 32px ${F_SANS}`;
    ctx.fillText(line, W / 2, y);
    y += 46;
  }

  // 二维码（白底 + 发丝边框）
  const box = 320;
  const bx = (W - box) / 2;
  const by = 340;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(bx, by, box, box);
  ctx.strokeStyle = hair;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx + 0.5, by + 0.5, box - 1, box - 1);
  if (p.qr) {
    ctx.drawImage(p.qr, bx + 8, by + 8, box - 16, box - 16);
  } else {
    ctx.fillStyle = muted;
    ctx.font = `500 20px ${F_SANS}`;
    ctx.fillText(p.t("poster.qr_failed", "二维码生成失败"), W / 2, by + box / 2);
  }

  // 邀请码
  ctx.fillStyle = muted;
  ctx.font = `500 22px ${F_SANS}`;
  ctx.fillText(p.t("me.invite_code", "邀请码"), W / 2, by + box + 52);
  const code = (p.code || "").trim() || "——";
  const cs = fitFont(ctx, code, W - PAD * 2, "700", F_MONO, 48, 24);
  ctx.fillStyle = brand;
  ctx.font = `700 ${cs}px ${F_MONO}`;
  ctx.fillText(code, W / 2, by + box + 104);

  // 注册链接
  ctx.fillStyle = muted;
  const linkText = truncate(ctx, p.link || "", W - PAD * 2, "400", 20, F_MONO);
  ctx.font = `400 20px ${F_MONO}`;
  ctx.fillText(p.tf("poster.link_hint", { link: linkText }, "长按识别或访问 {link}"), W / 2, by + box + 148);

  // 分割线 + 署名
  ctx.strokeStyle = hair;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, 918);
  ctx.lineTo(W - PAD, 918);
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.font = `500 24px ${F_SANS}`;
  const signer = (p.inviterName || "").trim();
  ctx.fillText(signer ? p.tf("poster.signer", { name: signer }, "来自「{name}」的邀请") : p.t("poster.signer_default", "好友诚意推荐"), W / 2, 962);

  // 底部主色条
  ctx.fillStyle = brand;
  ctx.fillRect(0, H - 28, W, 28);
}

export function InvitePoster(props: InvitePosterProps) {
  const { open, onClose, link, code } = props;
  const { t, tf } = useSite();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    let cancelled = false;
    let qr: HTMLImageElement | null = null;
    if (link) {
      void (async () => {
        try {
          const url = await toDataURL(link, {
            margin: 1, width: 640, errorCorrectionLevel: "M",
            color: { dark: props.textColor || "#141414", light: "#ffffffff" },
          });
          if (cancelled) return;
          qr = new Image();
          await new Promise<void>((res, rej) => { qr!.onload = () => res(); qr!.onerror = () => rej(); qr!.src = url; });
          if (cancelled) return;
          drawPoster(ctx, { ...props, qr, t, tf });
        } catch {
          if (!cancelled) drawPoster(ctx, { ...props, qr: null, t, tf });
        }
      })();
    } else {
      drawPoster(ctx, { ...props, qr: null, t, tf });
    }
    return () => { cancelled = true; };
  }, [open, code, link, props.siteName, props.primary, props.textColor, props.background, props.inviterName, props.hook, t, tf]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(props.siteName || "invite").replace(/[\\/:*?"<>|]/g, "")}-${t("poster.file_name", "邀请海报")}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  }, [props.siteName, t]);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(t("poster.copied_link", "已复制邀请链接"));
    } catch {
      setCopied(t("poster.copy_blocked", "浏览器不允许自动复制，请长按二维码或手动输入链接"));
    }
    setTimeout(() => setCopied(""), 2500);
  }, [link, t]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 p-4" onClick={onClose}>
      <div className="flex max-h-full flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          className="max-h-[74vh] w-auto border border-black/10 bg-white object-contain"
          aria-label={tf("poster.preview_aria", { name: props.siteName }, "{name} 邀请海报预览")}
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" onClick={download}>{t("poster.download", "下载海报图片")}</Button>
          <Button size="sm" variant="outline" onClick={() => void copyLink()}>{t("me.copy_link", "复制邀请链接")}</Button>
          <Button size="sm" variant="ghost" onClick={onClose}>{t("common.close", "关闭")}</Button>
        </div>
        {copied && <p className="text-xs text-white/90">{copied}</p>}
        <p className="max-w-md text-center text-[11px] leading-relaxed text-white/70">
          {t("poster.local_note", "海报在你的浏览器本地生成（含可扫描的注册二维码），不上传任何数据；下载后可直接分享给好友。")}
        </p>
      </div>
    </div>
  );
}
