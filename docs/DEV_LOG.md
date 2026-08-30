# 🧭 蓝猫陪玩系统 · 开发日志（DEV_LOG）

> 目的：
> - 记录关键设计变更、决策背景、功能里程碑
> - 作为人类 + AI 的长期记忆补充
> - 新会话可快速扫一遍，恢复项目脉络

---

## 2026-08-28 ｜续单/指定二选一归因与移动端派单体验优化

### 背景
- 续单之外新增“指定”分红场景：指定复用续单分红规则，但不受优秀服务者名单限制，所有被指定成员均参与分红。
- 客服在移动端快捷派单/创建订单时需要更快选择“普通、续单、指定”，避免两个复选框造成误选或同时勾选。
- 订单弹窗顶部金额/状态摘要在移动端占用高度偏大，需要进一步压缩。

### 本次动作
- `order_renewal_groups` 新增 `attributionType` 字段：
  - `RENEWAL`：续单，仍按派单时快照的优秀服务者资格决定谁享受续单分红。
  - `DESIGNATED`：指定，分红规则同续单，但所选服务者均参与分红，不读取优秀服务者名单。
- 新增 migration：`20260828172000_add_order_bonus_attribution_type`，并增加 `attributionType/status/settledAt` 组合索引。
- 创建订单、快捷发单、订单管理创建弹窗均支持“分红归因：普通 / 续单 / 指定”三段选择，并在前后端同时校验续单和指定不可同时存在。
- 指定/续单成员必须来自当前首轮派单服务者；非首轮派单不允许设置续单或指定归因。
- 续单榜单仅统计 `attributionType=RENEWAL` 的数据，避免指定单污染续单榜单。
- 订单详情和结单确认弹窗改为“分红归因”中性文案，钱包入账备注按实际归因显示“续单分红”或“指定分红”。
- 管理端移动端表单摘要卡压缩高度与字号，5 个顶部指标改为更紧凑的横向轻扫小卡，减少遮挡表单内容。

### 设计约束
- 为降低影响范围，继续复用原 `OrderRenewalGroup` 与 `OrderRenewalBonus` 结算链路，只增加归因类型字段区分业务含义。
- `Order.isRenewal` 暂作为“存在续单/指定额外分红归因”的兼容标识保留，避免大范围改动旧查询和旧结算入口。

---

## 2026-08-28 ｜派单客户标识类型与真实游戏ID补录

### 背景
- 客服派单时，客户经常只提供游戏昵称或房间号；昵称可变、房间号一次性，不能作为长期客户账号绑定依据。
- 原系统只有 `customerGameId` 字段，容易把昵称/房间号误当作准确游戏ID，导致后续查询消费记录和客户账号绑定不稳定。

### 本次动作
- 订单表新增字段：
  - `customerIdentifierType`：客户首次提供内容类型，`GAME_ID` 表示准确游戏ID，`ALIAS` 表示昵称/房间号等临时标识。
  - `customerOriginalIdentifier`：客服首次录入的原始客户标识，后续补齐真实游戏ID时不覆盖。
- 新增 migration：`20260828161000_add_order_customer_identifier_type`；历史订单默认回填为 `GAME_ID`，并将原 `customerGameId` 写入 `customerOriginalIdentifier`。
- 创建订单/快捷发单新增“客户提供内容”选择：
  - 准确游戏ID：写入 `customerGameId`，流程与历史一致，存单/结单不阻断。
  - 昵称/房间号：仅写入 `customerOriginalIdentifier`，`customerGameId` 暂为空，等待服务者补齐。
- 服务者工作台、客服订单详情页的存单/结单弹窗增加补录规则：
  - 若订单为 `ALIAS` 且尚无 `customerGameId`，必须填写客户准确游戏ID后才能继续存单或结单。
  - 补齐后只更新 `customerGameId`，不覆盖 `customerOriginalIdentifier`。
- 订单列表和订单详情展示“客户提供内容/客户准确游戏ID”，避免将昵称或房间号误读为准确游戏ID。

### 设计约束
- 采用轻字段兼容，不改动客户主数据结构，不强制派单时绑定客户账号。
- 后端在存单/结单接口做强校验，避免绕过前端导致不完整订单继续流转。

---

## 2026-08-28 ｜微信支付商户安全验证文件

### 本次动作
- 新增微信支付商户安全验证凭证文件 `verify_98c2bf5059943483ae673d143fec765d.html`。
- 文件已放置到管理端项目根目录和 `public/` 目录：
  - `/Users/allen/Desktop/BlueCat-App/newObject/system-admin/verify_98c2bf5059943483ae673d143fec765d.html`
  - `/Users/allen/Desktop/BlueCat-App/newObject/system-admin/public/verify_98c2bf5059943483ae673d143fec765d.html`
- `public/` 版本用于前端构建产物在网站根路径直接访问，便于微信支付商户平台完成安全验证。
- 新增商户转账场景证明流程图，用于描述“平台撮合订单 -> 服务者提供服务 -> 完成结算 -> 冻结期 -> 提现审核 -> 转账”的业务闭环：
  - `/Users/allen/Desktop/BlueCat-App/newObject/system-admin/public/verification-assets/platform-settlement-flow.svg`
  - `/Users/allen/Desktop/BlueCat-App/newObject/system-admin/public/verification-assets/platform-settlement-flow.png`
- 新增《平台服务者入驻与服务收益结算协议（审核材料参考版）》：
  - `/Users/allen/Desktop/BlueCat-App/newObject/server/docs/PLATFORM_SERVICE_PROVIDER_AGREEMENT.md`
- 协议口径强调“平台招商合作服务提供方”“订单服务收益结算”“服务者自主申请提现”，避免使用工资、薪资、员工发薪、雇佣等表述；正式对外使用前需由法律顾问按主体资质和真实业务复核。

---

## 2026-08-28 ｜微信提现自动到账暂停与会员 H5 优先级调整

### 决策背景
- 调研微信商家转账场景与提额要求后，确认当前“服务者提现自动到账”方案存在较高不确定性，后续随时可能因场景、额度、风控或合规口径被限制/停用。
- 当前阶段不再继续推进微信提现自动到账上线，优先恢复并保障现有人工线下打款流程稳定，再转向会员系统 H5 版本打通。
- 会员系统 H5 优先采用公众号 AppID 做微信网页授权；小程序 AppID 继续用于小程序登录、支付和订阅消息，不与 H5 主身份链路混用。

