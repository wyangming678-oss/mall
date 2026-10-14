import { useCallback, useEffect, useMemo, useState } from "react";
import { call, newIdem } from "../../api";
import { MESSAGES } from "../../i18n";
import { PageTitle, errText, useBusy } from "../ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

const CODES = Object.keys(MESSAGES);
const LANG_NAME: Record<string, string> = { zh: "中文", en: "English", ja: "日本語", ko: "한국어", es: "Español" };

const GROUP_LABEL: Record<string, string> = {
  common: "通用词", site: "站名与标语", nav: "顶部导航", tab: "底部导航", home: "首页", sf: "商城二楼",
  splash: "开屏与弹窗", card: "卡片", cat: "分类页", search: "搜索页", cart: "购物车", checkout: "结算下单",
  product: "商品详情", review: "评价", wish: "收藏", order: "订单详情", orders: "订单列表", trade: "交易流水",
  me: "我的", wallet: "余额", addr: "收货地址", vip: "VIP 会员", coin: "金币", coins: "金币商城",
  coupon: "优惠券", invoice: "发票", invite: "邀请返利", auth: "登录注册", phone: "手机号", pay: "支付",
  poster: "海报", page: "内容页面", support: "客服", chat: "客服会话", msg: "站内消息", status: "状态与提示",
  af: "防滥用验证", api: "接口提示", app: "应用外壳",
};

const QUICK = [
  { prefix: "home", label: "首页" },
  { prefix: "cat", label: "分类" },
  { prefix: "cart", label: "购物车" },
  { prefix: "me", label: "我的" },
  { prefix: "tab", label: "底部导航" },
  { prefix: "status", label: "状态提示" },
];

const PAGE_SIZE = 20;
const VAR_RE = /\{(\w+)\}/g;
const BRACE_RE = /\{([^{}]*)\}/g;
/** 窄屏定宽控件：超过这个字数会挤压或裁切，只提示不拦保存。 */
const SOFT_MAX: Record<string, number> = { tab: 4, nav: 6 };

function varsOf(text: string): string[] {
  return [...text.matchAll(VAR_RE)].map((m) => m[1]);
}
function bracesOf(text: string): string[] {
  return [...text.matchAll(BRACE_RE)].map((m) => m[1]);
}

type Overrides = Record<string, Record<string, string>>;
type Draft = Record<string, Record<string, string>>;
type Item = { string_key: string; lang: string; content: string };
type Tone = "muted" | "primary" | "destructive";

