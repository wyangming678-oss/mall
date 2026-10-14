// 统一错误与响应封套（文档C §〇.2）
export class AppError extends Error {
  constructor(status, code, message = "", details = null) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
    this.message = message || code;
  }
}

const NO_STORE = { "cache-control": "no-store" };

export const ok = (data, status = 200) =>
  Response.json({ ok: true, data }, { status, headers: NO_STORE });

export const fail = (code, message = "", details = null, status = 400) =>
  Response.json({ ok: false, error: { code, message, details } }, { status, headers: NO_STORE });

export const isUniqueViolation = (error) => error?.code === "23505";
