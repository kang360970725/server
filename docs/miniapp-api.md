# MiniApp 接口文档（当前已实现）

更新时间：2026-05-14  
服务基址（开发）：`http://127.0.0.1:3000`

## 1. 通用约定

### 1.1 鉴权
- 除标注“免登录”外，所有接口都需要：
  - `Authorization: Bearer <access_token>`

### 1.2 返回结构
```json
{
  "code": 0,
  "message": "ok",
  "data": {}
}
```

返回字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | `number` | 业务状态码，`0` 表示成功 |
| `message` | `string` | 业务提示信息 |
| `data` | `object/array/null` | 业务数据载荷 |

### 1.3 分页字段
- 统一使用：`page`、`limit`
- 通用返回：`list`、`total`、`totalPages`

分页字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `list` | `array` | 当前页数据 |
| `total` | `number` | 总条数 |
| `page` | `number` | 当前页码（从 1 开始） |
| `limit` | `number` | 每页条数 |
| `totalPages` | `number` | 总页数 |

### 1.4 错误
- 参数错误、无权限、资源不存在等会返回 4xx（Nest 异常响应结构）

---

## 2. 认证模块 `mini/auth`

### 2.1 手机号登录（免登录）
- `POST /mini/auth/login`

请求体：
```json
{
  "phone": "13800000000",
  "password": "123456"
}
```

成功示例：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "success": true,
    "access_token": "xxx",
    "user": { "id": 1, "phone": "13800000000" }
  }
}
```

---

### 2.2 微信登录（占位，免登录）
- `POST /mini/auth/wechat-login`

请求体：
```json
{
  "code": "wx_login_code"
}
```

当前返回（未接入 code2Session）：
```json
{
  "code": 0,
  "message": "wechat login is not implemented yet",
  "data": {
    "supported": false,
    "code": "wx_login_code"
  }
}
```

---

### 2.3 获取当前用户
- `GET /mini/auth/me`

成功示例：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": 1,
    "name": "xxx",
    "phone": "13800000000",
    "permissions": []
  }
}
```

---

### 2.4 刷新 Token
- `POST /mini/auth/refresh`

成功示例：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "access_token": "new_token",
    "expiresInSeconds": 7200
  }
}
```

---

## 3. 订单模块 `mini/orders`

### 3.1 订单列表
- `GET /mini/orders?page=1&limit=20&status=WAIT_ASSIGN`
- 仅返回当前登录用户（`dispatcherId = 当前用户`）自己的订单

查询参数：
- `page` 可选，默认 `1`
- `limit` 可选，默认 `20`，最大 `50`
- `status` 可选，枚举见订单状态

成功示例：
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "list": [
      {
        "id": 1001,
        "autoSerial": "PW202605101024",
        "status": "WAIT_ASSIGN",
        "paidAmount": "128.00",
        "createdAt": "2026-05-14T01:00:00.000Z",
        "project": { "id": 1, "name": "王者荣耀陪玩" }
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 20,
    "totalPages": 1
  }
}
```

`data.list[]` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `number` | 订单ID |
| `autoSerial` | `string` | 订单编号 |
| `status` | `string` | 订单状态枚举 |
| `paidAmount` | `string/number` | 已付金额 |
| `createdAt` | `string` | 下单时间（ISO） |
| `project.id` | `number` | 项目ID |
| `project.name` | `string` | 项目名称 |

---

### 3.2 订单详情
- `GET /mini/orders/:id`
- 仅允许查看自己的订单，否则报错“订单不存在或无权限访问”

---

### 3.3 创建订单
- `POST /mini/orders/create`

请求体（当前可用字段）：
```json
{
  "projectId": 1,
  "paidAmount": 128,
  "receivableAmount": 128,
  "orderQuantity": 1,
  "customerGameId": "猫猫玩家",
  "inviter": "邀请码",
  "customClubRate": 0.1,
  "isGifted": false,
  "isPaid": false,
  "userCouponId": 12
}
```