### 本次动作
- 管理端系统配置页屏蔽自动到账相关配置入口，避免运营误开启或误配置：
  - `withdraw_auto_transfer_enabled`
  - `withdraw_wechat_transfer_enabled`
  - `withdraw_wechat_transfer_mock`
  - `withdraw_auto_single_limit`
  - `withdraw_auto_first_limit`
  - `withdraw_auto_user_day_limit`
  - `withdraw_auto_user_month_limit`
  - `withdraw_auto_platform_day_limit`
  - `withdraw_auto_eligibility`
  - `wechat_transfer_scene_id`
  - `wechat_transfer_notify_url`
  - `wechat_transfer_appid`
  - `wechat_transfer_appsecret`
- 服务者移动端提现申请弹窗移除“微信自动到账/即将上线”入口与资格提示，仅保留现有人工线下打款流程。
- 管理端提现审批弹窗移除微信自动打款资格展示和“微信自动打款”审批选择，审批通过统一走人工线下打款完成逻辑。
- 后端提现申请与审批增加保险：即使旧前端缓存或手工请求传入 `channel=WECHAT`/`autoTransfer=true`，新申请和审批通过也会按 `MANUAL` 渠道处理，不触发微信商家转账。
- 保留 H5 微信网页授权绑定接口和前端 API 能力：`bind-wechat-h5-url` / `bind-wechat-h5` 不删除，后续会员系统 H5 可复用这条微信授权链路获取微信用户标识。
- 新增独立 H5 公众号网页授权配置项：
  - `wechat_h5_appid`
  - `wechat_h5_appsecret`
- H5 微信授权配置读取顺序调整为：优先 `wechat_h5_appid/appsecret`，其次历史预留的 `wechat_transfer_appid/appsecret`，最后兜底小程序配置；后续会员 H5 应直接配置公众号 AppID。
- 微信绑定补齐 `unionId` 保护：微信返回 `unionid` 时会写入 `user_wechat_bindings.unionId`，并禁止同一 `unionid` 绑定到不同系统用户；微信未返回 `unionid` 时不阻塞绑定，也不会把历史已有 `unionId` 覆盖为空。
- H5 绑定接口返回补充 `hasUnionId` 与 `unionidMasked`，便于后续会员 H5 判断当前公众号/小程序是否已挂到同一个微信开放平台主体。

### 后续方向
- 自动到账相关数据库字段、服务类和管理接口暂不删除，作为预留代码保留；后续如切换更合规稳定的出款通道，再评估是否复用。
- 下一阶段优先开发会员系统 H5 版本，微信授权绑定能力以会员识别、会员登录/绑定为主，不再绑定到提现自动出款场景。
- 如需跨公众号、小程序统一会员身份，应确认公众号与小程序已绑定到同一微信开放平台账号；否则只能分别依赖各自 AppID 下的 `openid`，无法稳定生成同一 `unionid`。

---

## 2026-08-26 ｜提现微信自动打款一期

### 本次动作
- 启动“微信自动打款 + 人工扫码兜底”一期开发，暂不开发支付宝、银行 API、第三方代发或订单分账。
- 新增 Prisma migration `20260826093000_add_withdrawal_auto_transfer_fields`，为 `wallet_withdrawal_requests` 增加独立打款状态 `transferStatus`、打款发起/完成时间、转人工时间和转人工操作人字段。
- 新增自动打款配置项，默认全部关闭，避免发布后误自动出款：
  - `withdraw_auto_transfer_enabled`
  - `withdraw_wechat_transfer_enabled`
  - `withdraw_wechat_transfer_mock`
  - `withdraw_auto_single_limit`
  - `withdraw_auto_first_limit`
  - `withdraw_auto_user_day_limit`
  - `withdraw_auto_user_month_limit`
  - `withdraw_auto_platform_day_limit`
  - `wechat_transfer_scene_id`
  - `wechat_transfer_notify_url`
- 新增钱包侧 `WechatWithdrawalTransferService`，复用微信支付商户号、AppID、商户证书序列号和商户私钥配置；微信提现收款 openid 从 `UserWechatBinding` 中按当前小程序 AppID 读取。
- 提现审核流程拆分为两条：
  - 人工扫码：审核通过后仍按旧逻辑直接完成出款，扣减提现冻结并写 `WITHDRAW_PAYOUT` 流水。
  - 微信自动打款：审核通过后先置为 `PAYING/PROCESSING`，事务提交后发起微信商家转账；只有通道成功或查单成功后才真正扣减提现冻结并置为 `PAID`。
- 自动打款失败时，提现单置为 `FAILED`，提现冻结保持不释放；后台可选择“转人工”继续扫码兜底，或在失败状态下驳回并释放冻结。
- 新增管理端接口：
  - `POST /wallet/withdrawals/wechat-transfer/query`：查询微信提现状态，成功时完成出款。
  - `POST /wallet/withdrawals/fallback-manual`：微信提现处理中/失败后转人工扫码兜底。
  - `POST /wallet/withdrawals/manual-paid`：人工扫码确认已打款，完成出款扣减提现冻结。
- 提现审批页从“待审核”扩展为“待处理提现”，展示待审核、打款中、打款失败、转人工待确认单；审批弹窗支持选择“人工扫码兜底/微信自动打款”。
- 提现记录页新增打款状态、通道单号展示和筛选，方便财务对账。
- 新增登录态微信绑定接口 `POST /mini/auth/bind-wechat`，服务者必须先以当前账号登录后绑定微信；该接口只绑定当前账号，不会像微信登录一样自动创建新会员账号。
- 新增 H5/移动端微信网页授权绑定闭环：
  - `GET /mini/auth/bind-wechat-h5-url` 生成微信网页授权地址；
  - `POST /mini/auth/bind-wechat-h5` 使用微信网页授权 `code` 绑定当前登录账号；
  - 管理端服务者钱包/提现页在未满足微信绑定条件时提供“在微信内绑定当前账号”入口，微信回跳后自动完成绑定并刷新提现资格。
