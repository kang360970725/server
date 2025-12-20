# 📌 蓝猫陪玩系统 · 项目锚点文档 v0.1

## 一、项目基本信息

项目名：蓝猫陪玩系统（BlueCat）  
用途：陪玩/打手派单、订单、结算、分润、客服与财务管理系统  
形态：管理后台 + 后端 API

---

## 二、技术栈

### 后端
- NestJS
- Prisma ORM
- MySQL
- JWT 鉴权
- 模块化：users / game-project / orders / meta

### 前端
- Umi Max
- Ant Design Pro
- Ant Design
- request API 封装

---

## 三、当前已完成模块

### ✅ Users
- 用户管理
- 用户类型：SUPER_ADMIN / ADMIN / STAFF / 客服 / 财务 / REGISTERED_USER
- StaffRating（陪玩评级）
- UserLog 操作日志
- 陪玩工作状态：IDLE / WORKING / RESTING

### ✅ GameProject
- 菜单项目管理
- 字段：
    - type（体验单/护航等）
    - billingMode（HOURLY / GUARANTEED）
    - baseAmount（保底）
    - clubRate（固定抽成）

### ✅ Orders v0.1
模型：
- Order
- OrderDispatch
- OrderParticipant
- OrderSettlement

能力：
- 新建订单
- 多轮派单 / 存单 / 再派
- currentDispatch
- 陪玩接单 / 结单 / 存单
- 小时单自动时长计算
- 保底单进度填写
- 自动结算落库
- 批次结算（体验3天 / 正价月结）
- 状态机控制

---

## 四、状态设计

OrderStatus：
- WAIT_ASSIGN / WAIT_ACCEPT / ACCEPTED
- ARCHIVED / COMPLETED / CANCELLED

DispatchStatus：
- WAIT_ASSIGN / WAIT_ACCEPT / ACCEPTED
- ARCHIVED / COMPLETED

陪玩工作状态：
- IDLE（空闲）
- WORKING（接单中）
- RESTING（休息）

---

## 五、已确认设计决策（禁止推翻）

1. Prisma 为唯一 ORM
2. Order + Dispatch + Participant + Settlement 分层模型
3. 所有接口统一 POST
4. 小时单：
    - 接单 → 存/结单 自动算时长
    - <15=0h，15~45=0.5h，>45=1h
5. 保底单：
    - 存单按 progressBaseWan
    - 支持负数（炸单）
6. v0.1 默认：
    - 最多 2 陪玩
    - 收益均分
7. 抽成优先级：
   customClubRate > 项目 clubRate
8. 枚举统一由 `/meta/enums` 提供
9. 不重构 users / game-project 稳定模块
10. 关键动作必须记录日志：
    - 派单、换人、结算、打款、收益调整、评级调整

---

## 六、当前开发重点

- 订单详情页：派单 / 参与者 / 状态 / 可改实付金额
- 新建订单页：直接派单 + 搜索筛选 + 紧凑排版
- 陪玩状态流转：IDLE ↔ WORKING ↔ RESTING
- 结算页面：体验单3天 / 月度结算

---

## 七、业务用语说明

- 当前派单：order.currentDispatch
- 参与者：OrderParticipant（isActive=true）
- 存单：dispatch.status = ARCHIVED
- 结单：dispatch.status = COMPLETED 并生成 settlement
- 再派：新建 round 的 OrderDispatch

---

## 八、使用方式

在新会话中，配合 PROMPT.md 使用，可恢复完整上下文。
