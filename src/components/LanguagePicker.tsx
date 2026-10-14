// 语言选择：偏好存本机 localStorage，切换后 site 上下文重新拉取语言包
import { useSite } from "../site";
import { LANGUAGES } from "../const";

export function LanguagePicker() {
  const { lang, setLang, t } = useSite();
  return (
    <div role="radiogroup" aria-label={t("site.language", "语言")} className="flex flex-wrap gap-1.5">
      {LANGUAGES.map((l) => {
        const active = l.code === lang;
        return (
          <button
            key={l.code}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setLang(l.code)}
            className={
              "rounded-md border px-3 py-1 text-xs transition " +
              (active
                ? "border-primary bg-primary font-medium text-primary-foreground shadow-sm shadow-primary/40"
                : "bg-card text-foreground hover:border-primary hover:bg-accent hover:text-accent-foreground")
            }
          >
            {l.name}
          </button>
        );
      })}
    </div>
  );
}
