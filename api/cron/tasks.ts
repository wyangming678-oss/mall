// Vercel Cron 入口：vercel.json 的 crons 每 10 分钟 GET 这里一次。
// Vercel 调 cron 会自动带 `Authorization: Bearer ${CRON_SECRET}`，据此鉴权。
import { cronClient } from "../../deploy/vercel-env.mjs";
import { tasksTickSystem } from "../../functions/tasks.mjs";

function unavailable(res, code) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ error: code === 401 ? "unauthorized" : "cron_runtime_unavailable" }));
}

export default async function handler(req, res) {
  const secret = (process.env.CRON_SECRET || "").replace(/[^\x20-\x7E]/g, "").trim();
  if (!secret) return unavailable(res, 503);
  if (req.headers.authorization !== `Bearer ${secret}`) return unavailable(res, 401);
  try {
    const result = await tasksTickSystem(cronClient());
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(result));
  } catch {
    return unavailable(res, 503);
  }
}
