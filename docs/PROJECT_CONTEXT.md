# BlueCat Server 项目上下文

> 新会话优先读取本文。本文是基于当前代码整理的 `server` 上下文地图；同目录旧文档可能是历史记录，存在漂移。

## 项目定位

`server` 是 BlueCat 的 NestJS + Prisma 后端服务：

- 为 `system-admin` 提供后台、客服、打手工作台、财务、运营管理 API。
- 为 `client-miniapp` 提供 `/mini/*` 小程序 API。
- 承载核心资金与履约状态：订单、派单、结算、钱包、提现、会员资产、罚单、线下费用。

关键入口：

- 应用模块：`src/app.module.ts`
- 数据模型：`prisma/schema.prisma`
- 全局 Guard 顺序：`JwtAuthGuard` -> `UserStatusGuard` -> `PermissionsGuard`
- PrismaService 导入存在历史差异：多数模块使用 `src/prisma/prisma.service.ts`，钱包/用户等也有 `src/prisma.service.ts`。改文件前先看当前模块的本地导入风格。

## 高风险改动规则

任何业务改动先判断影响域，不要只看一个 controller：

- 订单生命周期改动会影响 `orders`、`wallet`、`performance`、`finance`、`notifications`、`mini/orders`，通常还会影响 `member`。
- 结算改动会影响 `OrderSettlement`、`WalletTransaction`、`WalletHold`、`PerformanceRecord`、`OrderFinanceRecord`、`SettlementBatch`。
- 钱包/提现改动会影响 `wallet`、`wallet-withdrawals`、`offline-fee`、`users` 退店、`system-admin` 钱包页面，可能影响 mini 钱包展示。
- 员工状态改动会影响登录 Guard、工作台访问、派单资格、提现、退店/清退、线下费用、罚单。
- 会员充值/支付改动会影响 `member`、`mini/member`、`wechat-pay`、`wallet`、优惠券、成长值/积分。
- 小程序内容配置改动会影响 `system-config`、`mini/home`、`game-project`、`miniapp-protocols`、`notifications`。

定位链路应按：controller -> service -> Prisma models -> 钱包/日志/通知副作用 -> 前端页面。

## 模块地图

