// 人机验证题面：6 位随机数字 + 无依赖 SVG 渲染。出题端与本地 stub 共用本文件，保证两者形态一致。
// 题面是纯数字，不含任何文字 ⇒ 与界面语言无关（不再按 lang 出题），学历/语言都不是门槛。
// 数字串本身即答案，按字符串存储（保留前导零）；答案明文永不出接口（除非 exposeAnswerForTest）。

const DIGIT_COUNT = 6;
const ri = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

// 全同（000000）既没有辨识价值又像坏数据，重摇到至少两位不同为止
export function generateDigits() {
  let digits;
  do {
    digits = Array.from({ length: DIGIT_COUNT }, () => String(ri(0, 9))).join("");
  } while (new Set(digits).size < 2);
  return digits;
}

// —— SVG：CORS-safe、无字体依赖。逐位 <text> 独立定位，带位置抖动 + 旋转 + 浅色底噪。 ——
// 尺寸贴合输入框右侧的题面坞（108×40），等比缩放不裁字。
const SVG_W = 108;
const SVG_H = 40;
const PAD_X = 8;
const SLOT = (SVG_W - PAD_X * 2) / DIGIT_COUNT;

export function digitsSvg(digits) {
  const parts = [`<rect width="${SVG_W}" height="${SVG_H}" fill="#f1f5f9" />`];
  // 3 条浅色横带打散字符连续性，不压住笔画主体
  for (let i = 0; i < 3; i += 1) {
    const y = 4 + Math.random() * (SVG_H - 8);
    parts.push(`<path d="M0 ${y.toFixed(1)} Q${(SVG_W * 0.3).toFixed(1)} ${(y + ri(-7, 7)).toFixed(1)} ${SVG_W} ${(4 + Math.random() * (SVG_H - 8)).toFixed(1)}" stroke="rgba(15,23,42,0.14)" fill="none" stroke-width="1.1" />`);
  }
  [...digits].forEach((c, i) => {
    const cx = PAD_X + SLOT * (i + 0.5) + (Math.random() - 0.5) * 3;
    const cy = 28 + (Math.random() - 0.5) * 5;
    const rot = (Math.random() - 0.5) * 30;
    const fill = `hsl(${ri(200, 260)}, ${ri(30, 60)}%, ${ri(12, 30)}%)`;
    parts.push(`<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" transform="rotate(${rot.toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)})" font-size="26" font-weight="700" font-family="ui-monospace,'DejaVu Sans Mono',Menlo,Consolas,monospace" fill="${fill}">${c}</text>`);
  });
  for (let i = 0; i < 10; i += 1) {
    parts.push(`<circle cx="${(Math.random() * SVG_W).toFixed(1)}" cy="${(Math.random() * SVG_H).toFixed(1)}" r="${(0.6 + Math.random() * 1.1).toFixed(1)}" fill="rgba(15,23,42,${(0.12 + Math.random() * 0.2).toFixed(2)})" />`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${SVG_H}" style="display:block;width:100%;height:100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">${parts.join("")}</svg>`;
}
