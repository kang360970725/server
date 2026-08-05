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
- 新增后台页面或岗位权限时，必须同步 `prisma/seed.ts` 权限种子、`system-admin/src/access.ts`、`system-admin/config/config.ts` 路由 access，以及后端 controller 的 `@Permissions`。

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
| 设备租赁费 | `src/equipment-rental-fee` | `EquipmentRentalContract`、`EquipmentRentalBill`、`WalletTransaction` | admin 设备租赁费、员工提现页待确认账单 |
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

## 权限模型

- 权限源在 `Permission.key`，角色通过 `Role.permissions` 绑定权限；登录态会把权限 key 下发给 `system-admin`。
- 页面级权限使用 `*:page` 或 `*:view/list` key，并由 `system-admin/src/access.ts` 映射成 `canView*`。
- 后端接口通过 `@Permissions(...)` 做同域保护；历史上部分页面复用 `system:role:page` 或 `finance:records:list`，新增岗位应优先使用细分权限，旧权限只作为兼容兜底。
- `prisma/seed.ts` 是权限树基线；`menu:*` 为目录节点，真实授权节点挂在对应菜单父级下。新增页面权限必须写入 seed 并设置 `parentKey`，否则新岗位在角色管理里无法分配，权限管理也看不出页面位置。
- 生产权限树同步已通过 Prisma migration 执行：`20260803013000_sync_permission_tree`。发布环境需要设置 `PRISMA_MIGRATE_DEPLOY=1`，由 `docker-entrypoint.sh` 在启动时执行 `npx prisma migrate deploy`。
- 当前已清理的旧页面权限：`users:page`、`dashboard:revenue:page`、`performance:staff:view`。`settlements:*`、`coupons:user-coupons:list` 虽无独立菜单，但后端仍使用，挂在“隐藏入口/接口保护”下保留。
- 用户管理页入口按 `users:member:page`、`users:staff:page`、`users:internal:page` 精确展示；普通 `ADMIN` 不再自动旁路看到全部用户域。“全部用户”入口默认隐藏。用户管理按钮级权限已经落地为可配置 `PermissionType.BUTTON`，并挂在对应页面节点下：会员页使用 `users:member:*:button`，打手页使用 `users:staff:*:button`，后台人员页使用 `users:internal:*:button`。
- 页面权限只控制入口；按钮权限控制动作。角色保存时后端会根据按钮权限自动补齐其父级页面权限，避免“只给按钮导致页面入口丢失”。后端 `UsersService` 仍会按目标用户类型做范围校验，角色要操作打手时必须同时拥有 `users:staff:page` 和对应打手按钮权限。打手管理顶部员工资金统计属于敏感汇总，只允许拥有 `users:staff:wallet-stats:button` 或 `SUPER_ADMIN` 展示和加载。
- 打手管理新增员工使用安全模式：前端默认并锁定 `STAFF`，后端非超管创建员工时固定绑定默认角色 `id=3/name=陪玩/description=俱乐部陪玩`，不接受任意 `roleId`、余额、押金、提现等敏感字段；新增和退店重新入店都必须选择员工标签。打手编辑时余额不可编辑；非超管只允许修改员工在职状态，且仅限“正常/冻结”，退店和黑名单必须走独立退店/清退流程。
- 员工评级候选读取接口 `GET /users/ratings/available` 是打手新增、编辑、升降级弹窗的基础数据依赖，不等同于评级管理 CRUD；路由必须声明在 `GET /users/:id` 前，权限允许用户管理页、打手新增/编辑/升降级按钮或 `staff-ratings:page` 读取。
- 订单模块按钮级权限已落地：客服工作台创建订单挂在 `orders:workbench:page` 下，订单列表创建/删除挂在 `orders:list:page` 下；订单详情所有业务按钮挂在 `orders:detail:page` 下，包括小票、确认收款、退款、编辑、派单/改派、修改实付、确认结单、客服代接/存单/结单、状态回退、更新参与者、结算调整、存单进度修复、重算订单结算。刷新、返回、纯导航不做按钮权限。
- 超级管理员语义已统一：`User.userType = SUPER_ADMIN` 或 `Role.name = SUPER_ADMIN` 都视为超管；`FINANCE_ADMIN` 已通过 migration `20260803033000_fix_super_admin_finance_role` 拆分/重命名为 `FINANCE_MANAGER`（财务管理员）。`FINANCE_MANAGER` 不再全局放行，必须依赖显式权限。
- `user-logs` 属于敏感审计数据，必须使用 `system:user-logs:page` 或历史系统管理员权限访问。
- 钱包域需要区分“本人钱包”和“后台管理钱包”：有效员工可访问自己的钱包概览/流水/提现申请；查询他人钱包流水、提现审批、人工保证金充值和保证金流水必须要求钱包/财务管理权限，避免普通登录用户通过 `userId` 参数越权。保证金全局核查使用 `wallet:deposit-reconciliation:page`，入口在 `system-admin` 的“钱包/保证金对账”；有效保证金口径为员工状态正常/冻结且当前保证金 > 0，无效/需处理包含退店、黑名单或无保证金员工。`MANUAL_DEPOSIT` 表示后台手动录入，业务上按线下收款对账。

## 环境与域名

