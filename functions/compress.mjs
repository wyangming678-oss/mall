// 响应压缩（egress 那一档最硬的限制：Deno Deploy 免费档 20 GiB/月，先按 4–6 倍把它放大，再谈缓存）。
// **只在搬家入口 deploy/deno-deploy.ts 挂**：现网入口是 functions/index.ts，不经过这里 ⇒ 现网响应逐字节不变。
// 三条判定各挡一类白烧 CPU / 语义损坏：
//   · 客户端不收 gzip（curl、部分老代理）⇒ 原样返回，不改造任何响应头；
//   · 类型不在文本白名单 ⇒ 不压（图片/zip 再压只会变大，且这里压的是 CPU 额度）；
//   · 正文小于一屏 ⇒ 不压（一个几十字节的错误封套压完省不下几百字节，纯亏一次流转换）。
import { envValue } from "./storage.mjs";

// 阈值：低于这个字节数不压。1 KB ≈ 我们最小那类业务响应（封套 + 几条 id）的量级，
// 而目录类响应动辄 20–60 KB，压不压的差别全在上面那一档，所以阈值卡在这里不会漏掉真正的收益。
const MIN_BYTES = 1024;
// 这些状态按规范不能带正文，压了就是把 body 塞进不该有 body 的响应。
const NO_BODY = new Set([204, 205, 304]);
const TEXTUAL = /^(application\/(json|ld\+json|javascript|x-javascript|xml|xhtml\+xml)|text\/|image\/svg\+xml)/;

export function wantsGzip(request) {
  const raw = String(request?.headers?.get?.("accept-encoding") ?? "").toLowerCase();
  return raw.split(",").some((entry) => {
    const [token, ...params] = entry.trim().split(";");
    if (token.trim() !== "gzip") return false;
    // 只挡显式 q=0（「我不要 gzip」）；没写 q 就是默认 1。
    const quality = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !(quality && Number(quality.slice(2)) === 0);
  });
}

export function compressible(response) {
  if (NO_BODY.has(response.status)) return false;
  // 已经编码过的（平台/上游压过，或本身就是二进制分片）绝不二次压缩：
  // 双重 gzip 不省字节，还会让下游按 gzip 解一次拿到乱码。
  if (response.headers.get("content-encoding")) return false;
  return TEXTUAL.test(String(response.headers.get("content-type") ?? "").toLowerCase());
}

// vary 必须 append：CORS 那层用同一个头记 origin（cors.mjs:31），用 set 覆盖掉就等于
// 让共享缓存把「带 ACAO 的响应」发给另一个站点——那正是 CORS 里最贵的缓存投毒。
function mergeVary(headers, value) {
  if (!new RegExp(`\\b${value.toLowerCase()}\\b`).test(String(headers.get("vary") ?? "").toLowerCase())) {
    headers.append("vary", value);
  }
  return headers;
}

export function withCompression(handle) {
  return async (request, context) => {
    const response = await handle(request, context);
    if (!enabled() || !wantsGzip(request) || !compressible(response)) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < MIN_BYTES) {
      // 不压就原样交还：状态、状态行、每一个响应头都不动（含 content-encoding 缺席、vary 不新增），
      // 这样「没启用压缩时的响应」与搬家前可逐字节比。
      return new Response(bytes.byteLength ? bytes : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    const headers = mergeVary(new Headers(response.headers), "Accept-Encoding");
    // 正文长度变了，留着 content-length 就是头与 body 不符 ⇒ 客户端截断或直接挂起。
    headers.delete("content-length");
    headers.set("content-encoding", "gzip");
    return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

// 搬家后默认就开；留一个显式刹车（MALL_COMPRESSION=off），是因为压缩吃的是 CPU 额度，
// 真撞 CPU 上限时他要能一句话关掉，而不是回滚整份部署。
function enabled() {
  return String(envValue("MALL_COMPRESSION") ?? "").trim().toLowerCase() !== "off";
}
