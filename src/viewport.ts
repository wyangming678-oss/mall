// 软键盘占位：手机键盘弹出时 visualViewport 变矮，算出被吃掉的高度，让整页会话框跟着变矮、输入框贴到键盘上方。
// 只在会话类页面启用；桌面端 visualViewport 高度等于窗口高度，恒为 0，布局不受影响。
import { useEffect, useState } from "react";

export function useKeyboardInset(enabled: boolean) {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled) {
      setInset(0);
      return undefined;
    }
    if (!vv) return undefined;
    const sync = () => {
      const h = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      // 地址栏/工具条收起通常只有几十像素，当作键盘会让会话框莫名变矮
      setInset(h > 90 ? h : 0);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, [enabled]);
  return inset;
}