| 业务域 | 后端文件 | 主要模型 | 前端入口 |
|---|---|---|---|
| 登录/会话 | `src/auth`、`src/mini/mini-auth.controller.ts` | `User`、`Role`、`Permission`、`UserWechatBinding` | admin 登录/重置，小程序登录/资料 |
| 用户/员工 | `src/users` | `User`、`StaffRating`、`WalletAccount`、`MemberGameCard` | admin 用户、打手管理、退店、钱包抽屉 |
| 权限/角色 | `src/permission`、`src/role` | `Role`、`Permission` | admin 角色/权限 |
| 商品/菜单 | `src/game-project`、`src/system-config` 商品配置 | `GameProject`、`ProductReview`、`SystemConfig` | admin 商品/分类/标签，公开菜单，小程序首页/搜索/详情 |
| 订单/派单 | `src/orders`、`src/mini/mini-orders.controller.ts` | `Order`、`OrderDispatch`、`OrderParticipant`、`OrderSettlement`、`OrderPayment`、`OrderRefund`、`ComplaintWorkOrder` | admin 订单/客服工作台/打手工作台，小程序订单 |
| 结算/批次 | `src/settlements`、订单结算方法 | `OrderSettlement`、`SettlementBatch` | admin 结算、订单详情 |
| 钱包/提现 | `src/wallet` | `WalletAccount`、`WalletTransaction`、`WalletHold`、`WalletWithdrawalRequest`、`WalletDepositTransaction`、`WalletAnomalyIgnore` | admin 钱包、提现审批、员工钱包 |
| 会员资产 | `src/member`、`src/mini/mini-member.controller.ts` | `MemberProfile`、`MemberPointAccount`、`MemberPointTransaction`、`MemberRechargePlan`、`MemberRechargeOrder`、`MemberGameCard` | admin 会员等级/充值方案/用户，小程序会员/钱包/充值/积分 |
| 优惠券 | `src/coupons`、`src/mini/mini-coupons.controller.ts` | `CouponTemplate`、`UserCoupon`、`OrderDiscount` | admin 优惠券，小程序领券/卡券/下单 |
| 财务/业绩 | `src/finance`、`src/performance`、`src/dashboard` | `OrderFinanceRecord`、`PerformanceRecord`、订单/结算/钱包模型 | admin 财务看板/明细、业绩看板 |
| 线下费用 | `src/offline-fee` | `OfflineFeeBill`、`OfflineFeeBillPayment` | admin 线下费用，提现前校验 |
| 罚单 | `src/penalties` | `PenaltyRule`、`PenaltyTicket`、`PenaltyTicketDetail`、`PenaltyAppeal`、`PenaltyFundPool`、`PenaltyFundFlow` | admin 罚单，员工罚单 |
| 通知/公告 | `src/notifications` | `SystemAnnouncement`、`SystemAnnouncementRead`、`UserNotification`、`CsDutySchedule`、`CsDutyLeave` | admin 公告/当班客服/测试推送，前端实时通知，小程序公告 |
| 小程序协议 | `src/miniapp-protocols` | `MiniappProtocolCategory`、`MiniappProtocol` | admin 协议配置，小程序协议弹窗/内容 |
| 版本 | `src/app-version` | 版本配置相关模型 | admin 版本迭代 |
| 宝盒活动 | `src/chest` | `Chest*` 模型 | admin 宝盒、公开活动页、移动宝盒 |
| 问卷 | `src/questionnaire` | `Questionnaire*` 模型 | admin 问卷、员工问卷 |

## API 表面

后台/员工端 API：

- `auth`：注册、登录、当前用户、刷新 token。
- `users`：用户 CRUD、退店/退店预览/清退、员工钱包统计、打手选项、工作模式/状态、会员游戏名片、提现二维码重置、密码。
- `orders`：列表/详情/创建/更新/删除、派单/存单/结单/管理员代接/回滚/拒单、标记支付、修改实付、退款、客诉、我的派单/统计、结算修复/重算工具。
- `wallet`：账户、流水、冻结单、重放预览、异常修复/回滚、提现二维码、手动保证金、保证金流水。
- `wallet/withdrawals`：申请提现、提现信息、我的提现、待审核、全量列表、对账汇总、审核。
- `member`：等级、充值方案、积分/成长值调整、手动充值、积分流水。
- `game-project`：商品 CRUD、选项、上传信息、公开菜单、评分/评价。
- `system-configs`：通用配置、小程序首页配置、商品分类/标签配置、员工规则引擎。
- `miniapp-protocols`：协议分类/协议 CRUD，公开读取。
- `notifications`：公告、当班客服、请假、我的通知、实时通知清除、测试推送。
- 其他：`coupons`、`penalties`、`finance`、`performance`、`dashboard`、`settlements`、`roles`、`permissions`、`staff-ratings`、`app-version`、`chest`、`questionnaires`、`user-logs`。

小程序 API：

- `mini/auth`：手机号登录、微信登录、当前用户、刷新 token、补全资料。
- `mini/home`：已发布首页配置、游戏分类、分类树。
- `mini/projects`：商品列表、详情、评价。
- `mini/orders`：列表、详情、创建、取消、退款、确认完成、确认支付、微信预支付、同步支付、支付通知、评价、售后、订阅消息。
- `mini/member`：会员概览、充值方案、积分、游戏名片、微信绑定、充值创建/预支付/通知。
- `mini/wallet`：账户、流水。
- `mini/coupons`：领券中心、我的卡券、领取。
- `mini/announcements`：公告详情。

## 核心业务流

### 订单与派单

主服务：`src/orders/orders.service.ts`。

