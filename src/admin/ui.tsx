import { useCallback, useState, type ReactNode } from "react";
import { ApiError, call, newIdem } from "../api";

export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "network_error") return "后端不可达：本地预览仅前端，功能需在已发布站点验证";
    return e.message || `错误：${e.code}`;
  }
  return "操作失败";
}

export function askConfirm(action: string): boolean {
  return window.confirm(`高危操作：${action}\n确认执行？（将写入审计日志）`);
}

/** 用户在二次确认弹窗里点了取消（不是后端错误，不应显示为失败） */
export function isConfirmCancel(e: unknown): boolean {
  return e instanceof ApiError && e.code === "confirm_required";
}

export async function riskyPost<T = unknown>(path: string, body: Record<string, unknown>, action: string): Promise<T> {
  if (!askConfirm(action)) throw new ApiError("confirm_required", "已取消", 400);
  return call<T>(path, { method: "POST", token: "admin", idem: newIdem(), body: { ...body, confirm: true } });
}

export function useBusy(): [boolean, <T>(fn: () => Promise<T>) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false);
  // run 必须稳定：各页面的 load=useCallback(...,[run]) + useEffect(load,[load]) 依赖它，
  // 若每次渲染都换身份，effect 会无限重跑并疯狂重复请求（后台多页实测踩过）。
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  }, []);
  return [busy, run];
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-end gap-3">{children}</div>;
}

export function PageTitle({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="mb-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      {desc && <p className="mt-1 text-sm text-muted-foreground">{desc}</p>}
    </div>
  );
}
