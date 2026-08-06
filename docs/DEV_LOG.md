# 🧭 蓝猫陪玩系统 · 开发日志（DEV_LOG）

> 目的：
> - 记录关键设计变更、决策背景、功能里程碑
> - 作为人类 + AI 的长期记忆补充
> - 新会话可快速扫一遍，恢复项目脉络

---

## 2026-08-06 ｜后台前端体验与移动端显示优化

### 本次动作
- `system-admin` 订单列表已补充移动端访问优化：移动端优先呈现订单核心内容，降低表格横向阅读成本。
- 侧边栏左下角用户中心改为稳定 `menuFooterRender` 渲染，宽屏和窄屏均保留用户入口，折叠时仅展示头像，避免被消息中心/公告中心挤掉。
- 公告中心弹窗改为左侧列表 + 右侧详情布局，支持选中公告、查看正文、标记已读；左侧列表宽度已缩窄到 256px。
- 登录页和后台页备案展示模块已调整：ICP备案固定底部展示，登录页首屏可见，后台 PC 端和移动端避免被内容遮挡，移动端全屏页面自动隐藏。
- 创建订单共用弹窗 `../system-admin/src/pages/Orders/components/OrderForm.tsx` 已限制视口高度：弹窗顶部固定留白，表单主体内部滚动，底部保存/取消按钮保持可见；订单列表、订单详情、客服工作台三处创建/编辑入口同步生效。

### 验证
- `yarn build:dev`

---

## 2026-08-06 ｜资金安全审计与小程序支付收敛

### 本次动作
- 收敛小程序订单资金入口：自助创建订单不再接受客户端 `isPaid/isGifted/customClubRate/paidAmount/receivableAmount` 改写，金额按服务端项目价格与数量计算，订单创建后保持待支付。
- 修复小程序余额支付确认风险：`mini/orders/:id/pay-confirm` 不再使用 body 传入金额，而是读取订单 `finalPayableAmount/paidAmount/receivableAmount` 作为支付扣款基数，阻断 0 元或低金额伪支付。
- 提现申请与审核增加事务行锁：申请锁定 `wallet_accounts`，审核先锁定 `wallet_withdrawal_requests` 再锁定钱包账户，避免并发重复冻结、重复释放或重复扣除提现冻结余额。
- 提现幂等键增加非空与 64 字符长度校验；重复 `userId + idempotencyKey` 提交直接返回原提现单，不再次改余额。
- 客诉工单原生 SQL 更新 helper 增加列名白名单，避免未来调用时将用户可控字段名拼接进 SQL。

### 验证
- `npm run build`
- `npm test -- wallet-withdrawals.service.spec.ts --runInBand`
- `git diff --check`

---

## 2026-08-06 ｜安全模块第一阶段：订单结算超额拦截

### 本次动作
- 订单维度新增结算安全校验：`OrderSettlement.finalEarnings` 正向收益合计不得超过有效结算安全基数，订单结算金额优先取 `settlementBaseAmount`，历史数据兜底 `paidAmount/receivableAmount/originalAmount`。
- 有效结算安全基数已包含炸单负收益补偿额度，避免 `CARRY_COMPENSATION` 补偿单被误判为超额；客服分红、续单分红按既有独立分红口径计入有效基数。
- 校验已覆盖首次确认结单、订单重算修复、人工调整结算收益，以及旧派单完成直接 upsert `OrderSettlement` 的路径。
- 超额时直接抛出 `订单结算安全拦截` 错误，事务回滚，不落库结算记录，也不保留钱包流水影响。
- 负收益只作为扣减/炸单处理，不参与“正向收益合计”放大，但会作为炸单补偿额度上浮有效安全基数；续单分红发放前也会以额外正向支出和额外允许额度纳入校验；校验口径聚焦系统实际发放成本是否突破有效结算基数。

### 后续仍需推进
- 全量代码安全审计：SQL 注入、接口越权、参数污染、恶意构造请求增加余额或破坏资金数据。
- 数据安全巡检：设计定期核查钱包余额、结算流水、冲正流水、订单财务记录一致性的任务与告警。