- 新增小额自动打款资格配置 `withdraw_auto_eligibility`，默认 `WHITELIST` 且名单为空；只有全局开关、微信通道、资格白名单/规则分组、服务者状态和微信绑定均通过时，后台才允许选择微信自动打款。
- 服务者提现页返回并展示微信自动到账资格状态；提现审批页同步展示该服务者是否具备微信自动打款资格和未命中原因。

### 上线前置
- 商户后台需确认已开通“商家转账到零钱 / API 发起转账”，并完成场景 ID、接口安全 IP、商户 API 私钥/证书序列号、AppID 与商户号绑定配置。
- 服务者必须通过对应小程序完成微信绑定，系统需要能取到同一 AppID 下的 `openid`。
- 如优先走移动端 H5 绑定，需配置 `wechat_transfer_appid` 与 `wechat_transfer_appsecret`，并在微信公众平台配置网页授权域名；该 AppID 也需要与微信支付商户号满足商家转账要求。
- 后台需在 `withdraw_auto_eligibility` 中配置允许使用小额自动打款的 `userIds` 或 `staffRuleGroups`；如需全员按风控规则开放，可显式将 `mode` 改为 `ALL`。
- 灰度测试建议先开启 `withdraw_wechat_transfer_mock=true` 验证状态机和钱包冻结，再关闭 mock 并从小额单开始真实打款。

---

## 2026-08-26 ｜风控查询收紧与手机号展示脱敏

### 本次动作
- 风控查询场景 `STAFF_RENTAL_RISK` 改为后端强制精确查询：仅允许按服务者展示名 `name` 或姓名 `realName` 完全匹配，不再支持手机号、ID、会员编码或模糊查询；空查询继续返回空列表，避免默认暴露服务者账户余额。
- 管理端风控查询页同步调整搜索项文案为“姓名/昵称”，提示“仅支持精确查询”，降低误用手机号/ID 查询的预期。
- 新增统一隐私工具 `maskPhone`，手机号展示统一按“前三位 + ****** + 后两位”呈现，例如 `138******00`；登录、绑定手机号、搜索输入等业务输入场景不做脱敏，避免影响用户录入。
- 用户管理、会员充值小票、订单创建/详情/列表、服务者在线看板、服务者工作台、罚单、值班、优惠券、商品评价、奖池后台、财务账单、钱包对账等后台展示点统一接入手机号脱敏。
- 后台页面新增全局水印：除登录页、公开菜单页和公开活动页外，统一展示当前登录用户姓名 + 脱敏手机号；服务者工作台原有局部水印同步脱敏。

---

## 2026-08-20 ｜服务者默认规则分组可选

### 本次动作
- 服务者管理新增/编辑弹窗的“服务者规则分组”下拉补充“默认规则配置”选项，来源于基础配置中的 `staffRuleEngine.defaultRule`。
- 默认规则选项使用 `default_rule` 作为前端选择值；后端规则匹配时无法命中具体分组会继续走默认规则兜底，因此不新增数据库结构和后端规则分支。
- 服务者列表、移动端卡片和退店预览中的规则分组展示同步做名称映射，避免直接展示 `default_rule` 编码。
- 服务者规则配置保存时新增分组编码同步迁移：同一条规则 `id` 不变但分组编码变化时，自动将已绑定旧编码的服务者迁移到新编码；只改分组名称时服务者侧会按最新配置名称展示。

---

## 2026-08-20 ｜线下费用账单改为手动配置与收费统计

### 本次动作
- 线下费用进一步调整为“收费配置 + 月账单”模式：先维护需要收取线下管理费的服务者和对应月费用，再按配置生成账单。
- 新增 `offline_fee_contracts` 表，维护线下管理费配置：服务者、每月费用、开始时间、结束时间、启停状态和备注。
- 线下管理费配置的开始/结束边界精确到日期；系统按开始时间的“日”作为每月账单到期日，并在到期日前 3 天自动生成账单。历史按月份配置迁移时默认沿用每月 20 日。
- 管理端保留“生成月账单”按钮用于补生成或手动重试；手动生成会生成所选月份内所有已生效配置的账单。
- 线下费用账单页取消“编辑账单”“催收”和“回退”入口，账单生成后仅保留手动缴费、其他渠道已缴、减免等结算动作。
- 提现前线下费用校验改为账单清缴模式：只有已存在未结清账单，且进入账单到期前 3 天内，才要求先完成账单缴费后再提现；未来未到期账单不提前限制提现。
- 线下费用账单废弃原“按业绩基数/费率生成月账单”的前端使用方式，改为按收费配置生成账单：选择服务者、账单月份、扣费日期、扣费金额和备注；服务者不再按线上/线下身份区分。
- 线下费用账单新增 `dueAt`、`remark`、`createdBy` 字段；旧金额字段保留作为兼容层，其中 `shouldPayAmount` 直接表示扣费金额。
- 线下费用缴费来源新增 `EXTERNAL`、`WAIVER`，支持手动缴费、其他渠道已缴、减免三类账单结算动作。
- 线下费用列表新增统计口径：账单金额、收费累计（后台手动缴费 + 服务者自行缴费）、其他渠道收取、减免、未结清。
- 线下费用账单创建、编辑、催收、强制全额、手动缴费、其他渠道已缴、减免、删除均写入 `UserLog` 操作日志。
- 线下费用账单列表新增多选批量删除历史错账入口；批量删除仅允许删除没有任何缴费/减免流水的账单，已有流水的账单会跳过并提示，避免破坏钱包与统计链路。
- 线下费用回退功能停用：管理端不再展示回退按钮，后端回退接口也会直接拒绝，避免误操作反向影响钱包。
- 线下费用提现自动补缴流程彻底停用：提现申请弹框不再填写线下费用补缴金额，后端不再通过提现流水自动扣线下费用；临近到期未结清账单只能先通过账单缴费入口清缴。
- 钱包账户概览补充服务者自助线下费用待结账单区：展示未结清线下费用账单、到期日期和确认扣费按钮；服务者确认后从可用余额扣款并刷新钱包/提现信息。
- 设备租赁账单同步补充操作日志：租赁配置新增/编辑、账单生成、管理员手动缴费、服务者自行缴费、其他渠道已缴、减免均记录 `UserLog`。
- 设备租赁账单列表新增同口径统计：账单金额、收费累计、其他渠道收取、减免、未结清。

