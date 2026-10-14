// 商品图标扩散动效层：首页顶栏（横向）与登录/注册背景（纵向/放射）共用同一套类目图标和 icon-diffuse 关键帧
import { type CSSProperties } from "react";

/** 通用商品类目图标（描边风格，24 视口） */
const GLYPHS = [
  "M6 8h12l1 12H5L6 8Z M9 8a3 3 0 0 1 6 0", // 购物袋
  "M8 4h2a2 2 0 0 0 4 0h2l4 4-3 2-1-1v11H8V11l-1 1-3-2 4-4Z", // 上衣
  "M4 15v-3a8 8 0 0 1 16 0v3 M4 15a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2Z M20 15a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2Z", // 耳机
  "M7 2h10v20H7Z M11 19h2", // 手机
  "M9 7h6v10H9Z M10 7V3h4v4 M10 17v4h4v-4 M12 11v2l1.5 1.5", // 手表
  "M3 8h4l2-2h6l2 2h4v12H3Z M12 11a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z", // 相机
  "M4 10h16v11H4Z M3 7h18v3H3Z M12 7v14 M8.5 7A2.5 2.5 0 1 1 12 4.5 2.5 2.5 0 1 1 15.5 7", // 礼盒
  "M5 8h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4Z M16 10h1.5a2.5 2.5 0 0 1 0 5H16 M4 21h13", // 杯子
  "M7 9a5 5 0 0 1 10 0v11H7Z M9 9V6a3 3 0 0 1 6 0v3 M9 20v-5h6v5", // 背包
  "M6 4h5v16H6Z M13 4h5v16h-5Z M11 8h2", // 书本
];

export type DiffuseAxis = "x" | "y" | "radial";

function cell(i: number, n: number, axis: DiffuseAxis) {
  const p = n > 1 ? i / (n - 1) : 0.5;
  const wave = Math.sin(p * Math.PI * 3);
  let left = 50;
  let top = 50;
  let dx = 0;
  let dy = 0;
  if (axis === "x") {
    // 沿横向铺开：越靠两端向外位移越大，纵向只做轻微扇形散开
    left = 3 + p * 94;
    top = 50 + Math.sin(p * Math.PI * 5) * 26;
    dx = Math.round(((left - 50) / 50) * 120);
    dy = Math.round(wave * 12);
  } else if (axis === "y") {
    // 沿纵向铺开（窄高面板）：越靠上下两端越向外，横向只做轻微扇形
    top = 4 + p * 92;
    left = 50 + Math.sin(p * Math.PI * 5) * 34;
    dx = Math.round(wave * 20);
    dy = Math.round(((top - 50) / 50) * 110);
  } else {
    // 由中心向四周放射（整页背景）
    const ang = (i / n) * Math.PI * 2 + (i % 2 ? 0.32 : -0.32);
    const rx = 30 + (i % 4) * 6;
    const ry = 26 + (i % 3) * 9;
    left = 50 + Math.cos(ang) * rx;
    top = 50 + Math.sin(ang) * ry;
    dx = Math.round(Math.cos(ang) * 120);
    dy = Math.round(Math.sin(ang) * 85);
  }
  const dur = 9 + (i % 5) * 1.8;
  return {
    d: GLYPHS[i % GLYPHS.length],
    left,
    top,
    dx,
    dy,
    dur,
    // 负延迟让首屏直接落在动画中段，不必空等一轮
    delay: -((((i * 2.7) % 13) / 13) * dur),
    size: i % 3 === 0 ? 22 : i % 3 === 1 ? 17 : 13,
  };
}

export function DiffuseField({
  count = 14,
  axis = "x",
  tone = "brand",
  className = "",
}: {
  count?: number;
  axis?: DiffuseAxis;
  tone?: "brand" | "light";
  className?: string;
}) {
  const light = tone === "light";
  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => {
        const c = cell(i, count, axis);
        return (
          <span
            key={i}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${c.left}%`, top: `${c.top}%` }}
          >
            <span
              className="hero-band__icon"
              style={
                {
                  "--dx": `${c.dx}px`,
                  "--dy": `${c.dy}px`,
                  "--diffuse-dur": `${c.dur}s`,
                  "--diffuse-delay": `${c.delay}s`,
                  "--diffuse-alpha": light ? (i % 3 === 0 ? 0.28 : 0.18) : i % 3 === 0 ? 0.34 : 0.24,
                } as CSSProperties
              }
            >
              <svg
                width={c.size}
                height={c.size}
                viewBox="0 0 24 24"
                fill="none"
                stroke={light ? (i % 2 ? "rgba(255,255,255,.85)" : "rgba(255,255,255,.6)") : i % 2 ? "var(--secondary)" : "var(--primary)"}
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={c.d} />
              </svg>
            </span>
          </span>
        );
      })}
    </div>
  );
}
