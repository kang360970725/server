import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { OrderStatus, PlayerWorkStatus, StaffEmploymentStatus, UserType, WalletBizType, WalletDirection, WalletTxStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { miniOk } from './mini.response';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { WechatPayService } from './wechat-pay.service';
import { getWechatOrderNotifyUrlFromConfig } from './wechat-callback.util';
import { SystemConfigService } from '../system-config/system-config.service';
import { MemberService } from '../member/member.service';
import { WalletService } from '../wallet/wallet.service';
import { MiniSubscribeMessageService } from '../notifications/mini-subscribe-message.service';

@ApiTags('mini-orders')
@ApiBearerAuth()
@Controller('mini/orders')
export class MiniOrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly wechatPayService: WechatPayService,
    private readonly systemConfigService: SystemConfigService,
    private readonly memberService: MemberService,
    private readonly walletService: WalletService,
    private readonly miniSubscribeMessageService: MiniSubscribeMessageService,
  ) {}

  private ownOrderWhere(uid: number, id?: number) {
    return {
      ...(id ? { id } : {}),
      OR: [
        { customerUserId: uid },
        { dispatcherId: uid },
      ],
    } as any;
  }

  private async resolveMiniOrderPlayerIds(body: any) {
    const rawPlayerIds = Array.isArray(body?.playerIds) ? body.playerIds : [];
    if (rawPlayerIds.length > 1) {
      throw new BadRequestException('指定陪玩师仅支持选择 1 名');
    }

    const playerId = Number(rawPlayerIds[0] ?? body?.dispatcherId ?? body?.playerId ?? 0);
    if (!playerId) return [];

    const player = await this.prisma.user.findFirst({
      where: {
        id: playerId,
        userType: UserType.STAFF,
        staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
        workStatus: PlayerWorkStatus.IDLE,
        workMode: 'ONLINE',
        workOnlineExpiresAt: { gt: new Date() },
      },
      select: { id: true },
    });

    if (!player) {
      throw new BadRequestException('指定陪玩师当前不可接单');
    }

    return [player.id];
  }

  private buildPaymentNo(prefix: string, orderId: number) {
    const ts = Date.now();
    return `${prefix}_${orderId}_${ts}`;
  }

  private buildWechatPaymentNo(orderId: number) {
    const ts = Date.now();
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `WX_${orderId}_${ts}_${suffix}`;
  }

  private toMoney2(value: any): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.trunc(n * 100) / 100;
  }

  private normalizeReviewLabel(score: number) {
    if (score <= 2) return '差评';
    if (score === 3) return '中评';
    return '好评';
  }

  private normalizeReviewText(input: any) {
    return String(input || '').trim();
  }

  private async applyWechatPaymentSuccess(
    orderId: number,
    paymentRef: { id: number | null; orderId: number },
    decrypted: any,
  ) {
    const paidFen = Number(decrypted?.amount?.payer_total ?? 0);
    const notifiedTime = typeof decrypted?.success_time === 'string' ? new Date(decrypted.success_time) : null;
    const paidAt = notifiedTime && Number.isFinite(notifiedTime.getTime()) ? notifiedTime : new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const currentOrder = await tx.order.findUnique({
        where: { id: orderId },
        select: { isTestPayment: true },
      });
      const isTestPayment = Boolean(currentOrder?.isTestPayment);
      const payment = paymentRef.id
        ? await tx.orderPayment.update({
            where: { id: paymentRef.id },
            data: {
              status: 'SUCCESS',
              amount: paidFen > 0 ? Number((paidFen / 100).toFixed(2)) : 0,
              isTestPayment,
              prepayId: String(decrypted?.prepay_id || ''),
              transactionId: String(decrypted?.transaction_id || ''),
              payerOpenid: String(decrypted?.payer?.openid || ''),
              notifyRaw: decrypted,
              paidAt,
            },
            select: { id: true },
          })
        : await tx.orderPayment.upsert({
            where: { paymentNo: String(decrypted?.out_trade_no || '') },
            create: {
              orderId,
              paymentNo: String(decrypted?.out_trade_no || ''),
              channel: 'MINIAPP_WECHAT',
              status: 'SUCCESS',
              amount: paidFen > 0 ? Number((paidFen / 100).toFixed(2)) : 0,
              isTestPayment,
              prepayId: String(decrypted?.prepay_id || ''),
              transactionId: String(decrypted?.transaction_id || ''),
              payerOpenid: String(decrypted?.payer?.openid || ''),
              notifyRaw: decrypted,
              paidAt,
            },
            update: {
              status: 'SUCCESS',
              amount: paidFen > 0 ? Number((paidFen / 100).toFixed(2)) : 0,
              isTestPayment,
              prepayId: String(decrypted?.prepay_id || ''),
              transactionId: String(decrypted?.transaction_id || ''),
              payerOpenid: String(decrypted?.payer?.openid || ''),
              notifyRaw: decrypted,
              paidAt,
            },
            select: { id: true },
          });

      return tx.order.update({
        where: { id: orderId },
        data: {
          isPaid: true,
          payStatus: 'SUCCESS',
          paymentTime: paidAt,
          paidAmount: paidFen > 0 ? Number((paidFen / 100).toFixed(2)) : undefined,
          latestPaymentId: payment.id,
        },
        select: {
          id: true,
          isPaid: true,
          payStatus: true,
          paidAmount: true,
          latestPaymentId: true,
        },
      });
    });
    try {
      await this.miniSubscribeMessageService.pushOrderProgressMessage(orderId, '订单支付成功，请留意后续订单进度', '待派单');
    } catch {}
    return updated;
  }

  @Get()
  @ApiOperation({ summary: '订单列表（当前用户）' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'status', required: false, enum: OrderStatus })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: {
          list: [
            {
              id: 1001,
              autoSerial: 'PW202605101024',
              status: 'WAIT_ASSIGN',
              paidAmount: '128.00',
              createdAt: '2026-05-14T01:00:00.000Z',
              project: { id: 1, name: '王者荣耀陪玩' },
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
        },
      },
    },
  })
  async list(
    @Req() req: any,
    @Query('page') pageRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('status') status?: OrderStatus,
  ) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    const page = Math.max(1, Number(pageRaw ?? 1));
    const limit = Math.min(50, Math.max(1, Number(limitRaw ?? 20)));

    const where: any = this.ownOrderWhere(uid);
    if (status) where.status = status;

    const [list, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          autoSerial: true,
          status: true,
          payStatus: true,
          isPaid: true,
          receivableAmount: true,
          paidAmount: true,
          projectSnapshot: true,
          createdAt: true,
          paymentTime: true,
          latestPayment: {
            select: {
              amount: true,
              status: true,
            },
          },
          project: { select: { id: true, name: true, coverImage: true } },
          dispatcher: {
            select: { id: true, name: true, phone: true, avatar: true, userType: true },
          },
          currentDispatch: {
            select: {
              id: true,
              status: true,
              participants: {
                where: { isActive: true },
                orderBy: { id: 'asc' },
                select: {
                  id: true,
                  user: {
                    select: {
                      id: true,
                      name: true,
                      phone: true,
                      avatar: true,
                      workStatus: true,
                      userType: true,
                      staffRating: {
                        select: {
                          id: true,
                          name: true,
                          rate: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    const normalizedList = (list || []).map((row: any) => {
      const snapshotCoverImage = String(row?.projectSnapshot?.coverImage || '').trim();
      const currentCoverImage = String(row?.project?.coverImage || '').trim();
      return {
        ...row,
        project: row?.project
          ? {
              ...row.project,
              coverImage: currentCoverImage || snapshotCoverImage || null,
            }
          : row?.project,
      };
    });

    return miniOk({
      list: normalizedList,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  }

  @Get('subscribe-message/config')
  @ApiOperation({ summary: '下单页订阅消息模板配置' })
  async subscribeMessageConfig(@Query('scene') sceneRaw?: string) {
    const scene = String(sceneRaw || 'ORDER_PLACE').trim().toUpperCase() as 'ORDER_PLACE' | 'AFTER_SALES_APPLY' | 'MARKETING_DETAIL';
    return miniOk({
      scene,
      templates: await this.miniSubscribeMessageService.getTemplateOptionsByScene(scene),
    });
  }

  @Post('subscribe-message/record')
  @ApiOperation({ summary: '记录下单页订阅消息授权结果' })
  async recordSubscribeMessage(@Req() req: any, @Body() body: any) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return miniOk(await this.miniSubscribeMessageService.recordSubscribeRequest(uid, body));
  }

  @Get(':id')
  @ApiOperation({ summary: '订单详情（当前用户）' })
  @ApiParam({ name: 'id', example: 1001 })
  @ApiOkResponse({
    schema: {
      example: { code: 0, message: 'ok', data: { id: 1001, autoSerial: 'PW202605101024' } },
    },
  })
  async detail(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    const own = await this.prisma.order.findFirst({
      where: this.ownOrderWhere(uid, id),
      select: {
        id: true,
        isPaid: true,
        latestPayment: { select: { channel: true, status: true } },
      },
    });
    if (!own) throw new BadRequestException('订单不存在或无权限访问');

    const detail = await this.ordersService.getOrderDetail(id);
    return miniOk(detail);
  }

  @Post('create')
  @ApiOperation({ summary: '创建订单' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['projectId', 'paidAmount'],
        properties: {
        projectId: { type: 'number', example: 1 },
        paidAmount: { type: 'number', example: 128 },
        receivableAmount: { type: 'number', example: 128 },
        orderQuantity: { type: 'number', example: 1 },
        customerGameId: { type: 'string', example: '猫猫玩家' },
        inviter: { type: 'string', example: '邀请码' },
        customClubRate: { type: 'number', example: 0.1 },
        isGifted: { type: 'boolean', example: false },
        isPaid: { type: 'boolean', example: false },
        userCouponId: { type: 'number', example: 12 },
        dispatcherId: { type: 'number', example: 10086, description: '指定陪玩师ID' },
      },
    },
  })
  @ApiOkResponse({
    schema: {
      example: { code: 0, message: '下单成功', data: { id: 1001, autoSerial: 'PW202605101024' } },
    },
  })
  async create(@Req() req: any, @Body() body: any) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    await this.memberService.assertMiniPhoneBound(uid);
    const playerIds = await this.resolveMiniOrderPlayerIds(body);
    const projectId = Number(body?.projectId);
    const orderQuantity = Math.max(1, Math.floor(Number(body?.orderQuantity ?? 1)));
    const customerGameId = await this.memberService.assertMiniGameCardForOrder(uid, projectId, body?.customerGameId);
    const project = await this.prisma.gameProject.findUnique({
      where: { id: projectId },
      select: { id: true, price: true },
    });
    if (!project) throw new BadRequestException('项目不存在');

    const payableAmount = this.toMoney2(Number(project.price || 0) * orderQuantity);
    if (payableAmount <= 0) throw new BadRequestException('项目价格异常，暂不可下单');

    const payload = {
      projectId,
      receivableAmount: payableAmount,
      paidAmount: payableAmount,
      orderQuantity,
      customerGameId,
      inviter: body?.inviter ? String(body.inviter) : undefined,
      isGifted: false,
      isPaid: false,
      userCouponId: body?.userCouponId == null ? undefined : Number(body.userCouponId),
      ...(playerIds.length ? { playerIds } : {}),
    };

    if (!payload.projectId) throw new BadRequestException('projectId 必填');

    const order = await this.ordersService.createOrder(payload as any, uid, {
      scene: 'MINIAPP',
      dispatcherId: null,
      customerUserId: uid,
    });
    try {
      await this.miniSubscribeMessageService.pushOrderProgressMessage(
        Number((order as any)?.id || 0),
        '订单已创建，等待派单',
        '待派单',
      );
    } catch {}
    return miniOk(order, '下单成功');
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: '取消订单' })
  @ApiParam({ name: 'id', example: 1001 })
  @ApiOkResponse({
    schema: {
      example: { code: 0, message: '订单已取消', data: { success: true } },
    },
  })
  async cancel(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    const own = await this.prisma.order.findFirst({
      where: this.ownOrderWhere(uid, id),
      select: {
        id: true,
        isPaid: true,
        latestPayment: { select: { channel: true, status: true } },
      },
    });
    if (!own) throw new BadRequestException('订单不存在或无权限操作');
    const data = await this.ordersService.cancelOrder(id, uid, body?.remark ? String(body.remark) : undefined);
    return miniOk(data, '订单已取消');
  }

  @Post(':id/refund')
  @ApiOperation({ summary: '重新申请退款' })
  @ApiParam({ name: 'id', example: 1001 })
  @ApiOkResponse({
    schema: {
      example: { code: 0, message: '退款处理成功', data: { success: true } },
    },
  })
  async refund(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    const own = await this.prisma.order.findFirst({
      where: this.ownOrderWhere(uid, id),
      select: {
        id: true,
        status: true,
        isPaid: true,
        latestPayment: { select: { channel: true, status: true } },
      },
    });
    if (!own) throw new BadRequestException('订单不存在或无权限操作');
    const data = await this.ordersService.refundOrder(id, uid, body?.remark ? String(body.remark) : '用户重新申请退款');
    return miniOk(data, '退款处理成功');
  }

  @Post(':id/confirm-complete')
  @ApiOperation({ summary: '确认结单（当前用户）' })
  @ApiParam({ name: 'id', example: 1001 })
  @ApiOkResponse({
    schema: {
      example: { code: 0, message: '确认结单成功', data: { success: true } },
    },
  })
  async confirmComplete(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    const own = await this.prisma.order.findFirst({
      where: this.ownOrderWhere(uid, id),
      select: {
        id: true,
        status: true,
        isPaid: true,
        latestPayment: { select: { channel: true, status: true } },
      },
    });
    if (!own) throw new BadRequestException('订单不存在或无权限操作');
    const data = await this.ordersService.confirmCompleteOrder(id, uid, {
      remark: body?.remark ? String(body.remark) : '用户确认结单',
    });
    return miniOk(data, '确认结单成功');
  }

  @Post(':id/pay-confirm')
  @ApiOperation({ summary: '确认支付（业务确认）' })
  @ApiParam({ name: 'id', example: 1001 })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['paidAmount'],
      properties: {
        paidAmount: { type: 'number', example: 128 },
      },
    },
  })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: '支付确认成功',
        data: {
          id: 1001,
          autoSerial: 'PW202605101024',
          isPaid: true,
          paidAmount: '128.00',
          paymentTime: '2026-05-14T03:00:00.000Z',
        },
      },
    },
  })
  async payConfirm(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    const own = await this.prisma.order.findFirst({
      where: this.ownOrderWhere(uid, id),
      select: { id: true, isPaid: true },
    });
    if (!own) throw new BadRequestException('订单不存在或无权限操作');
    if (own.isPaid) {
      return miniOk({
        id,
        isPaid: true,
        alreadyPaid: true,
      }, '该订单已支付');
    }

    const data = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT id FROM `Order` WHERE id = ? FOR UPDATE', Number(id));
      await tx.$queryRawUnsafe('SELECT userId FROM `wallet_accounts` WHERE userId = ? FOR UPDATE', Number(uid));

      const currentOrder = await tx.order.findUnique({
        where: { id },
        select: { id: true, isPaid: true, paidAmount: true, finalPayableAmount: true, receivableAmount: true },
      });
      if (!currentOrder) throw new BadRequestException('订单不存在或无权限操作');
      if (currentOrder.isPaid) {
        return tx.order.findUnique({
          where: { id },
          select: {
            id: true,
            autoSerial: true,
            isPaid: true,
            payStatus: true,
            paidAmount: true,
            paymentTime: true,
          },
        });
      }

      const paidAmount = this.toMoney2(
        Number(currentOrder.finalPayableAmount ?? currentOrder.paidAmount ?? currentOrder.receivableAmount ?? 0),
      );
      if (paidAmount <= 0) {
        throw new BadRequestException('订单应付金额异常，无法确认支付');
      }

      await this.walletService.ensureWalletAccount(uid, tx as any);
      const account = await tx.walletAccount.findUnique({
        where: { userId: uid },
        select: { availableBalance: true, frozenBalance: true },
      });
      const availableBalance = Number(account?.availableBalance ?? 0);
      if (availableBalance < paidAmount) {
        throw new BadRequestException('余额不足');
      }

      const payment = await tx.orderPayment.create({
        data: {
          orderId: id,
          paymentNo: this.buildPaymentNo('BAL', id),
          channel: 'BALANCE',
          status: 'SUCCESS',
          amount: paidAmount,
          paidAt: new Date(),
        },
        select: { id: true, paymentNo: true },
      });

      const accountAfter = await tx.walletAccount.update({
        where: { userId: uid },
        data: {
          availableBalance: { decrement: paidAmount },
        },
        select: {
          availableBalance: true,
          frozenBalance: true,
        },
      });

      await tx.walletTransaction.create({
        data: {
          userId: uid,
          direction: WalletDirection.OUT,
          bizType: WalletBizType.MEMBER_ORDER_CONSUME,
          amount: paidAmount,
          status: WalletTxStatus.AVAILABLE,
          // 余额支付单独标识，便于和微信支付/其他渠道区分
          sourceType: 'ORDER_PAYMENT_BALANCE',
          sourceId: payment.id,
          orderId: id,
          availableAfter: Number(accountAfter?.availableBalance ?? 0),
          frozenAfter: Number(accountAfter?.frozenBalance ?? 0),
        } as any,
      });

      return tx.order.update({
        where: { id },
        data: {
          isPaid: true,
          payStatus: 'SUCCESS',
          paidAmount,
          paymentTime: new Date(),
          latestPaymentId: payment.id,
        },
        select: {
          id: true,
          autoSerial: true,
          isPaid: true,
          payStatus: true,
          paidAmount: true,
          paymentTime: true,
          latestPayment: {
            select: {
              channel: true,
              status: true,
              amount: true,
            },
          },
        },
      });
    });
    try {
      await this.miniSubscribeMessageService.pushOrderProgressMessage(id, '订单支付成功，请留意后续订单进度', '待派单');
    } catch {}
    return miniOk(data, '支付确认成功');
  }

  @Post(':id/wechat-prepay')
  @ApiOperation({ summary: '微信支付预下单（JSAPI）' })
  async wechatPrepay(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    const order = await this.prisma.order.findFirst({
      where: this.ownOrderWhere(uid, id),
      select: {
        id: true,
        autoSerial: true,
        paidAmount: true,
        isTestPayment: true,
        isPaid: true,
        status: true,
        project: { select: { name: true } },
        latestPayment: {
          select: {
            id: true,
            paymentNo: true,
            status: true,
            amount: true,
            isTestPayment: true,
            payerOpenid: true,
            prepayId: true,
          },
        },
      },
    });
    if (!order) throw new BadRequestException('订单不存在或无权限操作');
    if (order.isPaid) {
      return miniOk({
        orderId: id,
        alreadyPaid: true,
        isPaid: true,
      }, '该订单已支付');
    }
    const latestPayment = order.latestPayment;
    const payerOpenid = String(body?.payerOpenid || latestPayment?.payerOpenid || '').trim();
    const notifyUrl = body?.notifyUrl
      ? String(body.notifyUrl).trim()
      : await getWechatOrderNotifyUrlFromConfig(this.systemConfigService);
    const isReusablePayment = !!latestPayment && ['PENDING', 'FAILED', 'CLOSED'].includes(String(latestPayment.status || '').toUpperCase());
    const paymentNo = isReusablePayment ? String(latestPayment?.paymentNo || '') : this.buildWechatPaymentNo(id);
    const orderAmountFen = Math.max(1, Math.round(Number(order.paidAmount || 0) * 100));
    const latestPaymentFen = Math.max(1, Math.round(Number(latestPayment?.amount || 0) * 100));
    const totalFeeFen = isReusablePayment ? latestPaymentFen : orderAmountFen;
    const shouldUseTestAmount = isReusablePayment
      ? Boolean(latestPayment?.isTestPayment || order?.isTestPayment)
      : (Boolean(body?.testMode) && await this.memberService.canUseMiniPaymentTestMode(uid));
    const prepay = await this.wechatPayService.createJsapiPrepay({
      orderNo: paymentNo,
      description: String(order?.project?.name || `订单${id}`),
      totalFeeFen,
      payerOpenid,
      notifyUrl,
      useTestAmount: shouldUseTestAmount,
    });
    const payableFen = Number(prepay?.mock ? prepay?.mockAmountFen ?? totalFeeFen : totalFeeFen);
    const amountYuan = Number((payableFen / 100).toFixed(2));
    const payment = isReusablePayment
      ? await this.prisma.orderPayment.update({
          where: { id: Number(latestPayment?.id) },
          data: {
            status: 'PENDING',
            amount: amountYuan,
            isTestPayment: shouldUseTestAmount,
            payerOpenid,
            prepayId: prepay?.mock ? String(prepay?.params?.package || '') : String(prepay?.params?.package || '').replace(/^prepay_id=/, ''),
          },
          select: { id: true },
        })
      : await this.prisma.orderPayment.create({
          data: {
            orderId: id,
            paymentNo,
            channel: 'MINIAPP_WECHAT',
            status: 'PENDING',
            amount: amountYuan,
            isTestPayment: shouldUseTestAmount,
            payerOpenid,
            prepayId: prepay?.mock ? String(prepay?.params?.package || '') : String(prepay?.params?.package || '').replace(/^prepay_id=/, ''),
          },
          select: { id: true },
        });
    await this.prisma.order.update({
      where: { id },
      data: {
        payStatus: 'PENDING',
        isTestPayment: shouldUseTestAmount,
        latestPaymentId: payment.id,
      },
    });
    return miniOk({
      orderId: id,
      paymentNo,
      ...prepay,
    });
  }

  @Get('wechat/debug/config')
  @ApiOperation({ summary: '微信支付配置自检（开发联调）' })
  async wechatDebugConfig() {
    const orderNotifyUrl = await getWechatOrderNotifyUrlFromConfig(this.systemConfigService);
    return miniOk({
      ...(await this.wechatPayService.getConfigStatus()),
      orderNotifyUrl,
    });
  }

  private async resolveNotifyPayment(outTradeNo: string) {
    const payment = await this.prisma.orderPayment.findUnique({
      where: { paymentNo: outTradeNo },
      select: { id: true, orderId: true },
    });
    if (payment) return payment;

    const legacyOrder = await this.prisma.order.findFirst({
      where: { autoSerial: outTradeNo },
      select: { id: true },
    });
    if (!legacyOrder) return null;

    return {
      id: null as number | null,
      orderId: legacyOrder.id,
    };
  }

  @Post(':id/wechat-sync')
  @ApiOperation({ summary: '主动同步微信支付状态' })
  async wechatSync(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    const order = await this.prisma.order.findFirst({
      where: this.ownOrderWhere(uid, id),
      select: {
        id: true,
        isPaid: true,
        latestPayment: {
          select: {
            id: true,
            paymentNo: true,
            status: true,
          },
        },
      },
    });
    if (!order) throw new BadRequestException('订单不存在或无权限操作');
    if (order.isPaid) {
      return miniOk({ orderId: id, isPaid: true, synced: true }, '订单已支付');
    }
    const paymentNo = String(order.latestPayment?.paymentNo || '').trim();
    if (!paymentNo) {
      return miniOk({ orderId: id, isPaid: false, synced: false }, '暂无支付单');
    }
    const trade = await this.wechatPayService.queryTransactionByOutTradeNo(paymentNo);
    const tradeState = String(trade?.trade_state || '').toUpperCase();
    if (tradeState === 'SUCCESS') {
      await this.applyWechatPaymentSuccess(id, { id: order.latestPayment?.id ?? null, orderId: id }, {
        ...trade,
        out_trade_no: paymentNo,
      });
      return miniOk({ orderId: id, isPaid: true, synced: true, tradeState }, '支付状态已同步');
    }
    return miniOk({ orderId: id, isPaid: false, synced: false, tradeState }, '支付结果待确认');
  }

  @Public()
  @Post('wechat/notify')
  @ApiOperation({ summary: '微信支付回调通知' })
  async wechatNotify(@Body() body: any) {
    try {
      const resource = body?.resource;
      if (!resource) return { code: 'FAIL', message: 'resource missing' };
      const decrypted = await this.wechatPayService.decryptNotifyResource(resource);
      const tradeState = String(decrypted?.trade_state || '').toUpperCase();
      const outTradeNo = String(decrypted?.out_trade_no || '').trim();
      if (!outTradeNo) return { code: 'FAIL', message: 'out_trade_no missing' };
      if (tradeState === 'SUCCESS') {
        const paymentRef = await this.resolveNotifyPayment(outTradeNo);
        if (paymentRef) {
          const order = await this.prisma.order.findUnique({
            where: { id: paymentRef.orderId },
            select: { id: true, isPaid: true },
          });
          if (order && !order.isPaid) {
            await this.applyWechatPaymentSuccess(order.id, paymentRef, decrypted);
          }
        }
      }
      return { code: 'SUCCESS', message: '成功' };
    } catch (e: any) {
      return { code: 'FAIL', message: e?.message || 'notify handle failed' };
    }
  }

  @Post(':id/review')
  @ApiOperation({ summary: '提交订单评价' })
  @ApiParam({ name: 'id', example: 1001 })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        score: { type: 'number', example: 5, description: '商品与综合评价合并后的总评分' },
        tags: { type: 'array', items: { type: 'string' }, example: ['指挥专业', '沟通愉快'] },
        content: { type: 'string', example: '商品符合预期，整体服务体验很好' },
        anonymous: { type: 'boolean', example: true },
        playerReviews: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              userId: { type: 'number', example: 2001 },
              userName: { type: 'string', example: '小奶猫选手' },
              score: { type: 'number', example: 5 },
              content: { type: 'string', example: '操作稳定，沟通顺畅' },
            },
          },
        },
        dispatcherReview: {
          type: 'object',
          properties: {
            userId: { type: 'number', example: 10086 },
            userName: { type: 'string', example: '派单客服A' },
            score: { type: 'number', example: 5 },
            content: { type: 'string', example: '响应及时，沟通清晰' },
          },
        },
      },
    },
  })
  @ApiOkResponse({
    schema: {
      example: { code: 0, message: '评价提交成功', data: { success: true, status: 'REVIEWED' } },
    },
  })
  async review(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    const own = await this.prisma.order.findFirst({
      where: this.ownOrderWhere(uid, id),
      select: { id: true, status: true },
    });
    if (!own) throw new BadRequestException('订单不存在或无权限操作');

    const score = Number(body?.score ?? 5);
    if (!Number.isFinite(score) || score < 1 || score > 5) throw new BadRequestException('score 范围为 1-5');

    const tags = Array.isArray(body?.tags) ? body.tags.map((item: any) => String(item || '').trim()).filter(Boolean) : [];
    const content = this.normalizeReviewText(body?.content);
    const anonymous = Boolean(body?.anonymous);
    const playerReviewsRaw = Array.isArray(body?.playerReviews) ? body.playerReviews : [];
    const dispatcherReviewRaw = body?.dispatcherReview && typeof body.dispatcherReview === 'object' ? body.dispatcherReview : null;

    await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id },
        select: {
          id: true,
          projectId: true,
          dispatcherId: true,
          dispatches: {
            orderBy: [{ round: 'desc' }, { id: 'desc' }],
            select: {
              id: true,
              round: true,
              participants: {
                select: {
                  userId: true,
                  acceptedAt: true,
                },
              },
            },
          },
        },
      });
      if (!order) throw new BadRequestException('订单不存在');

      await tx.order.update({
        where: { id },
        data: { status: OrderStatus.REVIEWED },
      });

      await tx.productReview.upsert({
        where: { orderId: id },
        update: {
          score,
          tags: tags as any,
          content,
          anonymous,
          isHidden: false,
          hiddenReason: null,
          hiddenBy: null,
          hiddenAt: null,
        },
        create: {
          projectId: Number(order.projectId),
          orderId: id,
          userId: uid,
          score,
          tags: tags as any,
          content,
          anonymous,
        },
      });

      const dispatchByPlayer = new Map<number, number>();
      order.dispatches.forEach((dispatch) => {
        dispatch.participants.forEach((participant) => {
          const playerId = Number(participant.userId || 0);
          if (!playerId || dispatchByPlayer.has(playerId)) return;
          dispatchByPlayer.set(playerId, dispatch.id);
        });
      });

      const normalizedPlayerReviews = playerReviewsRaw.map((item: any) => {
        const playerUserId = Number(item?.userId || 0);
        const itemScore = Number(item?.score ?? 5);
        if (!playerUserId) throw new BadRequestException('playerReviews.userId 缺失');
        if (!Number.isFinite(itemScore) || itemScore < 1 || itemScore > 5) {
          throw new BadRequestException('playerReviews.score 范围为 1-5');
        }
        const dispatchId = Number(dispatchByPlayer.get(playerUserId) || 0);
        if (!dispatchId) throw new BadRequestException(`陪玩师 ${playerUserId} 不属于该订单`);
        return {
          orderId: id,
          dispatchId,
          playerUserId,
          evaluatorId: uid,
          score: itemScore,
          ratingLabel: this.normalizeReviewLabel(itemScore),
          reviewRemark: this.normalizeReviewText(item?.content) || null,
        };
      });

      if (normalizedPlayerReviews.length) {
        await tx.orderPlayerEvaluation.deleteMany({
          where: {
            orderId: id,
            playerUserId: { in: normalizedPlayerReviews.map((item) => item.playerUserId) },
          },
        });
        await tx.orderPlayerEvaluation.createMany({
          data: normalizedPlayerReviews as any,
        });
      }

      if (dispatcherReviewRaw) {
        const dispatcherScore = Number(dispatcherReviewRaw?.score ?? 5);
        if (!Number.isFinite(dispatcherScore) || dispatcherScore < 1 || dispatcherScore > 5) {
          throw new BadRequestException('dispatcherReview.score 范围为 1-5');
        }
        const dispatcherUserId = Number(dispatcherReviewRaw?.userId || order.dispatcherId || 0);
        if (!dispatcherUserId) throw new BadRequestException('当前订单无可评价客服');
        await tx.userLog.create({
          data: {
            userId: uid,
            action: 'MINI_ORDER_DISPATCHER_REVIEW',
            targetType: 'ORDER',
            targetId: id,
            newData: {
              dispatcherUserId,
              dispatcherUserName: this.normalizeReviewText(dispatcherReviewRaw?.userName),
              score: dispatcherScore,
              ratingLabel: this.normalizeReviewLabel(dispatcherScore),
              content: this.normalizeReviewText(dispatcherReviewRaw?.content),
              anonymous,
            } as any,
            remark: 'miniapp dispatcher review submit',
          },
        });
      }

      await tx.userLog.create({
        data: {
          userId: uid,
          action: 'MINI_ORDER_REVIEW',
          targetType: 'ORDER',
          targetId: id,
          newData: {
            score,
            tags,
            content,
            anonymous,
            playerReviews: normalizedPlayerReviews.map((item) => ({
              playerUserId: item.playerUserId,
              dispatchId: item.dispatchId,
              score: item.score,
              ratingLabel: item.ratingLabel,
              reviewRemark: item.reviewRemark,
            })),
            dispatcherReview: dispatcherReviewRaw ? {
              userId: Number(dispatcherReviewRaw?.userId || order.dispatcherId || 0),
              userName: this.normalizeReviewText(dispatcherReviewRaw?.userName),
              score: Number(dispatcherReviewRaw?.score ?? 5),
              content: this.normalizeReviewText(dispatcherReviewRaw?.content),
            } : null,
          } as any,
          remark: 'miniapp review submit',
        },
      });
    });

    try {
      await this.miniSubscribeMessageService.pushOrderProgressMessage(id, '订单已评价，感谢你的反馈', '已评价');
    } catch {}

    return miniOk({ success: true, status: OrderStatus.REVIEWED }, '评价提交成功');
  }

  @Get(':id/after-sales')
  @ApiOperation({ summary: '获取售后工单详情' })
  async afterSalesDetail(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return miniOk(await this.ordersService.getComplaintWorkOrderByOrderIdForMini(id, uid));
  }

  @Post(':id/after-sales')
  @ApiOperation({ summary: '提交售后申请' })
  @ApiParam({ name: 'id', example: 1001 })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', example: '实际水平与描述不符' },
        description: { type: 'string', example: '中途频繁掉线，沟通效果差' },
      },
    },
  })
  @ApiOkResponse({
    schema: {
      example: { code: 0, message: '售后申请已提交', data: { success: true, status: 'WAIT_AFTERSALE' } },
    },
  })
  async afterSales(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    const data = await this.ordersService.submitComplaintWorkOrderFromMini(id, uid, body || {});
    return miniOk(
      data,
      data?.manualRefundRequired ? '售后申请已提交（当前支付渠道不支持售后退款）' : '售后申请已提交',
    );
  }
}