---

## 2026-08-06 ｜订单续单归因与分红后端落地

### 本次动作
- 新增续单组合归因模型 `OrderRenewalGroup` 与续单分红明细 `OrderRenewalBonus`；迁移为 `20260806103000_add_order_renewal_bonus`。
- 创建订单首轮派单支持 `isRenewal`、`renewalPlayerIds`；续单打手必须从当前派单打手中选择，且续单订单推荐人强制失效。
- 派单人数仍按当前产品限制控制为 1~2 人，避免客服误操作多选。
- 续单分红配置 key 为 `order_renewal_bonus_rules`；默认实付金额 `<=300` 按 1%，`>300` 按 2%，配置失效时按该规则兜底。
- 客服确认结单时处理续单：默认确认有效并发放 `ORDER_RENEWAL_BONUS` 可用余额流水，也支持 `renewalAction=INVALIDATE` / `invalidateRenewal=true` 将续单置无效。
- 退款与重算支持续单冲正：全额退款或重算置无效时，已发放续单分红生成 `ORDER_RENEWAL_BONUS_REVERSAL` 冲正流水并记录原因。

### 前后端已落地
- `../system-admin/src/pages/CSWorkbench/index.tsx`、`../system-admin/src/pages/Orders/index.tsx`：创建订单/派单区域增加续单开关与续单打手多选，选项来源于当前派单打手；开启续单后禁用并清空推荐人。
- `../system-admin/src/pages/Orders/Detail.tsx`：确认结算页面展示续单组合、预计分红，支持确认有效或置为无效并填写原因。
- `../system-admin/src/services/api.ts`：补充创建订单、确认结算、重算修复相关请求字段类型。

---

## 2026-08-06 ｜后续计划：安全模块

### 下一步计划
- 订单结算安全校验已完成第一阶段，详见上方“安全模块第一阶段：订单结算超额拦截”。
- 代码安全审计：检查整体代码是否存在 SQL 注入、接口越权、参数污染、恶意构造请求导致余额异常增加或数据损害等风险。
- 数据安全巡检：评估并设计定期核查功能，周期性检查钱包余额、结算流水、冲正流水、订单财务记录之间是否一致，发现异常时生成告警/报告，避免资金数据长期不一致。

---

## 📅 2025-12-21 ｜v0.1 基础架构与订单系统落地

### 🎯 阶段目标
- 搭建稳定的全栈基础架构
- 完成核心：用户、项目、订单、派单、结算模型
- 为后续复杂业务（结算批次、手机端派单）打好基础

---

### 🧱 技术选型确认
- 后端：NestJS + Prisma + MySQL
- 前端：Umi Max + Ant Design Pro
- 鉴权：JWT
- ORM：仅 Prisma，不混用

---

### 👤 Users 模块
✅ 完成内容：
- 用户 CRUD
- 用户类型：SUPER_ADMIN / ADMIN / STAFF / 客服 / 财务 / REGISTERED_USER
- StaffRating 评级体系
- UserLog 操作日志
- 陪玩工作状态：
    - IDLE（空闲）
    - WORKING（接单中）
    - RESTING（休息）

📝 决策：
- 陪玩状态用于客服派单筛选
- 接单 → WORKING；结/存单 → IDLE；手动休息 → RESTING

---

### 🎮 GameProject 模块
✅ 完成内容：
- 菜单项目 CRUD
- 支持字段：
    - type（体验单/护航/福袋等）
    - billingMode（HOURLY 小时单 / GUARANTEED 保底单）
    - baseAmount（保底）
    - clubRate（俱乐部固定抽成）
- 前后端对接完成

📝 决策：
- 项目作为订单必选项
- 项目会变动，订单需保存 projectSnapshot

---

### 📦 Orders 模块 v0.1
✅ 完成内容：
- 模型设计：
    - Order
    - OrderDispatch（多轮派单）
    - OrderParticipant（陪玩参与者）
    - OrderSettlement（结算明细）