### 兼容说明
- 原线下费用生成月账单接口仍保留，避免提现/历史链路调用中断；管理端已移除生成入口，后续如确认不再需要可再彻底废弃后端旧生成逻辑。
- 原线下费用表数据不迁移清洗；新页面会按新口径展示，历史旧账单仍可继续按账单金额与剩余金额处理。

---

## 2026-08-20 ｜退店/黑名单账号登录禁用策略

### 本次动作
- 后台登录入口新增服务者退店登录锁：`staffEmploymentStatus=EXITED` 的账号退店 72 小时内仍允许登录系统处理钱包/提现等收尾操作，退店满 72 小时后自动将账号 `status` 置为 `DISABLED` 并禁止访问。
- 黑名单服务者升级为强限制：操作加入黑名单时立即禁用账号；历史黑名单账号通过迁移统一禁用。
- JWT 校验层同步拦截退店/黑名单账号，避免旧 token 未过期时仍可继续访问系统。
- 新增迁移 `20260820090000_disable_exited_blacklisted_staff_login`，将历史黑名单服务者、历史已退店满 72 小时服务者统一置为禁用，并清理在线接单状态。

### 规则口径
- 普通退店：72 小时内仍允许登录/访问系统处理提现等收尾操作；满 72 小时后自动禁用账号并禁止访问。
- 黑名单：立即禁止登录/访问，并立即禁用账号。
- 历史数据：黑名单禁止登录；已退店未满 72 小时继续允许访问，已退店满 72 小时的账号会被迁移置为禁用。

---

## 2026-08-19 ｜创建订单支持会员优惠券

### 本次动作
- 创建订单弹窗选择“关联会员”后，按会员加载未使用优惠券，不再展示其他会员的券，降低误选风险。
- 选择优惠券后，前端按券类型预估抵扣金额，并自动同步实收金额、结算金额为优惠后金额；最终仍由后端按券模板重新校验适用商品、门槛、状态和有效期。
- 订单列表创建入口补传 `userCouponId`，服务者在线看板快捷创建入口继续复用同一创建弹窗，保证两处创建链路一致。
- 订单小票补充“优惠券抵扣”展示，老板收到小票时可直接看出商品小计、优惠券减免、实付和支付方式。
- 后端已有创建订单优惠券核销链路：提交 `userCouponId` 后自动计算 `couponDiscountAmount`、生成优惠明细、核销用户券并增加模板使用次数；会员储值支付以优惠后的实收金额扣减。
- 金额口径加固：创建订单已选择优惠券时，前端锁定实收金额，由优惠券规则自动计算；后端同步强制 `paidAmount/orderPayment.amount` 使用优惠后应付金额，避免手改实收导致运营优惠成本错账。
- 未选择优惠券时，手动调整实收金额会实时反映到顶部“优惠抵扣”，提交时以 `manualAdjustAmount` 写入后端优惠汇总。
- 会员储值支付体验优化：创建订单前端根据会员可用储值余额预校验，本单扣款大于余额时展示红色提示并禁用保存；接口兜底返回错误时，弹窗优先展示后端 `message`（如“会员储值余额不足”），不再退化为“请求失败”。
- 手动发券收口到会员系统：新增 `users:member:coupon-grant:button` 权限，会员详情新增“发放优惠券”入口；发券接口只允许该权限调用，并强制目标用户必须为会员 `REGISTERED_USER`。
- 会员搜索支持会员编码 `memberProfile.memberCode`，会员发券与创建订单关联会员时均按“会员编码/手机号/姓名”提示。
- 会员详情“最近优惠券”状态改为按字典展示：未使用、已使用、已过期、已锁定，避免直接暴露枚举值。
- 创建订单优惠券选择顺序改为“先选项目，再选优惠券”；会员可继续在项目前或项目后选择。前端按当前项目过滤会员可用券，支持全场券、指定项目券、指定商品分类券和满减门槛过滤，切换项目会自动清空已选优惠券，提交前也会兜底校验。
- 商品项目下拉接口补充返回 `category` 字段，用于前端提前过滤商品分类券，减少提交后才出现“该优惠券不适用于当前商品分类”的情况。

### 验证
- `npx prisma validate`
- `git diff --check`
- `npx tsc --noEmit --pretty false`：当前仍受既有错误阻断（`CSWorkbench assignDispatch`、部分隐式 any、SystemConfigs 类型），本次改动文件未出现在错误列表。

---

## 2026-08-13 ｜优秀服务者名单与续单分红资格快照

### 本次动作
- 新增优秀服务者管理模块与权限：`users:excellent-staff:page`、`users:excellent-staff:manage:button`；支持候选服务者搜索、批量选入、批量移出。
- 权限树读取时会自动补齐/修正优秀服务者管理页面与维护按钮的父子结构；角色保存时若包含维护按钮，会自动补齐页面权限，避免有按钮权限但后台入口不可见。
- 新增 `excellent_staff` 表维护当前入围名单，仅允许选择未退出平台的服务者。
- 续单派单创建续单组时写入 `bonusEligibleUserIds` 与 `bonusEligibleSnapshot`，将“派单当时是否优秀服务者”固化，避免后续每周轮换影响历史订单结算。
- 续单结算时先按全部续单成员人数切分理论额外分红，再只给派单快照中的优秀服务者发放对应份额；非优秀成员份额不转给其他优秀成员，避免组队套利。
- 续单榜单返回当前入围优秀服务者命中信息，前端仅对当前名单成员做高亮和提示，不回溯改变历史统计。

### 验证
- `npx prisma validate`
- `npx prisma generate`
- `npm run build`
- `yarn build:dev`
- `git diff --check`

---

## 2026-08-12 ｜商品列表筛选与公开菜单客服入口前置优化

