// 防滥用一次性验证题：题面领取/答题提交/换题（register 必答题；登录失败够次数才出题）
// 题面恒为 6 位随机数字，纯图形不含文字 ⇒ 不随界面语言变化，重新取题只由「点击图片」触发。
import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "../api";
import { useSite } from "../site";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Challenge { challenge_id: string; svg: string }

export function useCaptchaChallenge(scope: string, enabled: boolean) {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const refresh = useCallback(async () => {
    setAnswer("");
    // 未启用答题的场景（如登录前两次失败）不占用发题配额，只清状态
    if (!enabledRef.current) { setChallenge(null); return; }
    setLoading(true);
    try {
      setChallenge(await call<Challenge>("auth/captcha", { query: { scope } }));
    } catch {
      setChallenge(null);
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { challenge, answer, setAnswer, refresh, loading };
}

export type CaptchaCap = ReturnType<typeof useCaptchaChallenge>;

export const captchaBody = (cap: CaptchaCap) => (
  cap.challenge ? { challenge_id: cap.challenge.challenge_id, captcha_answer: cap.answer } : {}
);

export function CaptchaRow({ cap, label }: { cap: CaptchaCap; label?: string }) {
  const { t } = useSite();
  const refresh = t("auth.captcha_refresh", "点击换一张数字图");
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="cap-a">{label ?? t("auth.captcha_label", "人机验证")}</Label>
      <div className="relative">
        {/* 320px 下扣掉题面坞只剩 ~95px 写字区：字距收到 0.18em、占位不带字距，否则四语占位全被裁切 */}
        <Input
          id="cap-a"
          className="h-12 pr-[116px] font-mono tracking-[0.18em] placeholder:tracking-normal"
          placeholder={t("auth.captcha_placeholder", "6位数字")}
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          value={cap.answer}
          onChange={(e) => cap.setAnswer(e.target.value.replace(/\D/g, ""))}
          required
        />
        {/* 题面坞贴在输入框右端：整块可点，点一下换一张（等价于旧「换一题」） */}
        <button
          type="button"
          onClick={() => void cap.refresh()}
          aria-label={refresh}
          title={refresh}
          className="absolute top-1 right-1 h-10 w-[108px] overflow-hidden border-l border-border bg-muted/40"
        >
          {cap.challenge ? (
            // SVG 由服务端生成：只含 <svg>/<text>/<path>/<rect>/<circle>，无脚本、无外链
            <div dangerouslySetInnerHTML={{ __html: cap.challenge.svg }} />
          ) : (
            <span className="flex h-full items-center justify-center px-1 text-center text-[11px] leading-tight text-muted-foreground">
              {cap.loading ? t("auth.captcha_loading", "题目加载中…") : t("auth.captcha_failed", "点我重试")}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