- 能力：
    - 新建订单
    - 派单 / 接单 / 存单 / 结单
    - 多轮派单（存单后可再派）
    - currentDispatch 指向当前批次
    - 小时单自动计算时长
    - 保底单填写 progressBaseWan
    - 自动结算落库
    - 体验单 3 天结算、正价单月结

📝 关键决策：
- 不使用旧 Bill / BillPlayer / BillSettlement，全部删除重构
- 所有接口统一 POST
- 默认 v0.1：
    - 最多 2 陪玩
    - 收益均分
- 抽成优先级：
  customClubRate > 项目 clubRate

---

### ⏱ 小时单计费规则确认
- 由：接单时间 → 存/结单时间 自动计算
- 分钟折算规则：
    - <15 分钟 = 0 小时
    - 15~45 分钟 = 0.5 小时
    - >45 分钟 = 1 小时
- 支持中途扣除时间：10/20/30/40/50/60 分钟

---

### 💰 保底单结算规则确认
- 按 progressBaseWan / baseAmountWan × paidAmount 计算
- 允许负数（炸单）
- 不得超过订单保底，超过需提示结单

---

### 🔐 权限与审计
📝 决策：
- 关键操作必须记录 UserLog：
    - 派单 / 换陪玩
    - 结算 / 打款
    - 单陪玩收益手动修改
    - 评级调整

---

### 🧾 枚举字典方案
📝 决策：
- 后端统一接口：POST /meta/enums
- 前端启动时加载，用于状态展示

---

### 🖥 前端进展
✅ 已完成：
- GameProject 管理页
- Orders：列表 / 新建 / 详情 基础对接

🚧 正在进行：
- 新建订单页：
    - 可直接派单
    - 项目/陪玩支持搜索
    - 默认仅选 IDLE 陪玩
    - 紧凑排版 + 默认当前时间

- 订单详情页：
    - 当前参与者展示
    - 派单/更新参与者
    - 可修改实付金额
    - 状态字典展示

---

### 🛡 工程级抗中断方案落地
新增 docs：
- PROJECT_ANCHOR.md（项目长期记忆）
- PROMPT.md（新会话启动口令）
- MODULE_CONTEXT.md（模块上下文模板）
- DEV_LOG.md（开发日志）

📝 决策：
- 新会话必须先加载锚点文档
- DEV_LOG 记录每个阶段关键变化

---

## ⏭ 下一步计划（v0.2）

- 完成订单详情页交互与派单优化
- 完成新建订单页紧凑高效版本
- 接通陪玩“我的接单记录”
- 开始设计：
    - 手机端派单流程
    - 结算管理页面
    - 财务打款流程

---
## 2025-12-24 ｜v0.2 订单详情、结算规则与工作台重构

### 阶段目标
- 完善订单详情页交互与展示历史参与者
- 强化结算算法（按评级分红比例/订单抽成/项目抽成）
- 支持补收后按贡献重算
- 增加退款流程与订单可编辑能力
- 打磨打手工作台与派单状态控制
- 统一前端存/结单实时计算与校验

---

### Orders 与结算核心改进

#### 结算逻辑升级
- 单次派单 + 结单：直接按订单实付金额均分
- 抽成计算优先级完善：
    1) 订单固定抽成（customClubRate）
    2) 项目固定抽成（project.clubRate）
    3) 陪玩评级分红比率（staffRating.rate）
- 小时单补收后按贡献（contributionAmount）重算 settlements
- 保底单存单需输入总进度，并实时计算剩余与均分

#### 多轮派单与历史展示
- OrderDetail 支持展示历史所有 dispatch 与参与者
- 派单历史、参与者贡献与实际收益清晰可查
- 订单详情可调整实付金额 & 实际收益（手动奖惩）

---

### 订单增强功能

#### 退款流程
- 订单任意阶段支持退款
- 退款后状态变为 REFUNDED（强终态）
- 已结单退款需清零对应陪玩收益并写入调整日志
- 输入退款原因用于审计

