# 蓝猫陪玩系统 · 项目锚点文档（PROJECT ANCHOR）

> 本文档是蓝猫陪玩系统的**全局上下文与最高优先级设计约束**。  
> 新会话 / 新成员 / AI 协作必须先完整加载本文件。

---

## 一、项目基本信息

项目名：蓝猫陪玩系统（BlueCat）  
用途：陪玩/打手派单、订单、结算、分润、客服与财务管理系统  
形态：管理后台 + 后端 API + 陪玩工作台 + H5 派单  
目标：**跑得稳、算得准、查得到、扩得开**

---

## 二、技术栈

### 后端
- NestJS
- Prisma ORM（唯一 ORM）
- MySQL
- JWT 鉴权
- 模块化：users / game-project / orders / meta / settlement / auth

### 前端
- Umi Max
- Ant Design Pro
- Ant Design
- request API 封装
- 管理后台 + 陪玩工作台 + H5 页面

---

## 三、核心业务模型（强分层）

- Order —— 订单
- OrderDispatch —— 派单批次（支持多轮）
- OrderParticipant —— 派单参与者
- OrderSettlement —— 结算明细
- UserLog —— 审计日志（所有关键动作）

> 原则：**订单 ≠ 派单 ≠ 参与者 ≠ 结算**，严禁混用。

---

## 四、状态机（统一）

### OrderStatus
```
WAIT_ASSIGN
   ↓
WAIT_ACCEPT
   ↓
ACCEPTED
   ↓
ARCHIVED   （可再次派单）
   ↓
COMPLETED  （终态）

任意阶段 → REFUNDED（退款终态）
```

### DispatchStatus
```
WAIT_ASSIGN → WAIT_ACCEPT → ACCEPTED → ARCHIVED → COMPLETED
```

### 陪玩工作状态
```
IDLE → WORKING → IDLE
            ↘
           RESTING
```

---

## 五、计费与结算规则（已确认）

### 1️⃣ 小时单
- acceptedAllAt → 存/结单时间
- <15=0h，15~45=0.5h，>45=1h
- 支持扣时选项：M10/M20/M30/M40/M50/M60
- 可补收修改实付金额，结单后按贡献重算

### 2️⃣ 保底单
- 存单按 progressBaseWan（可负数）
- 结单默认结算剩余全部
- 多人：输入总数后均分

---

## 六、分润/抽成优先级（已升级）

陪玩最终到手收益计算优先级：

1. 订单固定抽成：order.customClubRate
2. 项目固定抽成：project.clubRate
3. 陪玩评级分红比例：staffRating.rate（如 60%）

> 逻辑：  
> 均分收益 × 对应比例 = 陪玩到手收益

---

## 七、工程铁律（禁止推翻）

1. Prisma 为唯一 ORM
2. 所有接口统一 POST
3. 不重构 users / game-project 稳定模块
4. 关键动作必须记录 UserLog：
    - 派单、换人、接单、存单、结单
    - 结算、调整收益、打款
    - 退款、编辑订单、修改金额
5. 枚举统一由 `/meta/enums` 提供
6. 状态必须按状态机流转，不允许跳转

---

## 八、当前功能进度（v0.1 → v0.2）

### ✅ 已完成 / 推进中
- 订单创建 / 派单 / 多轮派单
- 接单 / 存单 / 结单
- 小时单计时 + 扣时
- 保底单进度
- 自动结算 & 批次结算
- 修改实付金额（补收）
- 陪玩收益按评级比例
- 手动调整收益（处罚/奖励）
- 我的接单记录 API
- 打手工作台基础流程

### 🔄 本轮会话重点
- 订单详情页增强：
    - 历史派单 / 参与者 / 实际收益
    - 退款
    - 编辑订单
- 存/结单弹窗实时计算
- 多人均分逻辑
- 防并发：仅客服/管理员可存结单
- 补收后收益重算

### ⏭ 规划中
- H5 派单流程（微信可访问）
- 结算管理页面
- 财务打款流程
- 陪玩端收益与记录页面

---

> ⚡ 本文档是项目“记忆锚点”，任何重要决策都应同步更新。