export default function StringsPage() {
  const [ov, setOverrides] = useState<Overrides>(() => Object.fromEntries(CODES.map((c) => [c, {}])));
  const [draft, setDraft] = useState<Draft>({});
  const [keyword, setKeyword] = useState("");
  const [quick, setQuick] = useState("");
  const [onlyEdited, setOnlyEdited] = useState(false);
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, run] = useBusy();

  /** keepDraft：写入成功后只丢掉已保存那一行的编辑，其余未保存的编辑留在页面上。 */
  const load = useCallback((keepDraft = false) => {
    void run(async () => {
      try {
        const rows = await Promise.all(
          CODES.map((c) => call<{ strings: Record<string, string> }>("site/strings", { query: { lang: c } })),
        );
        const next: Overrides = {};
        CODES.forEach((c, i) => { next[c] = rows[i].strings ?? {}; });
        setOverrides(next);
        if (!keepDraft) setDraft({});
        setError("");
      } catch (e) {
        setError(errText(e));
      }
    });
  }, [run]);

  useEffect(load, [load]);

  function builtin(key: string, lang: string): string {
    return MESSAGES[lang]?.[key] ?? MESSAGES.zh[key] ?? "";
  }
  function shown(key: string, lang: string): string {
    const stored = ov[lang]?.[key];
    return stored !== undefined ? stored : builtin(key, lang);
  }
  function cellValue(key: string, lang: string): string {
    return draft[key]?.[lang] ?? shown(key, lang);
  }
  function isEdited(key: string): boolean {
    return CODES.some((lang) => shown(key, lang) !== builtin(key, lang));
  }
  function isPending(key: string, lang: string): boolean {
    const want = draft[key]?.[lang];
    return want !== undefined && want !== shown(key, lang);
  }
  function pendingCount(key: string): number {
    return CODES.filter((lang) => isPending(key, lang)).length;
  }
  /** 这一条文案在前端代码里可用的花括号变量，以四种语言的内置文字为准。 */
  function allowedVars(key: string): string[] {
    const set = new Set<string>();
    for (const lang of CODES) for (const v of varsOf(MESSAGES[lang]?.[key] ?? "")) set.add(v);
    return [...set];
  }

  function hardIssue(key: string, lang: string): string {
    const text = cellValue(key, lang);
    if (!text.trim() && builtin(key, lang).trim()) return "不能保存空白文案，前台会显示成一片空白";
    const lost = varsOf(shown(key, lang)).filter((v) => !varsOf(text).includes(v));
    if (lost.length) return `缺少 {${lost.join("}、{")}}，那个位置在前台会变空`;
    const allow = allowedVars(key);
    const made = [...new Set(bracesOf(text).filter((g) => !allow.includes(g)))];
    if (made.length) {
      return allow.length
        ? `不能自己新加 {${made.join("}、{")}}，这一条只有 {${allow.join("}、{")}} 可用`
        : `不能加花括号 {${made.join("}、{")}}（这一条没有变量）；想用作分隔符请换（）或「」`;
    }
    return "";
  }

  /** 只改中文、而这一格既没编辑也没有自己的覆盖行 ⇒ 保存后这一格会显示中文。 */
  function followsZh(key: string, lang: string): boolean {
    if (lang === "zh" || !isPending(key, "zh")) return false;
    return !isPending(key, lang) && ov[lang]?.[key] === undefined;
  }

  function caption(key: string, lang: string): { text: string; tone: Tone } {
    if (isPending(key, lang)) {
      const hard = hardIssue(key, lang);
      if (hard) return { text: hard, tone: "destructive" };
      const limit = SOFT_MAX[key.split(".")[0]];
      const len = [...cellValue(key, lang).trim()].length;
      if (limit && len > limit) return { text: `建议 ≤${limit} 字，现在 ${len} 字，窄屏会挤压`, tone: "primary" };
      return { text: "未保存", tone: "primary" };
    }
    if (!(key in MESSAGES.zh)) return { text: "语言包外的键，前台用不到", tone: "muted" };
    const stored = ov[lang]?.[key];
    const now = shown(key, lang);
    if (followsZh(key, lang)) return { text: "只改了中文：保存后这一格也显示这句中文", tone: "primary" };
    if (stored === undefined) return { text: "默认", tone: "muted" };
    if (now === builtin(key, lang)) return { text: "与默认相同（覆盖行仍在）", tone: "muted" };
    if (lang !== "zh" && now === shown(key, "zh")) return { text: "显示的是中文（跟随中文覆盖）", tone: "primary" };
    return { text: "已覆盖", tone: "primary" };
  }

  const customKeys = useMemo(() => {
    const set = new Set<string>();
    for (const lang of CODES) for (const k of Object.keys(ov[lang] ?? {})) if (!(k in MESSAGES.zh)) set.add(k);
    return [...set].sort();
  }, [ov]);
  const allKeys = useMemo(() => [...Object.keys(MESSAGES.zh), ...customKeys], [customKeys]);
  const prefixes = useMemo(() => {
    const set = new Set<string>();
    for (const k of Object.keys(MESSAGES.zh)) set.add(k.split(".")[0]);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, []);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const prefix = quick ? `${quick}.` : "";
    return allKeys.filter((k) => {
      if (prefix && !k.startsWith(prefix)) return false;
      if (onlyEdited && !isEdited(k)) return false;
      if (!kw) return true;
      if (k.toLowerCase().includes(kw)) return true;
      return CODES.some((lang) => shown(k, lang).toLowerCase().includes(kw));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allKeys, keyword, quick, onlyEdited, ov]);

  useEffect(() => { setPage(0); }, [keyword, quick, onlyEdited]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const editedTotal = useMemo(() => allKeys.filter((k) => isEdited(k)).length, // eslint-disable-line react-hooks/exhaustive-deps
    [allKeys, ov]);
  const pinnedTotal = useMemo(() => allKeys.filter((k) => // eslint-disable-line react-hooks/exhaustive-deps
    k in MESSAGES.zh && CODES.some((lang) => ov[lang]?.[k] !== undefined && shown(k, lang) === builtin(k, lang))).length,
    [allKeys, ov]);

  function buildItems(keys: string[]): Item[] | null {
    const items: Item[] = [];
    const broken: string[] = [];
    for (const key of keys) {
      for (const lang of CODES) {
        if (!isPending(key, lang)) continue;
        const problem = hardIssue(key, lang);
        if (problem) { broken.push(`${key}（${LANG_NAME[lang] ?? lang}）${problem}`); continue; }
        items.push({ string_key: key, lang, content: cellValue(key, lang) });
      }
    }
    if (broken.length) {
      setError(`不能保存：${broken.slice(0, 3).join("；")}${broken.length > 3 ? ` 等 ${broken.length} 处` : ""}`);
      return null;
    }
    return items;
  }

  async function writeItems(items: Item[], doneNotice: string): Promise<boolean> {
    if (!items.length) { setNotice("没有需要保存的改动（内容与当前生效文字相同）"); return false; }
    setError("");
    setNotice("");
    try {
      for (let i = 0; i < items.length; i += 100) {
        await call("admin/string/save", {
          method: "POST", token: "admin", idem: newIdem(), body: { items: items.slice(i, i + 100) },
        });
      }
      const saved = new Set(items.map((it) => it.string_key));
      const other = Object.keys(draft).filter((k) => !saved.has(k) && pendingCount(k) > 0).length;
      setDraft((d) => {
        const next: Draft = {};
        for (const k of Object.keys(d)) if (!saved.has(k)) next[k] = d[k];
        return next;
      });
      setNotice(other ? `${doneNotice}（另有 ${other} 条未保存的编辑留在页面上，没有丢）` : doneNotice);
      load(true);
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    }
  }

  async function saveRow(key: string) {
    const items = buildItems([key]);
    if (items) await writeItems(items, `已保存 ${key}，购物端刷新页面即生效`);
  }

  async function saveVisible() {
    const items = buildItems(rows);
    if (items) await writeItems(items, `已保存 ${items.length} 条覆盖，购物端刷新页面即生效`);
  }

  async function restoreRow(key: string) {
    const items = CODES
      .map((lang) => ({ string_key: key, lang, content: builtin(key, lang) }))
      .filter((it) => it.content !== shown(key, it.lang));
    if (!items.length) { setNotice(`${key} 现在显示的就是内置文字（覆盖行仍在，不需要再恢复）`); return; }
    await writeItems(items, `已把内置文字写回 ${key}。覆盖行不会删除，所以以后新版改了这条内置文案，它也不会自动跟随。`);
  }

  const pendingRows = rows.filter((k) => pendingCount(k) > 0).length;

  return (
    <div className="flex flex-col gap-4">
      <PageTitle
        title="语言文案"
        desc={`购物端全部界面文案（内置 ${Object.keys(MESSAGES.zh).length} 条 × 四语）。一格一行改文字，改完点「保存本条」或「保存本页改动」；这里改的是语言包覆盖层，零发布即可生效。`}
      />

      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <p>共 {allKeys.length} 条，其中 <span className="font-medium text-foreground">{editedTotal}</span> 条已被后台改过。保存后购物端刷新页面才生效（已打开的页面不会自己更新，微信里要整页重进）。</p>
        <p><span className="text-foreground">四格一起填。</span>只改「中文」这一格，英/日/韩也会显示这句中文——后台覆盖优先于内置译文。格子下面会写明哪一格会跟过去。</p>
        <p><span className="text-foreground">不能存空白。</span>清空后保存会被拦下（空白文案前台就是一片空白）。要回到默认文字，用「恢复默认」。</p>
        <p><span className="text-foreground">花括号照原样留着。</span>{"{变量}"} 删掉会拦，自己新编一个也会拦（前端只认这一条原有的变量名，{"{中文}"} 这类原样显示在页面上）。</p>
        <p>「恢复默认」= 把内置文字写回去，效果等同默认，但<span className="text-foreground">覆盖行会一直留着</span>（后台没有删除行的入口），共 {pinnedTotal} 条已写回过默认文字。</p>
        <p>底部四个标签名在这里改（<span className="font-mono">tab.home / tab.category / tab.cart / tab.me</span>），装修里的导航标签对这四个内置页面不生效；标签超过 4 字会挤压。楼层标题以装修里的自定义标题优先。</p>
        <p>「保存本条」只写入这一行，同一页其他行的编辑不会丢，会留在格子里等你继续保存。标了「自定义（语言包外）」的行是语言包里没有的键，前台用不到，可以不管。</p>
        <p>商品名/详情、券名、公告、楼层标题、客服话术不在这一页，那些到商品/券/装修页面改。</p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && <p className="text-sm text-primary">{notice}</p>}

      <div className="flex flex-col gap-3 border-b border-border/70 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索键名或现有文字，如 banner_tagline / 购物车"
            className="max-w-72"
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={onlyEdited} onChange={(e) => setOnlyEdited(e.target.checked)} />
            只看改过的
          </label>
          <span className="text-xs text-muted-foreground">第 {safePage + 1} / {pageCount} 页 · 命中 {filtered.length} 条</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={safePage <= 0} onClick={() => setPage(safePage - 1)}>上一页</Button>
            <Button size="sm" variant="outline" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>下一页</Button>
            <Button size="sm" disabled={busy || pendingRows === 0} onClick={() => void saveVisible()}>
              保存本页改动{pendingRows ? `（${pendingRows} 条）` : ""}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={`border px-2 py-1 text-xs ${quick === "" ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
            onClick={() => setQuick("")}
          >
            全部
          </button>
          {QUICK.map((g) => (
            <button
              key={g.prefix}
              type="button"
              className={`border px-2 py-1 text-xs ${quick === g.prefix ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
              onClick={() => setQuick(quick === g.prefix ? "" : g.prefix)}
            >
              {g.label}
            </button>
          ))}
          <select
            className="h-7 border bg-background px-2 text-xs"
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
          >
            <option value="">按分组选择…</option>
            {prefixes.map((p) => <option key={p} value={p}>{GROUP_LABEL[p] ?? p}（{p}）</option>)}
          </select>
        </div>
      </div>

      <div className="flex flex-col">
        <div className="grid gap-2 border-b border-border/70 pb-2 text-xs font-semibold text-muted-foreground lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)_minmax(0,170px)]">
          <div>键名 / 分组</div>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
            {CODES.map((lang) => <div key={lang}>{LANG_NAME[lang] ?? lang}</div>)}
          </div>
          <div className="lg:text-right">操作</div>
        </div>

        {rows.map((key) => {
          const edited = isEdited(key);
          const custom = !(key in MESSAGES.zh);
          const prefix = key.split(".")[0];
          const bad = CODES.filter((lang) => isPending(key, lang) && hardIssue(key, lang));
          const pinned = !custom && CODES.some((lang) => ov[lang]?.[key] !== undefined && shown(key, lang) === builtin(key, lang));
          return (
            <div
              key={key}
              className="grid gap-2 border-b border-border/70 py-3 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)_minmax(0,170px)]"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-mono text-xs break-all">{key}</span>
                <span className="flex flex-wrap items-center gap-1">
                  <span className="text-xs text-muted-foreground">{custom ? "自定义（语言包外）" : GROUP_LABEL[prefix] ?? prefix}</span>
                  {edited && <Badge variant="secondary" className="text-[10px]">已改</Badge>}
                  {pinned && <Badge variant="outline" className="text-[10px]">已写回默认</Badge>}
                  {custom && <Badge variant="outline" className="text-[10px]">自定义键</Badge>}
                  {pendingCount(key) > 0 && <Badge variant="outline" className="text-[10px]">未保存 {pendingCount(key)}</Badge>}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                {CODES.map((lang) => {
                  const cap = caption(key, lang);
                  return (
                    <div key={lang} className="flex min-w-0 flex-col gap-1">
                      <Input
                        value={cellValue(key, lang)}
                        maxLength={2000}
                        aria-label={`${key} ${LANG_NAME[lang] ?? lang}`}
                        aria-invalid={bad.includes(lang)}
                        className="h-8 text-sm"
                        placeholder={builtin(key, lang)}
                        onChange={(e) => {
                          setNotice("");
                          setDraft((d) => ({ ...d, [key]: { ...(d[key] ?? {}), [lang]: e.target.value } }));
                        }}
                      />
                      <span className={`text-[11px] ${cap.tone === "destructive" ? "text-destructive" : cap.tone === "primary" ? "text-primary" : "text-muted-foreground"}`}>
                        {cap.text}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-start gap-2 lg:justify-end">
                <Button size="sm" disabled={busy || pendingCount(key) === 0 || bad.length > 0} onClick={() => void saveRow(key)}>
                  保存本条
                </Button>
                <Button size="sm" variant="outline" disabled={busy || custom || !edited} onClick={() => void restoreRow(key)}>
                  恢复默认
                </Button>
              </div>
            </div>
          );
        })}

        {rows.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">没有符合条件的文案，换个关键词或取消分组筛选。</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={safePage <= 0} onClick={() => setPage(safePage - 1)}>上一页</Button>
        <span className="text-xs text-muted-foreground">第 {safePage + 1} / {pageCount} 页</span>
        <Button size="sm" variant="outline" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>下一页</Button>
      </div>
    </div>
  );
}