#### 编辑订单（未结单可）
- 修改订单字段（除陪玩字段）
- 支持变更项目、保底、应收/实付等
- 变更同步 projectSnapshot 与抽成快照
- 编辑操作写入 UserLog

---

### 打手工作台与我的接单记录

#### 工作台交互提升
- 存单 / 结单弹窗按计费模式展示实时计算
- 保底单结单默认结算剩余保底，不再需要打手输入
- 小时单存/结单支持扣时选项同步后端 enums

#### 派单状态 UI 控制
- 派单按钮根据当前 dispatch 状态置灰/禁用
- 派单逻辑按状态安全控制
- 已接单不可修改参与者，需先存单再派

#### 我的接单记录
- 实现 listMyDispatches / listMySettlements API
- 陪玩端可查看自己参与的派单与结算明细

---

### 前端细节与实时计算

#### 订单详情页优化
- 增加历史参与者信息与收益表格
- 可编辑实付金额/备注
- 显示订单保底、已打/剩余数据
- 实时计算存/结单字段校验

#### 新建订单页
- 选择项目时自动同步保底字段
- 支持直接派单与筛选空闲打手
- 紧凑版表单与默认当前时间

---

### 工程协作与抗中断

#### 文档体系强化
- 完整维护 PROJECT_ANCHOR.md
- 补充模块上下文模板（MODULE_CONTEXT.md）
- 抗中断 Prompt（PROMPT.md）
- 本日志（DEV_LOG.md）记录每阶段设计与演进

---

### 下阶段规划（v0.3）
- H5 派单流程（微信可访问）
- 结算管理页面
- 财务打款、批量审批流程
- 打手端 UI 迭代与体验提升

---

## 2026-04-10 ｜代码事实盘点与文档补全

### 本次动作
- 全量复查 `server` 与 `system-admin` 当前代码。
- 新增代码快照文档：`docs/CODEBASE_SNAPSHOT_2026-04-10.md`。

### 补全的关键事实
- 后端已形成“订单 + 钱包 + 提现 + 业绩 + 财务”闭环，不再只是 v0.2 的订单强化阶段。
- `OrdersService` 已实现结算后重建：
  - `PerformanceRecord`
  - `OrderFinanceRecord`
- 钱包提现规则已落地（次数限制、首次提现限制、预扣冻结）。
- 全局 Guard 顺序已固定：`JWT -> UserStatus -> Permissions`。

### 识别到的接口漂移风险
- 前端 `system-admin/src/services/api.ts` 仍保留历史接口调用（如 `/bills/*`、`/finance/reconcile/*`、`/orders/update-archived-progress`、`/orders/repair-wallet-by-settlements`）。
- 当前后端主用财务接口为：
  - `/finance/dashboard/*`
  - `/finance/records/list`

### 后续建议
- 以 `CODEBASE_SNAPSHOT_2026-04-10.md` 作为当前会话/新需求的事实基线。
- 后续每次新增模块或接口，按同样方式补一条 DEV_LOG 记录，避免文档再次滞后。

---

## 2026-08-03 ｜用户管理权限树与店长打手操作修正

### 本次动作
- 权限树数据通过 Prisma migration `20260803013000_sync_permission_tree` 随发布执行，废弃独立手工 SQL 文件。
- `menu:*` 仅作为权限树目录节点，角色保存时过滤，不写入角色授权。
- 用户管理入口按 `users:member:page`、`users:staff:page`、`users:internal:page` 精确展示，“全部用户”入口隐藏。

### 店长紧急开放范围
- 拥有 `users:staff:page` 的角色可进入打手管理。
- 该角色可对 STAFF 执行编辑基础资料、升降级、退店、清退。
- 分配角色、重置密码、删除用户、创建用户、会员资产类操作仍仅 `SUPER_ADMIN` 可执行。
- 后端 `UsersService` 同步校验目标用户必须是 STAFF，避免仅靠前端按钮控制。

### 后续原则
- 已发布的 migration 不删除；后续权限增删改一律新增 Prisma migration 做幂等 DML，并同步 `prisma/seed.ts` 与上下文文档。

---