### 本次动作
- 管理端商品列表新增 Tab：`全部商品` / `商品列表商品`，后者按 `showInMenuList=true` 快速筛选，便于在开发 SKU 前先整理公开菜单商品池。
- 商品列表顶部“游戏分类”筛选新增“未设置游戏分类”，后端兼容查询 `gameType IS NULL` 或空字符串的历史商品；选择该项时自动禁用二级分类筛选，避免后置分类数据缺失时无法管理。
- `/menu` 老板须知 Banner 底部文字层、商品图底部角标调整为更轻透明的磨砂玻璃效果，减少对底图内容的遮挡。
- `/menu` 右下角新增“召唤客服”浮动入口，复用商品详情抽屉的客服二维码弹窗逻辑，不额外增加一套客服配置链路。

### 后续 SKU 方案确认
- 商品规格功能采用独立 SKU 表方案；订单/派单侧新增 `projectSkuId` 外键，并保留 `skuSnapshot` 快照字段。
- 不把规格直接塞进商品文本或仅存快照，避免后续派单、价格、结算、统计扩展困难。
- 开发顺序：先完成本次商品列表与 `/menu` 前置优化，再拆分数据库迁移、管理端规格维护、公开菜单规格选择、订单/派单链路兼容与历史数据兜底。

### 验证
- `npm run build`
- `yarn build:dev`
- `git diff --check`

---

## 2026-08-07 ｜提现、退店保证金与结算冻结周期规则修正

### 本次动作
- 合规文案收敛：后台高频页面优先弱化“员工/在职/入店/退店”等强雇佣表达，改为“服务者/服务状态/入驻/退出平台”等平台撮合口径；底层枚举和字段暂不改名，避免扩大迁移风险。
- 打手编辑弹窗的服务状态下拉只保留“正常/冻结”，退出平台和限制服务必须走独立退出/清退流程，避免误操作。
- 重新入驻清理正数提现冻结时，同步将待审/处理中/失败的提现申请置为 `CANCELED`；新增管理端 `POST /wallet/withdrawals/cancel` 和提现记录页“废除”按钮，用于修复历史异常提现单。
- 移动端普通后台页面保留 ProLayout 菜单入口，仅 `/m/*` 专用移动端路由继续纯内容展示，修复竖屏无菜单问题。
- 新域名 HTTPS 下“记住登录信息”修复：加密保存后保留本地密钥，避免下次无法解密；跨域旧域名 localStorage 不能自动迁移，需要在新域名重新勾选保存一次。
- 在线服务管理入口统一命名为“服务者在线看板”；新增页面级权限 `service:online-board:page`，拥有 `orders:workbench:create:button` 时，“快捷发单”按钮前移到“刷新状态”按钮旁。
- 权限树增加旧结构自动修正：`menu:workbench`、`orders:workbench:page`、`orders:workbench:create:button` 会在读取权限树时修正为“服务者在线看板”口径；旧 `orders:workbench:page` 授权继续兼容前端入口和后端在线看板接口，避免历史角色看不到入口。
- 修复公开菜单 `/menu`、`/menu/:id` 在权限调整后被登录/权限拦截误伤的问题，并优化公开菜单首屏信息呈现。
- 公开菜单筛选弹窗避开底部备案栏；商品详情无图片时不再展示空内容，改为弹窗提示“详询客服”并展示后台配置的客服二维码。
- 小程序功能配置新增“客服二维码配置”页面和权限 `miniapp:customer-service:page`，支持上传二维码，配置会通过公开接口供 `/menu` 使用。
- 修复公开客服配置接口被全局 JWT 守卫拦截导致 `/menu` 报“公开菜单加载失败”的问题；公开接口使用 `@Public()`，匿名访问不再返回 401。
- 修复 `/miniapp-config/*` 被 `pathname.startsWith('/m')` 误判为移动端纯内容页的问题；移动端纯内容仅限 `/m` 与 `/m/*`，小程序功能配置页面恢复后台左侧菜单。
- 左侧菜单“陪玩中心/打手工作台/我的接单记录”收敛为“服务者中心/服务者工作台/我的服务记录”，权限树同步更新展示名。
- `/users/staff` 命名收敛为“服务者管理”；移动端竖屏下不再横向挤压完整表格，改为保留搜索项 + 单列服务者卡片，展示核心身份、钱包、评级、规则分组和操作按钮。
- 服务者管理取消“服务状态”搜索下拉，改为顶部 4 个状态 Tab（正常/冻结中/已退出/限制服务）直接切换；移动端服务者卡片模式下搜索区不再使用无效的展开/收起按钮。
- 补齐续单榜单：新增 `POST /orders/renewals/leaderboard`，按 `OrderRenewalGroup.status = SETTLED` 的续单组合聚合，支持 `dimension=DAY/WEEK/MONTH` 与 `startAt/endAt` 时间筛选；后台订单管理新增“续单榜单”页面。
- 提现审核驳回分支允许可用余额仍为负：驳回时释放提现冻结到可用余额，用于冲抵线下费用、罚单、设备租赁等欠款；审核通过仍保持严格余额桶校验。
- 设备租赁费提现限制口径收敛：提前生成的未来账单不限制提现，仅进入缴费日前 1 天窗口的待缴账单或即将出账金额才需要在提现时预留。
- 普通退店保证金规则落地：入店不足规则押金不退天数、有效接单量少于 50 单、或保证金未缴满规则阈值时，保证金不退；有效接单量只统计已接单、未拒单、派单已完成或已存档的记录。
- 退店补扣保证金缺口时最多扣到可用余额为 0，不允许把账户余额扣成负数；未补齐部分通过 `depositTopUpUnpaidAmount` 返回并由前端展示。
- 员工规则分组与提现/退店规则新增结算冻结周期字段：`settlementFreezeExperienceDays` 用于体验单/福袋单，兜底 3 天；`settlementFreezeRegularDays` 用于普通单，兜底 7 天。
- 订单结算冻结周期从统一配置改为逐人匹配员工规则分组；同一订单的不同结算对象可以拥有不同解冻周期。`applySettlementPlanTx` 保留汇总 `freezeDays/freezeStartAt/freezeEndAt`，并新增 `freezeInfoByUser` 用于排查逐人冻结信息。
- 打手新增/编辑中的“员工规则分组”仅支持单选；为兼容历史数据和接口，底层字段暂保留 `User.staffTags` 与规则配置 `tags/tagCodes`，保存时由前后端共同限制最多一个分组，后续真正的员工标签体系不要复用该字段。

