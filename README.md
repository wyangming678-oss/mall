# ChicCart

全栈商城站点（购物端 + 后台管理端），托管在 Qoder Sites：React 19 + TypeScript + Vite 静态产物，服务端逻辑集中在一个 Deno Edge Function `app` 里，数据放在平台数据库的 `app` schema，文件走 Function 代理的 Storage。

设计契约在工作区根目录：`方案V2.1.md`、`整体逻辑V2.1.md`、`文档A-数据库设计.md`、`文档B-状态机设计.md`、`文档C-API接口设计.md`、`M0-0实测结论.md`。

## 开发

需要 Node 22.12 或更高版本（含 24.x）：

```sh
npm ci
npm run dev        # Vite 开发服务器（127.0.0.1）
npm run build      # tsc --noEmit + 产出 dist/
npm run preview    # 预览已构建的 dist/
```

`npm run build` 会先做类型检查再打包；只要源码未变，可复用已通过的检查结果。

本地没有 Deno 时，`preview` 对 `/functions/v1/app` 的代理会返回 502，前端会显示"后端不可达"提示，此时只能验证界面与交互，接口需在同源已发布站点上验证。

## 目录结构

- `src/` 前端：`App.tsx` 路由壳、`pages/` 购物端页面、`admin/` 后台壳与管理页、`components/` 业务组件、`api.ts`/`site.tsx`/`router.tsx`/`trade.ts`/`catalog.ts` 基础设施。
- `components/ui/` 随模板自带的 Shadcn 组件库（导入别名 `@/components/ui/*`）。
- `functions/` 后端：`index.ts` 是 Deno 部署入口，`handler.mjs` 维护路由表 `ROUTES`，其余按领域拆分（auth / users / admins / catalog / inventory / cart / orders / order_state / payments / wallet / address / files / tasks / config / permissions / idem / validate / adapter / errors）。
- `dev/function-local.ts` 本地 Deno 运行入口（需 `SUPABASE_URL`、`SUPABASE_ANON_KEY`，并携带 `x-instance-id` 请求头），不属于发布产物。
- `_scratch/smoke.mjs` 用假 supabase 客户端跑后端契约冒烟（覆盖 M1 + M2a + M2b，共 253 条断言），无 Deno 时唯一的回归手段。

```sh
node _scratch/smoke.mjs
```

接口路径统一为 `/functions/v1/app/<group>/<action>`，响应信封 `{ ok, data | error }`；写操作需要 `idempotency-key` 头，高风险操作还需要 `confirm: true`。

## 发布

按 `sites-hosting` 流程，用 `prepare_site` 上传冻结草稿：

- `webDirectory: "dist"`（先构建）
- `functionDirectory: "functions"`
- `databaseAccess: "read_write"`、`spa: true`（`/cart`、`/admin` 等深链需要回退）
- `requiredSchemaVersion` 与已应用的迁移批次一致（当前 schema v9）

站点为 private，发布需要逐次明确批准。数据库迁移、Storage、访问策略等管理操作走 `sites-management`。应用凭据只放在服务端 Sites Settings，前端环境变量是公开的。

模板来源与第三方样式许可见 `PROVENANCE.md` 和 `vendor/`。