关键模型：

- `Order`：订单来源、客户/会员、支付字段、生命周期、应收/实收/最终金额。
- `OrderDispatch`：派单轮次，支持多轮。
- `OrderParticipant`：被派员工、接单状态、进度。
- `OrderSettlement`：每个参与者最终收益。

重要副作用：

- 通过 `WalletService` 创建/更新收益流水和冻结单。
- 创建业绩记录和财务记录。
- 关键动作写 `UserLog`。
- 发送后台通知和小程序订阅消息。
- 支付后可能累计会员积分/成长值。

结算计算相关：

- `src/utils/orderDispatches/revenueInit.ts`
- `src/utils/orderDispatches/settlement-freeze.rule.ts`
- `src/utils/finance/generateRepairPlan.ts`

派单轮次与结算规则：

- 结算重建会按轮次遍历订单所有 `OrderDispatch`，不是只看当前轮。
- 已存单的历史 `ARCHIVED` 轮次如果没有有效结算参与者，应跳过，不应阻断最终结单；常见来源是回退、换人、异常修复后留下的空历史轮。
- 当前结单 `COMPLETED` 轮次必须有有效打手，否则不能生成收益归属，必须报错。
- 有效结算参与者口径在 `revenueInit.ts`：`userId` 有效、未拒单；`ARCHIVED/COMPLETED` 轮次还必须有 `acceptedAt`。
- 存单/结单入口在 `orders.service.ts` 的 `archiveDispatchWithOptions`，当前轮必须存在活跃且未拒单的参与者；客服强制存/结单会为活跃参与者补齐 `acceptedAt`。

### 钱包与提现

主文件：

- `src/wallet/wallet.service.ts`：账户桶、收益、冻结、重放、审计、修复。
- `src/wallet/wallet-withdrawals.service.ts`：提现申请/审核/列表。
- `src/wallet/wallet.deposit.service.ts`：保证金账本。
- `src/wallet/wallet-account-buckets.util.ts`：余额桶标准化。

余额桶规则：

- `availableBalance`：可用余额，可消费/可提现。
- `earningFrozenBalance`：订单结算收益冻结。
- `withdrawFrozenBalance`：提现申请占用冻结。
- `frozenBalance`：历史聚合冻结，应与收益冻结 + 提现冻结对齐。
- `depositBalance`：员工保证金账户，不是普通可用余额。

提现申请流程：

1. 必要时自动冻结长期未活跃的受监控员工。
2. 校验提现二维码和 `canWithdraw`；退店员工可以提现已释放到可用余额的钱。
3. 校验每日/每周提现次数。
4. 首次提现限制和 10% 自动补保证金只适用于 `STAFF + ACTIVE`。
5. `OFFLINE` 员工可能需要先/同步补缴线下费用。
6. 余额变更：`availableDelta=-amount`、`depositDelta=depositAdd`、`withdrawFrozenDelta=withdrawAmount`。
7. 只有 `depositAdd > 0` 时写保证金流水。
8. 创建提现申请和提现预扣流水。

退店逻辑在 `src/users/users.service.ts`：释放冻结资金和可退保证金到可用余额。任何提现/保证金改动都必须验证 `EXITED` 员工行为和 admin 端提现预览。

### 员工生命周期

状态：`ACTIVE`、`FROZEN`、`EXITED`、`BLACKLISTED`。

- 受监控员工 7 天未活跃会冻结，基准时间来自 `staffDormantFreezeBaseAt`、最后接单时间或创建时间。
- `FROZEN` 会限制普通功能，但 `UserStatusGuard` 允许钱包相关接口访问。
- `EXITED` 不具备派单资格，但可提现退店释放后的可用余额。
- `BLACKLISTED` 不应再入店或提现。
- 是否属于派单监控员工由 `src/common/utils/staff-role-scope.util.ts` 判断，不是只看 `userType`。

员工规则引擎：