### 验证
- `yarn test wallet-withdrawals.service.spec.ts --runInBand`
- `yarn test users.service.spec.ts --runInBand`
- `yarn test staff-rule-engine.service.spec.ts settlement-freeze.rule.spec.ts --runInBand`
- `yarn build`
- `yarn build:dev`
- `git diff --check`

## 2026-08-07 ｜设备租赁费其他渠道缴费确认

### 本次动作
- 明确设备租赁费账单状态语义：`WAIVED` 为减免，不等同于已缴费；`PAID` 为已缴清。
- 新增后端接口 `POST /equipment-rental-fees/bills/confirm-paid-external`，用于管理员确认账单已通过微信收款码、现金、银行转账等其他渠道缴费；该操作不扣员工钱包、不写 `EQUIPMENT_RENTAL_FEE` 钱包流水，账单更新为 `PAID`、`paidAmount=remainingAmount`、`remainingAmount=0`、`walletTxId=null`。
- `system-admin` 设备租赁费页面新增“其他渠道已缴”操作，弹窗要求填写缴费说明；账单状态展示区分“已扣费”和“已缴费”。
- 补充单测覆盖其他渠道缴费确认，确保不会修改钱包余额或创建钱包流水。

### 验证
- `npm test -- equipment-rental-fee.service.spec.ts --runInBand`
- `npm run build`
- `yarn build:dev`

---

## 2026-08-06 ｜后台前端体验与移动端显示优化

### 本次动作
- `system-admin` 订单列表已补充移动端访问优化：移动端优先呈现订单核心内容，降低表格横向阅读成本。
- 侧边栏左下角用户中心改为稳定 `menuFooterRender` 渲染，宽屏和窄屏均保留用户入口，折叠时仅展示头像，避免被消息中心/公告中心挤掉。
- 公告中心弹窗改为左侧列表 + 右侧详情布局，支持选中公告、查看正文、标记已读；左侧列表宽度已缩窄到 256px。
- 登录页和后台页备案展示模块已调整：ICP备案固定底部展示，登录页首屏可见，后台 PC 端和移动端避免被内容遮挡，移动端全屏页面自动隐藏。
- 创建订单共用弹窗 `../system-admin/src/pages/Orders/components/OrderForm.tsx` 已限制视口高度：弹窗顶部固定留白，表单主体内部滚动，底部保存/取消按钮保持可见；订单列表、订单详情、服务者在线看板三处创建/编辑入口同步生效。
- 钱包流水类型展示已补齐：后端 `meta` 字典补充续单分红/冲正、会员充值/消费、线下费用、设备租赁、退店等 `WalletBizType` 文案；前端钱包流水、用户钱包抽屉、单用户预核算页面同步补齐中文展示、标签颜色和续单分红已冲正识别。
- 订单详情页收益概览和对账详情已纳入续单分红：`结算参考 = OrderSettlement.finalEarnings 汇总 + 已结算未冲正续单分红`；钱包对账同步统计 `ORDER_RENEWAL_BONUS` 与 `ORDER_RENEWAL_BONUS_REVERSAL`，退款/重算冲正后的续单分红不再计入当前成本。
- 修正续单分红钱包流水关联：新发放的 `ORDER_RENEWAL_BONUS` 钱包流水写入 `orderId/dispatchId`；订单详情对账兼容历史缺 `orderId` 的分红流水，通过 `OrderRenewalBonus.walletTransactionId` 纳入钱包净额和按人对账；新增迁移 `20260806122000_backfill_order_renewal_bonus_wallet_order_id` 回填历史续单分红流水订单关联。
- 订单财务记录成本口径同步纳入续单分红：重建 `OrderFinanceRecord` 时将已结算未冲正续单分红计入玩家成本，避免财务毛利净额与订单详情对账净额不一致。

### 验证
- `npm run build`
- `npx prisma validate`
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

## 2026-08-11 ｜服务者管理敏感命名收敛

### 本次动作
- 服务者管理内“员工评级”统一调整为“服务者评级”，“员工规则分组”统一调整为“服务者规则分组”。
- 评级管理菜单和权限树展示名从“评级管理”调整为“服务者评级”，并新增 migration 更新线上已有权限记录展示名。
- 服务者评级适用范围文案从“线上陪玩/线下陪玩”调整为“线上服务/线下服务”。
- 本次仅调整前端展示、权限展示名和用户可见错误文案，底层 `StaffRating`、`staffRating`、`staffTags` 等字段不改名，降低迁移风险。

---

## 2026-08-11 ｜公开菜单图片预览切换 PhotoSwipe

### 本次动作
- `/menu` 公开菜单页商品详情图、Banner/协议图预览从 Ant Design Image Preview 切换为 PhotoSwipe。
- 移动端竖屏点击图片后进入沉浸式全屏相册预览，支持手势缩放、滑动切换、下拉关闭，更接近小程序图片预览体验。
- 点击前自动读取图片自然尺寸，避免预览时因缺少宽高导致压缩、跳动或展示比例异常。

---

## 2026-08-11 ｜续单榜单组合展示异常修复

### 本次动作
- 修复续单榜单“续单组合”展示 `[object Object]` 的问题：后端统计榜单时对组合成员姓名和用户 ID 做对象/字符串兼容格式化。
- 前端续单榜单展示增加兜底格式化，兼容历史接口数据中 `memberNames`、`memberUserIds` 为对象数组的情况。
- 搜索命中也同步使用格式化后的成员姓名、ID、订单号，避免对象型历史数据影响筛选。

---

## 2026-08-11 ｜角色权限支持页面与按钮独立授权

### 本次动作
- 修复角色管理权限勾选树的父子级联问题：页面权限与按钮权限改为独立勾选，支持“只给页面访问权限、不给任何按钮权限”。
- 保留后端角色保存时“按钮权限自动补父级页面权限”的兜底，避免只勾按钮导致入口或接口权限链断裂。
- 该调整降低了为展示页面入口而被迫授予按钮操作权限的风险。

---

## 2026-08-11 ｜提现申请历史异常直接废除入口