## 2026-08-04 ｜保证金对账查询

### 本次动作
- 新增后端接口 `GET /wallet/deposit-reconciliation`，用于全局查询员工保证金对账数据。
- 新增页面权限 `wallet:deposit-reconciliation:page`，并通过 migration `20260804001000_add_wallet_deposit_reconciliation_permission` 写入权限树，同时授权给 `SUPER_ADMIN` 与 `FINANCE_MANAGER`。
- `system-admin` 新增“钱包/保证金对账”页面，支持按员工状态、保证金状态、是否线下手动录入、关键词筛选。
- 页面展示当前保证金、规则应交、差额、线下手动录入金额、保证金净变动、流水数、最近流水，方便核对有效/无效保证金及退店/黑名单员工。
- 对账口径：正常/冻结员工且当前保证金 > 0 视为有效；退店/黑名单或无保证金归为无效/需处理；`MANUAL_DEPOSIT` 视为线下收款手动录入。

---

## 2026-08-05 ｜新增打手评级下拉权限修复

### 本次动作
- 修复 `GET /users/ratings/available` 路由声明位置，放到 `GET /users/:id` 前，避免 `ratings` 被动态 ID 路由截获导致新增打手弹窗无法加载评级。
- 评级候选读取权限扩展为用户管理页、打手新增/编辑/升降级按钮或 `staff-ratings:page` 均可访问；店长拥有新增打手权限时可正常选择评级，但不会获得评级管理 CRUD 权限。

---

## 2026-08-05 ｜保证金对账权限收敛

### 本次动作
- 修复保证金对账前端 access，`/wallet/deposit-reconciliation` 入口只受 `wallet:deposit-reconciliation:page` 控制，不再通过 `wallet:withdrawals:page` 或 `finance:records:list` 兜底展示。
- 修复后端 `GET /wallet/deposit-reconciliation` 接口权限，只允许 `wallet:deposit-reconciliation:page` 或 `SUPER_ADMIN` 访问，避免直接请求接口绕过页面专用权限。

---

## 2026-08-05 ｜保证金手动缴纳统计口径修正

### 本次动作
- 明确保证金“手动缴纳”按保证金专用流水 `WalletDepositTransaction.bizType = MANUAL_DEPOSIT` 识别，不把提现自动补押金 `WITHDRAW_PERCENT` 计入线下手动录入。
- 保证金对账统计兼容历史旧表 `WalletDepositTransaction` 与当前表 `wallet_deposit_transactions`，手动缴纳金额、手动笔数、总净变动、最近保证金流水和最近手动录入人统一按两张表合并口径计算。

---

## 2026-08-03 ｜打手新增编辑安全边界与按钮父级权限修复

### 本次动作
- 角色保存时后端自动补齐按钮权限的父级页面权限，并通过 migration `20260803034500_staff_user_security_and_permission_parent` 修复已有角色数据，避免只分配按钮后页面入口丢失。
- 确保默认陪玩角色 `id=3/name=陪玩/description=俱乐部陪玩` 存在；非超管创建员工时后端固定绑定该角色，防止通过新增打手分配后台角色越权。
- 新增员工和退店重新入店都强制要求员工标签，保证押金、提现、冷却期、自动冻结等规则有匹配依据。
- `system-admin` 打手管理新增弹窗默认并锁定员工身份，员工标签必选，余额不可编辑；打手列表不再展示“分配角色”按钮。
- 打手编辑增加安全锁：余额不可编辑；非超管只能修改员工在职状态，且仅限正常/冻结，退店和黑名单仍必须走独立退店/清退流程。

---

## 2026-08-03 ｜SUPER_ADMIN 与 FINANCE_ADMIN 冲突修复

