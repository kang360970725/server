📌《蓝猫陪玩系统 · 项目锚点文档 v0.1》

适用场景：在新会话中恢复完整上下文，继续开发本项目
使用方式：新会话第一条消息直接粘贴本文件

一、📦 项目基本信息

项目名：蓝猫陪玩系统（BlueCat）

形态：全栈管理后台 + 后端 API
用途：陪玩/打手派单、订单、结算、分润、客服与财务管理系统

二、🧱 技术栈
后端

NestJS

Prisma ORM

MySQL

JWT 鉴权

模块化设计（users / game-project / orders / meta 等）

前端

Umi Max

Ant Design Pro

Ant Design 组件

request 封装 API

页面：用户、项目、订单、结算等管理后台

三、🗂 当前已完成模块
✅ Users 模块

用户管理

用户类型：SUPER_ADMIN / ADMIN / STAFF / 客服 / 财务 / 注册用户

支持 StaffRating（陪玩评级）

操作日志 UserLog

陪玩工作状态：IDLE / WORKING / RESTING

✅ GameProject 模块

菜单项目管理

支持：

type（体验单/护航/福袋等）

billingMode（小时单 / 保底单）

baseAmount（保底）

clubRate（俱乐部固定抽成）

已完成前后端 CRUD

✅ Orders 模块 v0.1

已实现完整模型 + 基础功能：

核心模型：

Order（订单）

OrderDispatch（派单批次）

OrderParticipant（陪玩参与者）

OrderSettlement（结算明细）

支持能力：

新建订单

多轮派单 / 存单 / 再派

当前派单 currentDispatch

陪玩接单 / 结单 / 存单

小时单自动时长计算

保底单进度填写

自动结算落库

结算批次（体验单3天 / 正价单月结）

订单状态机

状态设计：

OrderStatus：
WAIT_ASSIGN / WAIT_ACCEPT / ACCEPTED / ARCHIVED / COMPLETED / CANCELLED …

DispatchStatus：
WAIT_ASSIGN / WAIT_ACCEPT / ACCEPTED / ARCHIVED / COMPLETED

陪玩工作状态：
IDLE / WORKING / RESTING

四、📐 已确认设计决策（禁止推翻）

Prisma 作为唯一 ORM，不再混用其他方式

Orders 采用：

Order + Dispatch + Participant + Settlement 分层模型

所有接口 统一用 POST

小时单：

接单时间 → 存/结单时间 自动算时长

分钟规则：
<15=0h，15~45=0.5h，>45=1h

保底单：

存单按 progressBaseWan 进度算收益

允许负数（炸单）

默认 v0.1：

1~2 个陪玩，收益均分

俱乐部抽成：

订单级 customClubRate > 项目 clubRate

枚举字典：

后端统一 /meta/enums 提供

前端动态加载展示

不重构已有 users / game-project 稳定代码

所有关键动作需记录日志：

派单、换人、结算、打款、收益调整、评级调整等

五、🧩 当前开发重点

正在进行中：

🧾 订单详情页优化：

当前参与者展示

派单 / 更新参与者

可修改实付金额（小时单超时补收）

状态字典展示

🎯 新建订单页优化：

可直接派单

项目 / 陪玩支持下拉搜索

默认只显示空闲陪玩

表单紧凑排版

默认时间填当前时间

🧑‍🤝‍🧑 陪玩状态流转：

接单 → WORKING

结/存单 → IDLE

手动 RESTING / 开始接单 → IDLE

📊 结算页面：

体验单3天结算

月度正价单结算

汇总 + 明细

六、🧠 项目锚点用语说明

“当前派单” = order.currentDispatch

“参与者” = OrderParticipant（isActive=true）

“存单” = dispatch.status = ARCHIVED

“结单” = dispatch.status = COMPLETED 并触发 settlement 落库

“再派” = 新建下一 round 的 OrderDispatch
