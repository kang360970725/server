# MiniApp 联调缺口清单（Phase 1）

## 已具备（可直接联调）
- 登录（手机号密码）：`POST /mini/auth/login`
- 用户信息：`GET /mini/auth/me`
- 订单列表：`GET /mini/orders`
- 订单详情：`GET /mini/orders/:id`
- 创建订单：`POST /mini/orders/create`
- 取消订单：`POST /mini/orders/:id/cancel`
- 确认支付：`POST /mini/orders/:id/pay-confirm`
- 钱包账户：`GET /mini/wallet/account`
- 钱包流水：`GET /mini/wallet/transactions`
- 领券中心（模板）：`GET /mini/coupons/center`
- 我的券：`GET /mini/coupons/mine`
- 领券：`POST /mini/coupons/claim?templateId=xx`

## 当前不支持（需补）
1. 微信小程序登录（`code2Session` + openid/unionid 绑定）
2. 订单 C 端完整状态机接口（已完成创建/取消/确认支付；仍缺支付回调/售后申请/评价提交）
3. 商品与项目查询（首页、列表、详情）的小程序专用接口
4. 钱包充值下单与支付确认（微信支付闭环）
5. 签到数据模型与接口（周历、连续天数、奖励发放）
6. 优惠券“下单可用券”计算接口（按项目/金额/时效筛选）
7. 小程序消息中心（订单进度推送、站内信已读）
8. 小程序专用风控与幂等（下单/领券/售后频控，重复提交保护）

## 补足方案（建议顺序）
1. **鉴权先行**
   - 新增 `POST /mini/auth/wechat-login`
   - 用户表扩展微信标识字段（openid/unionid）
2. **交易主链路**
   - `POST /mini/orders/create`
   - `POST /mini/orders/:id/cancel`
   - `POST /mini/orders/:id/pay-confirm`（先模拟，后接支付回调）
3. **售后/评价**
   - `POST /mini/orders/:id/review`
   - `POST /mini/orders/:id/after-sales`
4. **钱包充值**
   - `POST /mini/wallet/recharge/create`
   - `POST /mini/wallet/recharge/confirm`
5. **签到与消息**
   - 新建签到表（checkin_record/checkin_reward_log）
   - `GET /mini/checkin/state`
   - `POST /mini/checkin/sign`
   - `GET /mini/notifications`

## 权限建议
- 小程序接口只使用“用户态 + 资源归属校验”。
- 不复用后台 `@Permissions` 菜单权限。
- 保留后台权限体系给 `admin/staff` 端使用。