### 本次动作
- 针对生产已出现的“账户已清零、冻结流水已冲正，但提现申请仍残留”的历史异常场景，确认后端 `POST /wallet/withdrawals/cancel` 支持安全废除：若仍存在足额提现冻结则释放回可用余额；若冻结已被历史修复冲正，则仅将提现申请置为 `CANCELED`，不再改动账户余额。
- 管理端提现审批页新增“直接废除”按钮，待审/已通过/打款中/打款失败等未终态申请可直接废除，避免异常单卡在审核流程中无法处理。
- 管理端提现记录页将原“废除”按钮文案调整为“直接废除”，说明其适用于历史异常残留提现申请清理。

---

## 2026-08-18 ｜会员体系后台闭环检查与补齐

### 本次动作
- 会员码生成规则调整为 8 位纯数字，从 `15000000` 起递增生成；自动跳过任意连续 3 位及以上相同数字的优质号段，例如 `888`、`8888`、`555`、`6666`。
- 会员档案自动创建入口统一使用新会员码规则，包括后台会员资产初始化和订单消费自动生成会员档案两条路径。
- 会员管理新增“全部会员 / 有效会员 / 无效会员”切换；有效会员按储值余额、积分、累计充值、累计消费、成长值或未过期可用优惠券任一存在来识别。
- 后台会员手动充值成功后新增图片版“会员储值小票”，风格与订单小票一致，便于保存后发送老板核对；小票展示会员、会员编码、充值单号、本次储值、赠送金额、到账合计、成长值、积分、赠送优惠券、备注和操作时间。
- 会员详情“最近充值”最新一条记录新增“充值小票”入口，支持历史最近充值单补开图片版小票。
- 新增独立“会员充值记录”模块，位于账户中心下；支持按关键词、状态、渠道、充值时间筛选，列表展示会员、会员编码、充值方案、支付金额、到账金额、赠送权益与充值时间，并支持每条记录补开图片版充值小票。
- 后端新增 `GET /member/recharge-orders` 分页接口，使用 `wallet:member-recharges:page` 页面权限控制；新增 migration `20260818163000_add_member_recharge_records_permission` 写入权限并默认授权给 `SUPER_ADMIN`、`FINANCE_MANAGER`。
- 充值方案新增生效时间 `effectiveFrom` 与截止时间 `effectiveTo`，为空表示不限制；前台/小程序及后台手动充值选择方案时只展示启用且处于有效期内的方案，接口层同步拦截未生效或已截止方案。
- 管理端充值方案列表展示有效期和“生效中/未生效/已截止/停用”状态，新建/编辑弹窗支持配置生效时间与截止时间。
- 管理端充值方案弹窗作为复杂业务表单优化样板：新增统一 `bc-admin-form-modal` / `bc-admin-form` 样式，采用顶部摘要卡、业务分区、双列网格和移动端单列自适应，后续类似弹窗按该规范逐步迁移。
- 批量优化第一批高频/高风险后台弹窗表单：创建/编辑订单、会员手动充值、服务者退出平台、服务者清退、新增用户、编辑用户、会员等级、提现审核均接入统一表单视觉规范，重点改善长表单纵向堆叠、金额信息不突出、风险操作信息难核对的问题。
- 优化弹窗摘要卡细节：摘要区改为滚动容器内吸顶展示，长表单滑动时金额/状态核对信息保持可见；摘要卡新增 `success/danger/warning/info` 语义色，创建订单收款状态按已付款绿色、未付款红色展示。
- 会员赠送优惠券数量统一按 `优惠券名称 ×数量` 展示，不再使用 `#` 作为数量或模板标识展示；充值弹窗内优惠券选项改为“模板ID”说明，避免和数量表达混淆。
- 确认后台派单创建订单已支持 `paymentChannel=BALANCE` 会员储值扣款，并且订单小票已展示储值扣除、储值余额与预计增加积分。
- 修复订单详情页服务者侧订单小票遗漏会员储值信息的问题；现在服务者/客户小票均会展示商品小计、实付金额、支付方式、储值扣除、储值余额和预计增加积分。
- 订单详情接口补充 `paymentChannel`、`paymentChannelLabel`；前端订单详情与小票优先展示真实支付渠道，会员储值扣款不再兜底显示为“线下收款”。
- 修复服务者在线看板快捷发单、订单列表创建订单二次组装 payload 时遗漏 `paymentChannel`、`customerUserId`、`settlementAmount` 等字段的问题，避免选择会员储值且已付款后订单仍落为非储值/未付款。
- 修复通用创建订单弹窗会员联动：选择关联会员后自动切换为“会员储值”并勾选已付款；选择“会员储值”也会自动勾选已付款。后端同步兜底，`paymentChannel=BALANCE` 时强制按已付款扣会员储值余额并写入会员钱包支付流水。
- 修复会员详情最近订单状态展示未走字典的问题；补齐会员储值支付成功后即时累计订单积分/成长值/累计消费，后续确认结单仍通过订单维度幂等保护避免重复累计。
- 修复会员详情最近充值状态/渠道展示未走字典的问题，将 `SUCCESS/PENDING/FAILED/CLOSED` 与 `MANUAL/WECHAT/MINIAPP_WECHAT` 统一展示为中文标签。
- 会员手动充值弹窗补充积分/成长值规则说明与实时预览：充值本金 1 元 = 1 成长值，赠送成长值为额外增加；消费 10 元 = 1 积分，手动充值积分为额外赠送，并明确展示本次将新增的成长值和积分。

### 后续可选增强
- 如后续要运营优质会员码，可新增独立号池表，支持保留、释放、指定分配和售价/权益配置。

---

## 2026-08-17 ｜续单榜单关联订单与订单详情续单标识

### 本次动作
- 续单榜单按组合聚合时返回本次统计范围内的全部关联订单，包含订单号、结算时间、续单金额和续单分红，便于核对榜单统计来源。
- 管理端续单榜单将“最近结算”拆为“关联订单”和“最近结算时间”，列表展示部分订单号，订单较多时通过抽屉查看全部。
- 订单详情基础信息区新增“是否续单”字段，展示“是/否”以及当前订单勾选的续单服务者。

---

## 2026-08-15 ｜保证金对账按录入来源分组

