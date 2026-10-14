// 账户相关二级页共用的错误态：ApiError 优先取消息，其次键化错误码，字符串视为已取好的文案
import { useState } from "react";
import { ApiError } from "./api";
import { useSite } from "./site";

export function useError(): [string, (e: unknown) => void, () => void] {
  const { t } = useSite();
  const [error, setError] = useState("");
  return [
    error,
    (e) => setError(
      e instanceof ApiError
        ? e.message || t("auth.error_prefix", "错误：") + e.code
        : (typeof e === "string" ? e : t("common.op_failed", "操作失败")),
    ),
    () => setError(""),
  ];
}
