# 蓝猫陪玩系统 · 代码快照（2026-04-10）

> 目的：补全 `PROJECT_ANCHOR.md` / `DEV_LOG.md` 中尚未覆盖的“当前代码已落地能力”。  
> 范围：`newObject/server` + `newObject/system-admin`。

---

## 1. 当前工作区结构

- 后端：`newObject/server`（NestJS + Prisma + MySQL）
- 前端：`newObject/system-admin`（Umi Max + Ant Design Pro）

---

## 2. 后端已装配模块（AppModule）

`src/app.module.ts` 已启用模块：

- `auth`
- `users`
- `orders`
- `settlements`
- `staff-ratings`
- `permission`
- `role`
- `game-project`
- `meta`
- `wallet`
- `dashboard`
- `user-logs`
- `finance`
- `performance`

全局 Guard 顺序（非常关键）：

1. `JwtAuthGuard`（先验 token）
2. `UserStatusGuard`（冻结/禁用控制）
3. `PermissionsGuard`（权限点校验）

---

## 3. 用户状态拦截规则（代码事实）

`src/common/guards/user-status.guard.ts`：

- `DISABLED`：全部拒绝访问。
- `FROZEN`：仅允许钱包与少量基础接口（如 `/wallet/*`、`/meta/enums`、`/auth/me`）。

这意味着“冻结用户仅能处理钱包相关事项”已实际生效，不只是设计约束。

---

## 4. 数据模型补充（相对旧文档）

`prisma/schema.prisma` 除订单主链路外，已落地以下关键模型：

- 钱包与提现：
  - `WalletAccount`
  - `WalletTransaction`
  - `WalletHold`
  - `WalletWithdrawalRequest`
  - `WalletDepositTransaction`
- 财务与业绩：
  - `PerformanceRecord`
  - `OrderFinanceRecord`

新增关键枚举：

- 钱包域：`WalletDirection` / `WalletBizType` / `WalletTxStatus` / `WalletHoldStatus`
- 提现域：`WithdrawalStatus` / `WithdrawalChannel`
- 业绩域：`PerformanceOwnerRoleType` / `PerformanceRecordStatus`
- 财务域：`FinanceRecordStatus`

---

## 5. 订单域当前能力（代码已实现）

`src/orders/orders.controller.ts` + `src/orders/orders.service.ts` 已覆盖：

- 订单主流程：创建、派单、接单、拒单、存单、结单、退款、编辑、确认收款。
- 订单列表增强：支持 `keyword` 全局检索（订单号/客服/陪玩）。
- 结算调整：`/orders/settlements/adjust`（手动改最终收益）。
- 结单确认：`/orders/confirm-complete`。
- 存单后修复（新）：`/orders/update-archived-progress-total`
  - `fixType=GUARANTEED`：修复总保底进度并均分。
  - `fixType=HOURLY`：修复 `billableHours`。
- 对齐修复：`/orders/repair-wallet-by-settlementsV1`。
- 错误冲正回滚：`/orders/:id/rollback-wrong-settlement-reversals`。

额外事实：

- `OrdersService` 已内建“重建业绩记录 + 重建订单财务记录”链路：
  - `rebuildPerformanceRecordsForOrder`
  - `upsertOrderFinanceRecordForOrder`
  - `rebuildPerformanceAndFinanceByOrderId`

---

## 6. 钱包/提现当前能力（代码已实现）

钱包控制器：

- `GET /wallet/account`
- `GET /wallet/transactions`
- `GET /wallet/holds`
- `GET /wallet/statistics`
- `POST /wallet/withdraw/qr-code`
- `GET /wallet/withdraw/qr-code-url`
- `POST /wallet/deposit/manual`
- `GET /wallet/deposit-transactions`

提现控制器：

- `POST /wallet/withdrawals/apply`
- `GET /wallet/withdrawals/withdraw-info`
- `GET /wallet/withdrawals/mine`
- `GET /wallet/withdrawals/pending`（权限）
- `POST /wallet/withdrawals/list`（权限）
- `POST /wallet/withdrawals/review`（权限）

`WalletWithdrawalsService` 规则补充：

- 每天最多 1 次提现、每周最多 3 次。
- 首次提现限制（接单时长、余额阈值校验）。
- 提现申请时执行预扣（available -> frozen）并写提现单与流水。

---

## 7. 财务/业绩模块当前能力（代码已实现）

财务控制器（新口径）：

- `POST /finance/dashboard/summary`
- `POST /finance/dashboard/trend`
- `POST /finance/dashboard/cost-structure`
- `POST /finance/records/list`

业绩控制器：

- `POST /performance/dashboard/overview`
- `POST /performance/dashboard/list`

仪表盘控制器：

- `GET /dashboard/revenue/overview`

---

## 8. 元数据字典当前能力

`POST /meta/enums` 已包含：

- 订单/派单状态
- 钱包/提现状态与业务类型
- 结算批次类型
- 扣时选项
- Action 文案字典（含历史兼容 key）

---

## 9. 前端（system-admin）联调事实

`config/config.ts`：

- 开发环境 `API_BASE=http://localhost:3000`
- 开发态通过 `/api` 代理到后端
- 生产态直连 `http://api.welax-tech.com`

`src/services/api.ts`：

- 已对接订单、钱包、提现、业绩、财务看板/明细等新接口。
- 仍保留一批历史/兼容接口（未必有后端实现）：
  - `/bills/*`
  - `/finance/reconcile/*`
  - `/orders/update-archived-progress`
  - `/orders/repair-wallet-by-settlements`

结论：前端 API 文件存在“新老并存”，开发时应优先使用已在后端实现的路由。

---

## 10. 与旧锚点的差异提示

- “所有接口统一 POST”在当前代码中并非完全成立：`auth/me`、`users` CRUD、`wallet` 查询、`dashboard/revenue/overview` 等为 `GET`/REST 风格。
- 项目已从“订单/结算主链”扩展到“钱包-提现-业绩-财务报表”完整闭环。
- 文档与代码的主要风险点已从“功能缺失”转为“前端历史接口残留导致误调”。

---

## 11. 建议的协作基线（从今天起）

1. 新需求默认以本快照为准，不再仅依据旧 `PROJECT_ANCHOR` 文案。
2. 新增接口时同步更新：
   - `server/docs/PROJECT_ANCHOR.md`
   - `server/docs/DEV_LOG.md`
   - `system-admin/src/services/api.ts`（清理废弃调用）
3. 涉及财务/钱包改动，必须同时验证：
   - settlement
   - wallet transaction
   - performance record
   - order finance record

