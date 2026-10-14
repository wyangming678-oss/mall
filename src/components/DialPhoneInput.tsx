// 区号选择器 + 国内号码输入（注册必填、登录切换、后台抽屉编辑三处共用）
import { DIAL_CODES, DEFAULT_DIAL, dialLabel } from "../phone";
import { useSite } from "../site";
import { Input } from "@/components/ui/input";

export function DialPhoneInput({ dial = DEFAULT_DIAL, national, onDial, onNational, idNum, required = false, disabled = false, autoComplete = "tel-national" }: {
  dial?: string;
  national: string;
  onDial: (v: string) => void;
  onNational: (v: string) => void;
  idNum: string;
  required?: boolean;
  disabled?: boolean;
  autoComplete?: string;
}) {
  const { lang, t } = useSite();
  return (
    <div className="flex gap-2">
      <select
        aria-label={t("auth.dial_aria", "国际区号")}
        disabled={disabled}
        className="h-10 w-40 shrink-0 rounded-xl border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        value={dial}
        onChange={(e) => onDial(e.target.value)}
      >
        {DIAL_CODES.map((d) => (
          <option key={d.dial} value={d.dial}>+{d.dial} {dialLabel(d.dial, lang)}</option>
        ))}
      </select>
      <Input
        id={idNum}
        className="h-10 min-w-0 flex-1"
        type="tel"
        inputMode="numeric"
        placeholder={t("auth.phone_placeholder", "手机号码")}
        autoComplete={autoComplete}
        disabled={disabled}
        required={required}
        value={national}
        onChange={(e) => onNational(e.target.value.replace(/[^\d]/g, ""))}
        maxLength={12}
      />
    </div>
  );
}