- 生产后端 API 域名：`https://api.lmsdclub.cn`。
- 管理后台访问域名：`https://admin.lmsdclub.cn`。
- 管理后台生产请求域名在 `system-admin/config/config.ts` 注入，同时 `system-admin/src/app.tsx` 和 `system-admin/src/services/api.ts` 会读取 `process.env.API_BASE`。
- 小程序线上 API 基础地址在 `client-miniapp/src/services/config.ts` 的 `ONLINE_BASE_URL`。
- 服务端 CORS 默认白名单在 `src/main.ts`，包含 `https://admin.lmsdclub.cn`、`https://lmsdclub.cn`、`https://www.lmsdclub.cn`、`https://pc.lmsdclub.cn`；线上也可通过 `CORS_ORIGINS` 精确覆盖。

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
- `listOrders` 支持客户游戏 ID 模糊查询和 `orderMonth=YYYY-MM` 月份筛选，并返回不受分页影响的 `summary.receivableAmount/paidAmount`，用于后台查询消费时展示应付合计和实付合计。

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

### 线下费用

主文件：`src/offline-fee/offline-fee.service.ts`。

- 线下费用账单不再由 Cron 或提现校验自动生成。
- 只有管理员在 `system-admin` 财务线下费用页面选择月份并确认后，才调用 `offline-fees/bills/generate` 生成或更新该月账单。
- 提现前校验只检查已存在的上月线下费用账单；如果账单不存在，不会自动补生成。
- 账单生成对象只包含 `STAFF + OFFLINE + ACTIVE/FROZEN`，退店和黑名单员工不生成。
- 账单支持废除为 `WAIVED`；只有已废除且没有任何缴费记录的账单才允许删除，删除接口为 `offline-fees/bills/delete`。

### 设备租赁费

主文件：`src/equipment-rental-fee/equipment-rental-fee.service.ts`。

- 用于公司担保待租设备的线上陪玩租赁费用。
- `EquipmentRentalContract` 配置哪些 `STAFF + ACTIVE/FROZEN` 员工需要按月收租，不限制在线/离线；退店和黑名单员工不可配置。字段包含月租金额、起租日、结束日、启停状态；历史 `startMonth/endMonth` 仅作兼容字段，新增/编辑以 `startDate/endDate` 为准。
- `EquipmentRentalBill` 是每月账单；账单月份表示缴费月份，缴费日按起租日落到下一月，例如 8 月 15 日起租，第一张账单为 9 月账单，周期 8 月 15 日到 9 月 14 日，缴费日 9 月 15 日。
- 系统每月 1 日自动生成当月账单，也支持财务页面手动生成指定月份。
- 员工在自己的提现/钱包页面主动确认账单后扣费，财务后台也可对待确认账单手动缴费；扣费写 `WalletTransaction.bizType=EQUIPMENT_RENTAL_FEE`。
- 扣费允许 `availableBalance` 变负，但扣费后 `availableBalance + frozenBalance` 不能小于 0。
- 提现申请前会预留设备租赁费：已出未确认账单 + 下月即将产生账单。提现后总资产不足以覆盖时，不允许提交提现申请。
- 财务页面需要展示未确认账单的余额不足风险，使用账单行的 `insufficient` 标识。

### 员工生命周期

状态：`ACTIVE`、`FROZEN`、`EXITED`、`BLACKLISTED`。

- 受监控员工超过自动冻结周期未活跃会冻结，基准时间来自 `staffDormantFreezeBaseAt`、最后接单时间或创建时间；周期由员工规则引擎 `dormantFreezeDays` 控制，未命中规则走默认规则，默认 7 天。
- `FROZEN` 会限制普通功能，但 `UserStatusGuard` 允许钱包相关接口访问。
- `EXITED` 不具备派单资格，但可提现退店释放后的可用余额。
- `EXITED` 不能再次执行退店、清退或退店预览；后端接口需要拒绝重复生命周期动作。
- `BLACKLISTED` 不应再入店或提现。
- 后台新增员工时，只有身份类型为 `STAFF` 会触发重新入店限制；手机号、真实姓名、身份证号任一命中历史员工账号，都视为重复员工。
- 重复员工如果不是 `EXITED`，拒绝重复入店；如果是 `BLACKLISTED`，永远拒绝重新入店。
- `EXITED` 员工重新入店会复用原用户账号。未满 `staffCooldownUntil` 或员工规则引擎 `quitCoolingDays` 计算出的退店冷却期时，后端返回 `STAFF_REJOIN_COOLDOWN_CONFIRM_REQUIRED`，管理端必须二次确认风险后携带 `forceRejoin=true` 才能继续。
- 已满退店冷却期的 `EXITED` 员工可直接重新入店；重新入店会清零钱包中的所有正数余额字段（可用、冻结、接单冻结、提现冻结、保证金），负数余额不处理。
- 是否属于派单监控员工由 `src/common/utils/staff-role-scope.util.ts` 判断，不是只看 `userType`。

员工规则引擎：

- 后端：`src/system-config/staff-rule-engine.service.ts`
- 配置 API：`system-configs/staff-rule-engine/get|upsert`
- 影响：保证金金额、首次提现最低保留、首次提现需接单满 N 天、退店冷却期、保证金不退天数、自动冻结周期。
- 配置结构：`defaultRule` 是未配置/未命中员工的兜底规则；`rules[]` 与 `tags[]` 一对一绑定，新保存配置时一条规则必须且只能关联一个标签。
- `firstWithdrawMinAcceptedDays` 缺省值为 15，用于兼容旧配置；提现校验在 `src/wallet/wallet-withdrawals.service.ts`。
- `dormantFreezeDays` 缺省值为 7；历史多标签规则读取兼容，但后台保存会要求拆成一对一标签规则。

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