### 本次动作
- 新增 Prisma migration `20260803033000_fix_super_admin_finance_role`，随发布创建/补齐 `SUPER_ADMIN` 角色，将非超管历史 `FINANCE_ADMIN` 角色用户迁移到 `FINANCE_MANAGER`，并删除旧 `FINANCE_ADMIN` 角色。
- `SUPER_ADMIN` 是唯一超级管理员角色；`FINANCE_MANAGER` 回归财务管理员，预置财务、钱包和必要订单权限，不再享受全局权限旁路。
- 后端 `PermissionsGuard`、钱包、订单、用户、会员等按钮/服务权限判断统一支持 `userType=SUPER_ADMIN` 或 `roleName=SUPER_ADMIN`，避免账号身份与角色不通用。
- `system-admin` 全局 access、订单、客服工作台和奖池页同步改为只把 `SUPER_ADMIN` 识别为超管，不再兼容 `FINANCE_ADMIN`。

---

## 2026-08-03 ｜评级管理时间展示与权限待修复记录

### 本次动作
- 已在后续变更中修复 `SUPER_ADMIN` 身份与 `FINANCE_ADMIN` 角色语义混用问题。
- `system-admin` 评级管理列表新增创建时间、修改时间列。
- 评级管理时间统一按北京时间 `Asia/Shanghai` 格式化为 `YYYY-MM-DD HH:mm:ss`，不直接展示数据库原始值。
- 顺手修正评级管理新增、编辑、删除按钮权限条件，避免无权限时反向展示。
- 打手管理顶部员工资金统计改为仅 `SUPER_ADMIN` 展示和加载，店长等普通打手管理角色不可见。

---

## 2026-08-03 ｜用户管理按钮级权限落地

### 本次动作
- 新增 Prisma migration `20260803024500_add_user_button_permissions`，随发布写入用户管理按钮权限树。
- `prisma/seed.ts` 同步补齐用户管理按钮权限，权限管理和角色配置可直接勾选。
- `system-admin/src/access.ts` 将用户管理现有按钮从硬编码超管判断改为读取按钮权限 key。
- 用户管理页的新增、编辑、分配角色、升降级、重置密码、删除、退店、清退、资金统计、会员手动充值、成长值调整、游戏名片维护均改为按钮权限控制。
- 后端 `UsersController`、`UsersService`、`MemberController` 同步校验按钮权限，避免仅靠前端隐藏按钮。

### 权限 key
- 会员管理：`users:member:create:button`、`users:member:edit:button`、`users:member:delete:button`、`users:member:recharge:button`、`users:member:growth-adjust:button`、`users:member:game-card:button`
- 打手管理：`users:staff:create:button`、`users:staff:edit:button`、`users:staff:assign-role:button`、`users:staff:change-level:button`、`users:staff:reset-password:button`、`users:staff:delete:button`、`users:staff:exit:button`、`users:staff:clear:button`、`users:staff:wallet-stats:button`、`users:staff:withdraw-qr-reset:button`
- 后台人员：`users:internal:create:button`、`users:internal:edit:button`、`users:internal:assign-role:button`、`users:internal:reset-password:button`、`users:internal:delete:button`

---

## 2026-08-03 ｜订单模块按钮级权限落地

### 本次动作
- 新增 Prisma migration `20260803031500_add_order_button_permissions`，随发布写入订单按钮权限树。
- 客服工作台创建订单按钮挂在 `orders:workbench:page` 下。
- 订单列表创建/删除按钮挂在 `orders:list:page` 下。
- 订单详情业务按钮挂在 `orders:detail:page` 下，并同步前端展示和后端接口校验。

### 权限 key
- `orders:workbench:create:button`
- `orders:list:create:button`、`orders:list:delete:button`
- `orders:detail:receipt:button`、`orders:detail:mark-paid:button`、`orders:detail:refund:button`、`orders:detail:edit:button`、`orders:detail:dispatch:button`、`orders:detail:update-paid:button`
- `orders:detail:confirm-complete:button`、`orders:detail:admin-accept:button`、`orders:detail:archive:button`、`orders:detail:complete:button`
- `orders:detail:rollback-accepted:button`、`orders:detail:rollback-archived:button`
- `orders:detail:update-participants:button`、`orders:detail:settlement-adjust:button`、`orders:detail:archived-progress-fix:button`、`orders:detail:recalculate-settlements:button`
