# 🧭 蓝猫陪玩系统 · 开发日志（DEV_LOG）

> 目的：
> - 记录关键设计变更、决策背景、功能里程碑
> - 作为人类 + AI 的长期记忆补充
> - 新会话可快速扫一遍，恢复项目脉络

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