### 本次动作
- 保证金对账接口调整为先按录入来源汇总：有 `operatorId` 的流水按录入人分组，无 `operatorId` 的流水统一归为“系统扣费/系统处理”。
- 汇总行支持下钻查看对应来源下的服务者维度统计，明细仅展示服务者当前状态、保证金总和、流水数和最近变动时间。
- 管理端保证金对账页面同步改为“来源汇总 + 服务者明细抽屉”的交互，保留原页面权限与路由。
- 统计继续兼容历史旧表 `WalletDepositTransaction` 与当前表 `wallet_deposit_transactions` 的合并口径。

---

## 2026-08-25 ｜商行租号风控查询角色

### 本次动作
- 新增角色 `RENTAL_ACCOUNT_OPERATOR`（商行租号专员），默认仅授予 `users:staff-rental-risk:page` 页面权限。
- 新增权限 `users:staff-rental-risk:page`（租号风控查询），挂载在用户管理菜单下，并同步 seed、migration 与运行时权限树补齐逻辑。
- 管理端新增 `/users/rental-risk` 页面，复用服务者列表但切换为只读风控视图，不展示新增、编辑、分配角色、退店、清退、提现开关等管理操作。
- 服务者列表钱包字段补充 `withdrawFrozenBalance`、`nonWithdrawFrozenBalance` 与 `rentalRiskReferenceBalance`，租号风控参考余额口径为：可用余额 + 非提现冻结金额 + 保证金。
- 租号风控页新增三色警示灯：低于 500 红色、500-1000 黄色、1000 以上绿色，并明确展示可用、冻结、保证金、提现冻结、非提现冻结，避免把提现冻结资金误判为可覆盖风险余额，同时允许结算冻结等后续可释放资产进入参考。
- 修复租号风控角色访问复用用户页时触发 `staff-rule-engine/get` 权限不足的问题：规则读取接口补充 `users:staff-rental-risk:page` 只读权限，前端租号风控页跳过无关评级/规则配置加载。
- 信息安全优化：租号风控查询页不再默认加载服务者数据，必须输入服务者 ID/手机号/姓名后查询；手机号仅展示前三后两位，后端也对空关键词查询返回空列表，避免绕过前端拉取全量服务者余额。

---

## 2026-08-20 ｜公开菜单微信审核模式

### 本次动作
- 在小程序/公开菜单客服二维码配置中新增“微信审核模式”开关，默认关闭。
- 开启审核模式后，公开菜单 `/menu` 自动切换为合规说明页，仅展示平台服务范围、服务流程、合规说明、用户须知和备案信息。
- 审核模式下隐藏商品价格、客服二维码、下单/咨询强引导、浮动客服入口等高风险交易导流元素，用于微信外链申诉审核期间降低误判风险。

---

## 2026-08-20 ｜服务者编辑规则核算展示优化

### 本次动作
- 服务者编辑弹窗底部规则摘要改为“规则核算”卡片，展示内容对齐退店核算口径，包含规则分组、命中规则、保证金阈值、首次提现限制、退店冷却期、押金不退限制、冻结周期等关键规则。
- 编辑弹窗接入完整服务者规则配置，切换“服务者规则分组”时规则核算内容实时刷新，不再依赖用户列表返回的旧 matched 字段。
- 暂时隐藏服务者编辑里的“服务者信息”模块，不再展示/编辑服务者工作模式和线下入职时间。
- 服务者编辑提交时不再携带 `workMode/offlineJoinedAt`，避免历史线下数据因线下入职时间缺失触发表单校验或被误改为线上。
- 修复服务者规则分组改名后“命中规则”仍显示首次创建名称的问题：规则名称不再独立保留旧值，统一按当前分组名称派生，后端读取历史配置时也会自动归一化显示。

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
- 新增员工和退店重新入店都强制要求员工规则分组，保证押金、提现、冷却期、自动冻结等规则有匹配依据。
- `system-admin` 打手管理新增弹窗默认并锁定员工身份，员工规则分组必选，余额不可编辑；打手列表不再展示“分配角色”按钮。
- 打手编辑增加安全锁：余额不可编辑；非超管只能修改员工在职状态，且仅限正常/冻结，退店和黑名单仍必须走独立退店/清退流程。

---

## 2026-08-03 ｜SUPER_ADMIN 与 FINANCE_ADMIN 冲突修复

### 本次动作
- 新增 Prisma migration `20260803033000_fix_super_admin_finance_role`，随发布创建/补齐 `SUPER_ADMIN` 角色，将非超管历史 `FINANCE_ADMIN` 角色用户迁移到 `FINANCE_MANAGER`，并删除旧 `FINANCE_ADMIN` 角色。
- `SUPER_ADMIN` 是唯一超级管理员角色；`FINANCE_MANAGER` 回归财务管理员，预置财务、钱包和必要订单权限，不再享受全局权限旁路。
- 后端 `PermissionsGuard`、钱包、订单、用户、会员等按钮/服务权限判断统一支持 `userType=SUPER_ADMIN` 或 `roleName=SUPER_ADMIN`，避免账号身份与角色不通用。
- `system-admin` 全局 access、订单、服务者在线看板和奖池页同步改为只把 `SUPER_ADMIN` 识别为超管，不再兼容 `FINANCE_ADMIN`。

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
- 服务者在线看板快捷发单按钮迁移到独立页面权限 `service:online-board:page` 下。
- 订单列表创建/删除按钮挂在 `orders:list:page` 下。
- 订单详情业务按钮挂在 `orders:detail:page` 下，并同步前端展示和后端接口校验。

### 权限 key
- `orders:workbench:create:button`
- `orders:list:create:button`、`orders:list:delete:button`
- `orders:detail:receipt:button`、`orders:detail:mark-paid:button`、`orders:detail:refund:button`、`orders:detail:edit:button`、`orders:detail:dispatch:button`、`orders:detail:update-paid:button`
- `orders:detail:confirm-complete:button`、`orders:detail:admin-accept:button`、`orders:detail:archive:button`、`orders:detail:complete:button`
- `orders:detail:rollback-accepted:button`、`orders:detail:rollback-archived:button`
- `orders:detail:update-participants:button`、`orders:detail:settlement-adjust:button`、`orders:detail:archived-progress-fix:button`、`orders:detail:recalculate-settlements:button`