- 后端：`src/system-config/staff-rule-engine.service.ts`
- 配置 API：`system-configs/staff-rule-engine/get|upsert`
- 影响：保证金金额、首次提现最低保留、首次提现需接单满 N 天、退店冷却期、保证金不退天数。
- `firstWithdrawMinAcceptedDays` 缺省值为 15，用于兼容旧配置；提现校验在 `src/wallet/wallet-withdrawals.service.ts`。

### 会员与支付

`MemberService` 负责：

- 会员资料、等级、成长值。
- 积分账户与积分流水。
- 充值方案和充值订单。
- 会员游戏名片。
- 充值赠送优惠券。

小程序支付：

- 微信支付封装：`src/mini/wechat-pay.service.ts`
- 订单创建/预支付/同步/通知：`src/mini/mini-orders.controller.ts`
- 会员充值创建/预支付/通知：`src/mini/mini-member.controller.ts`
- 存在测试支付字段；累计会员权益时必须区分真实支付与测试支付。

### 小程序内容

后台维护内容：

- 首页配置：`SystemConfig`，通过 `system-configs/miniapp/home-config/*` 管理。
- 商品/分类/标签：`GameProject` + 商品分类/标签系统配置。
- 协议：`MiniappProtocol*`。
- 公告：`SystemAnnouncement`。
- 优惠券：`CouponTemplate`、`UserCoupon`。

小程序公开读取：

- `mini/home/*`
- `mini/projects/*`
- `miniapp-protocols/public*`
- `mini/announcements/:id`
- `mini/coupons/*`

## Prisma 模型分组

- 身份/权限：`User`、`Role`、`Permission`、`UserWechatBinding`
- 员工/商品：`StaffRating`、`GameProject`、`ProductReview`
- 订单域：`Order`、`OrderPayment`、`OrderRefund`、`ComplaintWorkOrder`、`OrderDiscount`、`OrderDispatch`、`OrderParticipant`、`OrderSettlement`、`OrderPlayerEvaluation`、`SettlementBatch`
- 钱包域：`WalletAccount`、`WalletTransaction`、`WalletHold`、`WalletWithdrawalRequest`、`WalletAnomalyIgnore`、`WalletDepositTransaction`
- 会员域：`MemberProfile`、`MemberGameCard`、`MemberLevelConfig`、`MemberPointAccount`、`MemberPointTransaction`、`MemberRechargePlan`、`MemberRechargeOrder`、`Recharge`
- 财务/业绩：`PerformanceRecord`、`OrderFinanceRecord`
- 运营/内容：`SystemConfig`、`MiniappProtocolCategory`、`MiniappProtocol`、`CouponTemplate`、`UserCoupon`、`SystemAnnouncement`、`SystemAnnouncementRead`、`UserNotification`、`CsDutySchedule`、`CsDutyLeave`、`Chest*`、`Questionnaire*`
- 合规/费用：`OfflineFeeBill`、`OfflineFeeBillPayment`、`Penalty*`

## 跨项目定位

用户提到后台页面时，优先读：

- `../system-admin/docs/PROJECT_CONTEXT.md`
- `../system-admin/config/config.ts`
- `../system-admin/src/services/api.ts`
- 具体页面：`../system-admin/src/pages/...`

用户提到小程序时，优先读：

- `../client-miniapp/docs/PROJECT_CONTEXT.md`
- `../client-miniapp/src/app.config.ts`
- `../client-miniapp/src/services/*`
- 具体页面：`../client-miniapp/src/pages/...`

## 验证方式

- 后端定向测试：`yarn test <spec> --runInBand`
- 后端构建：`yarn build`
- 后台构建：在 `../system-admin` 执行 `yarn build:dev` 或目标环境构建。
- 小程序构建：先查看 `../client-miniapp/package.json`，再运行对应 Taro 构建命令。

开始前先看工作区状态。当前项目可能存在 questionnaire 相关未提交改动，通常与其他任务无关。