校验规则（当前）：
- `projectId` 必填
- `paidAmount >= 0`
- `orderQuantity >= 1`

---

### 3.4 取消订单
- `POST /mini/orders/:id/cancel`

请求体：
```json
{
  "remark": "用户主动取消"
}
```

---

### 3.5 确认支付
- `POST /mini/orders/:id/pay-confirm`

请求体：
```json
{
  "paidAmount": 128
}
```

说明：
- 当前为业务确认接口（直接写 `isPaid=true`、`paymentTime=now`）
- 不是微信支付回调接口

---

### 3.6 提交评价
- `POST /mini/orders/:id/review`

请求体：
```json
{
  "score": 5,
  "tags": ["指挥专业", "沟通愉快"],
  "content": "服务专业，体验很好",
  "anonymous": true
}
```

说明：
- 当前会将订单状态更新为 `REVIEWED`
- 评价明细暂存于 `user_logs`（`action=MINI_ORDER_REVIEW`）

---

### 3.7 提交售后申请
- `POST /mini/orders/:id/after-sales`

请求体：
```json
{
  "reason": "实际水平与描述不符",
  "description": "中途频繁掉线，沟通效果差"
}
```

说明：
- 当前会将订单状态更新为 `WAIT_AFTERSALE`
- 售后明细暂存于 `user_logs`（`action=MINI_ORDER_AFTER_SALES`）

---

## 4. 项目模块 `mini/projects`

### 4.1 项目列表
- `GET /mini/projects?page=1&limit=20&category=MOBA&keyword=王者`

说明：
- 仅返回 `ACTIVE` 状态项目

### 4.2 项目详情
- `GET /mini/projects/:id`

说明：
- 非 `ACTIVE` 项目会返回“项目不存在或已下架”

---

## 5. 首页模块 `mini/home`

### 5.1 首页配置
- `GET /mini/home/config`（免登录）

说明：
- 单一配置模型，包含：
  - `banners`
  - `hotSales`
  - `limitedBenefits`
  - `recommendedStaff`
  - `hotEvents`
  - `quickEntries`
  - `esportsGoods`
- 小程序前端约定：数组为空则隐藏模块

---

## 6. 钱包模块 `mini/wallet`

### 4.1 钱包账户
- `GET /mini/wallet/account`

说明：
- 自动创建钱包账户（若不存在）

`data` 关键字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `number` | 钱包账户ID |
| `userId` | `number` | 用户ID |
| `availableBalance` | `string/number` | 可用余额 |
| `frozenBalance` | `string/number` | 冻结余额 |

---

### 4.2 钱包流水
- `GET /mini/wallet/transactions?page=1&limit=20`

说明：
- 使用当前登录用户 ID 查询

---

## 7. 优惠券模块 `mini/coupons`

### 5.1 领券中心
- `GET /mini/coupons/center?page=1&limit=20&type=CASH`

说明：
- 仅返回 `ACTIVE` 状态券模板

---

### 5.2 我的优惠券
- `GET /mini/coupons/mine?page=1&limit=20&status=UNUSED`

说明：
- 仅返回当前登录用户数据

---

### 5.3 领取优惠券
- `POST /mini/coupons/claim?templateId=1`

说明：
- 校验模板存在、状态生效、每人限领、总量限制

成功示例：
```json
{
  "code": 0,
  "message": "领取成功",
  "data": {
    "id": 123,
    "userId": 1,
    "templateId": 1,
    "status": "UNUSED"
  }
}
```

`data` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `number` | 用户券ID |
| `userId` | `number` | 用户ID |
| `templateId` | `number` | 券模板ID |
| `status` | `string` | 券状态（通常 `UNUSED`） |

---

## 8. 当前未实现（重要）
- 微信 `code2Session` 真链路
- 微信支付下单与异步回调闭环
- 小程序商品/项目查询专用接口
- 小程序签到接口
