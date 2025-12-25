# 🐱 蓝猫陪玩系统（BlueCat）

蓝猫陪玩系统是一个面向 **陪玩/打手派单业务** 的管理后台与后端 API 系统，覆盖从下单、派单、接单、存单、结单、结算、分润到财务打款的完整业务闭环。

> 本项目强调：**强业务建模 + 可追溯审计 + 工程级协作规范 + AI 抗会话中断协作**。

---

## 📌 一、项目概览

- 🎯 目标：构建一套稳定、可扩展、可审计的陪玩派单与分润系统
- 👥 使用角色：客服 / 管理员 / 财务 / 陪玩 STAFF
- 🧱 系统形态：管理后台 + 后端 API
- 📦 仓库：
  - 后端：NestJS + Prisma + MySQL
  - 前端：admin（Umi Max + Ant Design Pro）

---

## 🛠 二、技术栈

### 后端
- NestJS
- Prisma ORM（唯一 ORM）
- MySQL
- JWT 鉴权
- 模块化：`users / game-project / orders / meta / settlement ...`

### 前端
- Umi Max
- Ant Design Pro
- Ant Design
- request API 封装

---

## 🧩 三、核心业务模型

| 模型 | 说明 |
|------|------|
| Order | 订单主体 |
| OrderDispatch | 派单批次（支持多轮） |
| OrderParticipant | 派单参与者（陪玩） |
| OrderSettlement | 结算明细（每人每轮） |
| UserLog | 审计日志（所有关键动作） |

> 设计原则：**订单 ≠ 派单 ≠ 参与者 ≠ 结算**，强分层，禁止混用。

---

## 🔁 四、状态机（统一版）

### 1️⃣ 订单状态（OrderStatus）

```
WAIT_ASSIGN
     ↓
WAIT_ACCEPT
     ↓
ACCEPTED
     ↓
ARCHIVED   （允许再次派单）
     ↓
COMPLETED  （终态）

任意阶段 → REFUNDED（退款终态）
```

说明：
- WAIT_ASSIGN：新建订单，尚未派单
- WAIT_ACCEPT：已派单，等待陪玩接单
- ACCEPTED：本轮全员已接单
- ARCHIVED：已存单，可再次派单进入下一轮
- COMPLETED：已结单，流程结束
- REFUNDED：已退款，强制终态（可由任意状态进入）

---

### 2️⃣ 派单批次状态（DispatchStatus）

```
WAIT_ASSIGN
     ↓
WAIT_ACCEPT
     ↓
ACCEPTED
     ↓
ARCHIVED   （本轮结束，可进入下一轮）
     ↓
COMPLETED  （本轮结单终态）
```

说明：
- 每一轮派单独立流转
- 一个 Order 可对应多轮 Dispatch

---

### 3️⃣ 陪玩工作状态

```
IDLE → WORKING → IDLE
            ↘
           RESTING
```

说明：
- 接单：IDLE → WORKING
- 存单/结单：WORKING → IDLE
- 休息：可手动进入 RESTING

---

## ⚖️ 五、分润/抽成优先级

陪玩最终到手收益优先级：

```
订单固定抽成(customClubRate)
> 项目固定抽成(project.clubRate)
> 陪玩评级分红比例(staffRating.rate)
```

计算原则：
1. 先算订单陪玩分润池
2. 按人数均分
3. 再按上述优先级取比例计算陪玩到手收益

---

## 📜 六、工程约束（铁律）

- ✅ Prisma 为唯一 ORM
- ✅ 所有 API 使用 POST
- ✅ 不随意重构稳定模块（users / game-project）
- ✅ 关键动作必须写入 UserLog：
  - 派单 / 换人 / 接单 / 存单 / 结单  
  - 结算 / 调整收益 / 打款 / 退款 / 编辑订单
- ✅ 枚举统一由 `/meta/enums` 提供
- ❌ 禁止绕过状态机直接改状态
- ❌ 禁止直接 SQL / 多 ORM 混用

---

## 📂 七、文档与抗中断体系

```
/docs
  ├─ PROJECT_ANCHOR.md   # 项目锚点（全局上下文）
  ├─ MODULE_CONTEXT.md   # 模块级上下文模板
  └─ PROMPT.md           # AI 抗中断 Prompt
```

### ✅ 新会话恢复流程

1. 发送 `PROMPT.md`
2. 发送 `PROJECT_ANCHOR.md`
3. 描述本轮模块上下文
4. 说：“开始吧”

---

## 🧑‍💻 八、开发与贡献指南

### 分支规范
- `main`：稳定主分支
- `dev`：日常开发分支
- `feat/*`、`fix/*`：功能/修复分支

### 提交规范
```
feat: 新增打手工作台结单功能
fix: 修复存单后无法重新派单问题
refactor: 重构结算比例计算逻辑
```

### 改动原则
- 改业务前：先说明**目标 + 约束**
- 改金额/收益/状态：必须写 UserLog
- 提交前自测完整流程

---

## 🧪 九、核心流程自测清单

- [ ] 新建订单 → 派单 → 接单
- [ ] 存单 → 再派单
- [ ] 结单 → 自动结算
- [ ] 多轮派单收益正确
- [ ] 补收实付金额后重算
- [ ] 调整陪玩收益
- [ ] 批次结算 + 打款
- [ ] 退款后收益清零

---

## ❤️ 说明

本项目以 **业务正确性 + 可审计 + 可持续演进** 为核心目标，
所有关键设计请同步沉淀到 `/docs`。

欢迎共建。
