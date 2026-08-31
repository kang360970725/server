import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangeLevelDto } from './dto/change-level.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { StaffExitDto, StaffExitMode } from './dto/staff-exit.dto';
import { StaffClearDto } from './dto/staff-clear.dto';
import { PlayerWorkStatus, StaffEmploymentStatus, UserStatus, UserType, WalletHoldStatus, WalletTxStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { WalletService } from '../wallet/wallet.service';
import { StaffRuleEngineService } from '../system-config/staff-rule-engine.service';
import { isDispatchMonitoredStaff } from '../common/utils/staff-role-scope.util';

@Injectable()
export class UsersService {
  // 临时屏蔽自动离线，仅保留手动离线/登录上线。
  private static readonly defaultStaffRoleId = 3;
  private static readonly defaultStaffRoleName = '陪玩';
  private readonly autoOfflineDisabled = true;
  private readonly staffExitCooldownDays = 180;
  private readonly staffExitDepositRefundMinAcceptedOrders = 50;
  private readonly logger = new Logger(UsersService.name);

  static readonly PLAYER_ONLINE_LEASE_MS = 2 * 60 * 60 * 1000;

  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
    private readonly staffRuleEngineService: StaffRuleEngineService,
  ) {}

  private buildPlayerOnlineLeaseExpiresAt(base: Date = new Date()) {
    return new Date(base.getTime() + UsersService.PLAYER_ONLINE_LEASE_MS);
  }

  private getStaffDormantFreezeAt(baseDate?: Date | string | null, dormantFreezeDays = 7) {
    if (!baseDate) return null;
    const freezeAt = new Date(baseDate);
    if (Number.isNaN(freezeAt.getTime())) return null;
    freezeAt.setDate(freezeAt.getDate() + dormantFreezeDays);
    return freezeAt;
  }

  private getStaffDormantFreezeMessage(days = 7) {
    return this.staffRuleEngineService.buildDormantFreezeMessage(days);
  }

  private getStaffDormantFreezeBaseDate(input: {
    staffDormantFreezeBaseAt?: Date | string | null;
    lastAcceptedAt?: Date | string | null;
    createdAt?: Date | string | null;
  }) {
    const pickDate = (value?: Date | string | null) => {
      if (!value) return null;
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    };

    return (
      pickDate(input?.staffDormantFreezeBaseAt) ||
      pickDate(input?.lastAcceptedAt) ||
      pickDate(input?.createdAt)
    );
  }

  async autoFreezeDormantStaffUsers(userIds?: number[]) {
    const idSet = Array.from(new Set((userIds || []).map((item) => Number(item || 0)).filter((item) => item > 0)));
    const users = await this.prisma.user.findMany({
      where: {
        userType: UserType.STAFF,
        staffEmploymentStatus: { in: [StaffEmploymentStatus.ACTIVE, StaffEmploymentStatus.FROZEN] },
        ...(idSet.length ? { id: { in: idSet } } : {}),
      },
      select: {
        id: true,
        createdAt: true,
        userType: true,
        staffEmploymentStatus: true,
        staffDormantFreezeBaseAt: true,
        staffTags: true,
        Role: {
          select: {
            name: true,
          },
        },
      },
    });
    const exemptFrozenIds = users
      .filter(
        (item) =>
          String(item?.staffEmploymentStatus || '') === StaffEmploymentStatus.FROZEN &&
          !isDispatchMonitoredStaff(item),
      )
      .map((item) => Number(item.id))
      .filter((item) => item > 0);

    if (exemptFrozenIds.length) {
      await this.prisma.user.updateMany({
        where: {
          id: { in: exemptFrozenIds },
          userType: UserType.STAFF,
          staffEmploymentStatus: StaffEmploymentStatus.FROZEN,
        },
        data: {
          staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
          canWithdraw: true,
        },
      });
    }

    const monitoredUsers = users.filter(
      (item) =>
        isDispatchMonitoredStaff(item) &&
        String(item?.staffEmploymentStatus || '') === StaffEmploymentStatus.ACTIVE,
    );
    if (!monitoredUsers.length) return new Set<number>();
    const staffRuleConfig = await this.staffRuleEngineService.getConfig();

    const lastAcceptedRows = await this.prisma.orderParticipant.groupBy({
      by: ['userId'],
      where: {
        userId: { in: monitoredUsers.map((item) => Number(item.id)) },
        acceptedAt: { not: null },
      },
      _max: { acceptedAt: true },
    });

    const lastAcceptedMap = new Map<number, Date>();
    lastAcceptedRows.forEach((item) => {
      if (item?._max?.acceptedAt) {
        lastAcceptedMap.set(Number(item.userId), new Date(item._max.acceptedAt));
      }
    });

    const frozenIds = monitoredUsers
      .filter((item) => {
        const baseDate = this.getStaffDormantFreezeBaseDate({
          staffDormantFreezeBaseAt: (item as any)?.staffDormantFreezeBaseAt,
          lastAcceptedAt: lastAcceptedMap.get(Number(item.id)) || null,
          createdAt: item?.createdAt ? new Date(item.createdAt) : null,
        });
        const dormantFreezeDays = this.staffRuleEngineService.getDormantFreezeDays(staffRuleConfig, (item as any)?.staffTags);
        const freezeAt = this.getStaffDormantFreezeAt(baseDate, dormantFreezeDays);
        return freezeAt ? freezeAt.getTime() <= Date.now() : false;
      })
      .map((item) => Number(item.id))
      .filter((item) => item > 0);

    if (!frozenIds.length) return new Set<number>();

    const result = await this.prisma.user.updateMany({
      where: {
        id: { in: frozenIds },
        userType: UserType.STAFF,
        staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
      },
      data: {
        staffEmploymentStatus: StaffEmploymentStatus.FROZEN,
        canWithdraw: false,
        workStatus: PlayerWorkStatus.IDLE,
        workOnlineExpiresAt: null,
      },
    });

    if (result.count > 0) {
      this.logger.log(`[staff-auto-freeze] frozen ${result.count} staff account(s)`);
    }

    return new Set<number>(frozenIds);
  }

  private async buildStaffReviewMeta(userIds: number[]) {
    const ids = Array.from(new Set((userIds || []).map((item) => Number(item || 0)).filter((item) => item > 0)));
    if (!ids.length) return new Map<number, { averageScore: number | null; reviewCount: number; recentReviews: any[] }>();

    const [aggregates, reviews] = await Promise.all([
      this.prisma.orderPlayerEvaluation.groupBy({
        by: ['playerUserId'],
        where: { playerUserId: { in: ids } },
        _avg: { score: true },
        _count: { playerUserId: true },
      }),
      this.prisma.orderPlayerEvaluation.findMany({
        where: { playerUserId: { in: ids } },
        select: {
          playerUserId: true,
          orderId: true,
          score: true,
          ratingLabel: true,
          reviewRemark: true,
          createdAt: true,
          evaluator: {
            select: { id: true, name: true, phone: true },
          },
        },
        orderBy: [{ createdAt: 'desc' }],
      }),
    ]);

    const result = new Map<number, { averageScore: number | null; reviewCount: number; recentReviews: any[] }>();
    aggregates.forEach((item) => {
      const playerUserId = Number(item.playerUserId || 0);
      if (!playerUserId) return;
      result.set(playerUserId, {
        averageScore: item._avg?.score != null ? Number(Number(item._avg.score).toFixed(2)) : null,
        reviewCount: Number(item._count?.playerUserId || 0),
        recentReviews: [],
      });
    });

    reviews.forEach((item) => {
      const playerUserId = Number(item.playerUserId || 0);
      if (!playerUserId) return;
      const current = result.get(playerUserId) || { averageScore: null, reviewCount: 0, recentReviews: [] };
      if (current.recentReviews.length < 5) {
        current.recentReviews.push({
          orderId: item.orderId,
          score: item.score,
          ratingLabel: item.ratingLabel,
          reviewRemark: item.reviewRemark || '',
          createdAt: item.createdAt,
          evaluatorName: item.evaluator?.name || item.evaluator?.phone || '',
        });
      }
      result.set(playerUserId, current);
    });

    ids.forEach((id) => {
      if (!result.has(id)) {
        result.set(id, { averageScore: null, reviewCount: 0, recentReviews: [] });
      }
    });

    return result;
  }

  private getActorAllowedUserTypes(actor?: { userType?: UserType; roleName?: string; permissions?: string[] }): UserType[] | null {
    if (this.isSuperAdmin(actor)) {
      return [
        UserType.REGISTERED_USER,
        UserType.STAFF,
        UserType.SUPER_ADMIN,
        UserType.ADMIN,
        UserType.CUSTOMER_SERVICE,
        UserType.OPERATION,
        UserType.FINANCE,
      ];
    }

    const permissions = Array.isArray(actor?.permissions) ? actor!.permissions! : [];
    const allowed = new Set<UserType>();

    if (permissions.includes('users:member:page')) {
      allowed.add(UserType.REGISTERED_USER);
    }

    // 订单建单/派单场景允许客服按会员范围检索用户，用于关联会员与储值支付。
    if (permissions.includes('orders:list:page')) {
      allowed.add(UserType.REGISTERED_USER);
    }

    if (permissions.includes('users:staff:page')) {
      allowed.add(UserType.STAFF);
    }

    if (permissions.includes('users:staff-rental-risk:page')) {
      allowed.add(UserType.STAFF);
    }

    if (permissions.includes('users:internal:page')) {
      allowed.add(UserType.SUPER_ADMIN);
      allowed.add(UserType.ADMIN);
      allowed.add(UserType.CUSTOMER_SERVICE);
      allowed.add(UserType.OPERATION);
      allowed.add(UserType.FINANCE);
    }

    if (!allowed.size) {
      throw new ForbiddenException('当前角色无权访问用户管理');
    }

    return Array.from(allowed);
  }

  private assertActorCanAccessUser(
    actor: { userType?: UserType; roleName?: string; permissions?: string[] } | undefined,
    targetUserType?: UserType,
  ) {
    const allowed = this.getActorAllowedUserTypes(actor);
    if (!targetUserType || !allowed.includes(targetUserType)) {
      throw new ForbiddenException('无权访问该用户');
    }
  }

  private isSuperAdmin(actor?: { userType?: UserType; roleName?: string }) {
    return actor?.userType === UserType.SUPER_ADMIN
      || String(actor?.roleName || '').trim().toUpperCase() === 'SUPER_ADMIN';
  }

  private hasActorPermission(actor: { permissions?: string[] } | undefined, key: string) {
    return Array.isArray(actor?.permissions) && actor!.permissions!.includes(key);
  }

  private assertActorPermission(
    actor: { userType?: UserType; roleName?: string; permissions?: string[] } | undefined,
    key: string,
    message = '当前角色无权执行该操作',
  ) {
    if (this.isSuperAdmin(actor) || this.hasActorPermission(actor, key)) {
      return;
    }
    throw new ForbiddenException(message);
  }

  private getUserPermissionScope(userType?: UserType) {
    if (userType === UserType.REGISTERED_USER) return 'member';
    if (userType === UserType.STAFF) return 'staff';
    if (
      userType === UserType.SUPER_ADMIN ||
      userType === UserType.ADMIN ||
      userType === UserType.CUSTOMER_SERVICE ||
      userType === UserType.OPERATION ||
      userType === UserType.FINANCE
    ) {
      return 'internal';
    }
    return null;
  }

  private getUserButtonPermissionKey(userType: UserType | undefined, action: string) {
    const scope = this.getUserPermissionScope(userType);
    if (!scope) return null;
    return `users:${scope}:${action}:button`;
  }

  private assertUserButtonPermission(
    actor: { userType?: UserType; permissions?: string[] } | undefined,
    targetUserType: UserType | undefined,
    action: string,
    message: string,
  ) {
    const key = this.getUserButtonPermissionKey(targetUserType, action);
    if (!key) {
      throw new ForbiddenException(message);
    }
    this.assertActorPermission(actor, key, message);
  }

  private assertCanManageStaffUser(
    actor: { userType?: UserType; permissions?: string[] } | undefined,
    targetUserType?: UserType,
  ) {
    if (this.isSuperAdmin(actor)) return;

    if (targetUserType === UserType.STAFF && this.hasActorPermission(actor, 'users:staff:page')) {
      return;
    }

    throw new ForbiddenException('当前角色无权操作打手员工');
  }

  private assertSuperAdmin(actor?: { userType?: UserType }) {
    if (!this.isSuperAdmin(actor)) {
      throw new ForbiddenException('当前操作仅超级管理员可执行');
    }
  }

  private normalizeWorkModePayload(input: { workMode?: 'ONLINE' | 'OFFLINE'; offlineJoinedAt?: string | Date | null }) {
    const workMode = (input.workMode ?? 'ONLINE') as 'ONLINE' | 'OFFLINE';
    const offlineJoinedAtRaw = input.offlineJoinedAt ?? null;
    const offlineJoinedAt = offlineJoinedAtRaw ? new Date(offlineJoinedAtRaw as any) : null;

    if (workMode === 'OFFLINE' && !offlineJoinedAt) {
      throw new BadRequestException('线下员工必须填写转线下(入职)时间');
    }

    return {
      workMode,
      offlineJoinedAt: workMode === 'OFFLINE' ? offlineJoinedAt : null,
      workOnlineExpiresAt: workMode === 'ONLINE' ? this.buildPlayerOnlineLeaseExpiresAt() : null,
    };
  }

  private normalizeIdentityText(value: any) {
    return String(value || '').trim();
  }

  private assertStaffRuleGroupRequired(tags: string[]) {
    if (!tags.length) {
      throw new BadRequestException('新增或重新入驻服务者必须选择服务者规则分组');
    }
  }

  private assertStaffRuleGroupSingle(tags: string[]) {
    if (tags.length > 1) {
      throw new BadRequestException('服务者规则分组仅支持选择一个');
    }
  }

  private async resolveDefaultStaffRoleId(tx?: any) {
    const client = tx || this.prisma;
    const roleById = await client.role.findUnique({
      where: { id: UsersService.defaultStaffRoleId },
      select: { id: true, name: true },
    });
    if (roleById?.name === UsersService.defaultStaffRoleName) return roleById.id;

    const roleByName = await client.role.findUnique({
      where: { name: UsersService.defaultStaffRoleName },
      select: { id: true },
    });
    if (roleByName) return roleByName.id;

    throw new BadRequestException('默认陪玩角色不存在，请先配置角色：陪玩');
  }

  private assertNonSuperStaffUpdatePayload(updateUserDto: UpdateUserDto) {
    const allowedFields = new Set(['status', 'staffEmploymentStatus', 'staffTags']);
    const blockedFields = Object.keys(updateUserDto as any).filter((field) => !allowedFields.has(field));
    if (blockedFields.length) {
      throw new ForbiddenException('当前角色仅允许修改账号状态、服务状态和服务者规则分组');
    }
    const nextAccountStatus = (updateUserDto as any)?.status;
    if (
      nextAccountStatus &&
      ![UserStatus.ACTIVE, UserStatus.FROZEN].includes(nextAccountStatus)
    ) {
      throw new ForbiddenException('当前角色仅允许冻结或解冻账号');
    }
    const nextStatus = (updateUserDto as any)?.staffEmploymentStatus;
    if (
      nextStatus &&
      ![StaffEmploymentStatus.ACTIVE, StaffEmploymentStatus.FROZEN].includes(nextStatus)
    ) {
      throw new ForbiddenException('退店和清退必须通过对应操作执行');
    }
  }

  private getStaffRejoinCooldownUntil(user: any, config: any) {
    if (user?.staffCooldownUntil) {
      const stored = new Date(user.staffCooldownUntil);
      if (!Number.isNaN(stored.getTime())) return stored;
    }

    const exitedAt = user?.staffExitedAt ? new Date(user.staffExitedAt) : null;
    if (!exitedAt || Number.isNaN(exitedAt.getTime())) return null;
    const ruleSummary = this.buildStaffRuleSummary(user, config);
    return this.buildStaffCooldownUntil(exitedAt, Number(ruleSummary.matchedQuitCoolingDays || this.staffExitCooldownDays));
  }

  private getStaffRejoinRiskMessage(cooldownUntil: Date | null, coolingDays: number) {
    const deadline = cooldownUntil ? cooldownUntil.toISOString().slice(0, 10) : '未知日期';
    return `该员工退店未满${Number(coolingDays || this.staffExitCooldownDays)}天或配置的退店冷却期，冷却截止 ${deadline}。如需重新入店，请二次确认操作风险：重新入店会清零账户中的所有正数余额，负数余额保留不变。`;
  }

  private buildPositiveWalletClearData(account: any) {
    const available = Number(account?.availableBalance ?? 0);
    const frozen = Number(account?.frozenBalance ?? 0);
    const earningFrozen = Number(account?.earningFrozenBalance ?? 0);
    const withdrawFrozen = Number(account?.withdrawFrozenBalance ?? 0);
    const deposit = Number(account?.depositBalance ?? 0);
    const data: any = {};
    if (available > 0) data.availableBalance = 0;
    if (frozen > 0) data.frozenBalance = 0;
    if (earningFrozen > 0) data.earningFrozenBalance = 0;
    if (withdrawFrozen > 0) data.withdrawFrozenBalance = 0;
    if (deposit > 0) data.depositBalance = 0;
    return {
      data,
      clearAvailable: Math.max(0, available),
      clearFrozen: Math.max(0, frozen),
      clearEarningFrozen: Math.max(0, earningFrozen),
      clearWithdrawFrozen: Math.max(0, withdrawFrozen),
      clearDeposit: Math.max(0, deposit),
      clearWalletAmount: Math.max(0, available) + Math.max(0, frozen),
      clearTotalAmount: Math.max(0, available) + Math.max(0, frozen) + Math.max(0, deposit),
    };
  }

  private async findStaffDuplicateForCreate(input: { phone: string; realName?: string; name?: string; idCard?: string }) {
    const phone = this.normalizeIdentityText(input.phone);
    const realName = this.normalizeIdentityText(input.realName || input.name);
    const idCard = this.normalizeIdentityText(input.idCard);
    const staffOr: any[] = [];
    if (phone) staffOr.push({ phone });
    if (realName) staffOr.push({ realName });
    if (idCard) staffOr.push({ idCard });
    if (!staffOr.length) return [];

    return this.prisma.user.findMany({
      where: {
        userType: UserType.STAFF,
        OR: staffOr,
      },
      include: {
        ...this.getUserIncludeFields(),
        walletAccount: {
          select: {
            availableBalance: true,
            frozenBalance: true,
            earningFrozenBalance: true,
            withdrawFrozenBalance: true,
            depositBalance: true,
          },
        },
      },
      take: 10,
    });
  }

  async create(
    createUserDto: CreateUserDto,
    operatorId?: number,
    actor?: { userType?: UserType; roleName?: string; permissions?: string[] },
  ) {
    const { phone, password, userType = UserType.REGISTERED_USER, forceRejoin, ...rest } = createUserDto;
    const normalizedStaffTags = this.normalizeStaffTags(createUserDto.staffTags);
    this.assertActorCanAccessUser(actor, userType);
    this.assertUserButtonPermission(actor, userType, 'create', '当前角色无权新增该类型用户');
    const normalizedPhone = this.normalizeIdentityText(phone);
    const normalizedRealName = this.normalizeIdentityText(createUserDto.realName || createUserDto.name);
    const normalizedIdCard = this.normalizeIdentityText(createUserDto.idCard);
    const workModePayload = this.normalizeWorkModePayload({
      workMode: createUserDto.workMode,
      offlineJoinedAt: createUserDto.offlineJoinedAt,
    });
    const isTargetStaff = userType === UserType.STAFF;
    const defaultStaffRoleId = isTargetStaff ? await this.resolveDefaultStaffRoleId() : undefined;
    const requestedRoleId = Number((createUserDto as any)?.roleId || 0);
    const staffRoleId = isTargetStaff
      ? this.isSuperAdmin(actor) && requestedRoleId > 0
        ? requestedRoleId
        : defaultStaffRoleId
      : requestedRoleId > 0
        ? requestedRoleId
        : undefined;
    const restData: any = { ...rest };
    delete restData.roleId;
    delete restData.balance;
    delete restData.depositLimit;
    delete restData.canWithdraw;
    delete restData.staffTags;
    delete restData.workMode;
    delete restData.offlineJoinedAt;
    if (isTargetStaff && !this.isSuperAdmin(actor)) {
      delete restData.level;
      delete restData.status;
      delete restData.needResetPwd;
      delete restData.staffEmploymentStatus;
    }

    if (userType === UserType.STAFF) {
      if (!normalizedPhone) throw new BadRequestException('员工手机号不能为空');
      if (!normalizedRealName) throw new BadRequestException('员工姓名不能为空');
      if (!normalizedIdCard) throw new BadRequestException('员工身份证号不能为空');
      this.assertStaffRuleGroupRequired(normalizedStaffTags);
      this.assertStaffRuleGroupSingle(normalizedStaffTags);

      const phoneOwner = await this.prisma.user.findUnique({ where: { phone: normalizedPhone } });
      if (phoneOwner && phoneOwner.userType !== UserType.STAFF) {
        throw new BadRequestException('手机号已被非员工账号使用，无法作为员工入店账号');
      }

      const duplicatedStaff = await this.findStaffDuplicateForCreate({
        phone: normalizedPhone,
        realName: normalizedRealName,
        idCard: normalizedIdCard,
      });

      if (duplicatedStaff.length > 1) {
        throw new BadRequestException('员工入店信息命中多个历史账号，请先人工核查手机号、姓名和身份证号');
      }

      const existingStaff = duplicatedStaff[0];
      if (existingStaff) {
        if (existingStaff.staffEmploymentStatus === StaffEmploymentStatus.BLACKLISTED) {
          throw new BadRequestException('该员工已加入黑名单，不允许重新入店');
        }
        if (existingStaff.staffEmploymentStatus !== StaffEmploymentStatus.EXITED) {
          throw new BadRequestException('手机号、姓名或身份证号已存在员工账号，无法重复入店');
        }

        const config = await this.staffRuleEngineService.getConfig();
        const ruleSummary = this.buildStaffRuleSummary(existingStaff, config);
        const cooldownUntil = this.getStaffRejoinCooldownUntil(existingStaff, config);
        const now = new Date();
        if (cooldownUntil && cooldownUntil.getTime() > now.getTime() && forceRejoin !== true) {
          throw new BadRequestException({
            code: 'STAFF_REJOIN_COOLDOWN_CONFIRM_REQUIRED',
            message: this.getStaffRejoinRiskMessage(cooldownUntil, Number(ruleSummary.matchedQuitCoolingDays || this.staffExitCooldownDays)),
            staffId: existingStaff.id,
            cooldownUntil: cooldownUntil.toISOString(),
            coolingDays: Number(ruleSummary.matchedQuitCoolingDays || this.staffExitCooldownDays),
          });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const rejoinedUser = await this.prisma.$transaction(async (tx) => {
          await this.wallet.ensureWalletAccount(existingStaff.id, tx as any);
          const account = await tx.walletAccount.findUnique({
            where: { userId: existingStaff.id },
            select: {
              availableBalance: true,
              frozenBalance: true,
              earningFrozenBalance: true,
              withdrawFrozenBalance: true,
              depositBalance: true,
            },
          });
          const clear = this.buildPositiveWalletClearData(account);

          const log = await tx.userLog.create({
            data: {
              userId: operatorId || 0,
              action: 'STAFF_REJOIN_SHOP',
              targetType: 'USER',
              targetId: existingStaff.id,
              oldData: {
                staffEmploymentStatus: existingStaff.staffEmploymentStatus,
                staffCooldownUntil: existingStaff.staffCooldownUntil,
                staffExitedAt: existingStaff.staffExitedAt,
                walletAccount: account,
              },
              newData: {
                phone: normalizedPhone,
                realName: normalizedRealName,
                idCard: normalizedIdCard,
                forceRejoin: forceRejoin === true,
                clearedPositiveAmount: Number(clear.clearTotalAmount.toFixed(2)),
              },
              remark: '退店员工重新入店',
            },
          });

          if (Object.keys(clear.data).length > 0) {
            await tx.walletAccount.update({
              where: { userId: existingStaff.id },
              data: clear.data,
            });
          }

          if (clear.clearFrozen > 0 || clear.clearEarningFrozen > 0 || clear.clearWithdrawFrozen > 0) {
            await tx.walletTransaction.updateMany({
              where: { userId: existingStaff.id, status: WalletTxStatus.FROZEN },
              data: { status: WalletTxStatus.REVERSED as any },
            });
            await tx.walletHold.updateMany({
              where: { userId: existingStaff.id, status: WalletHoldStatus.FROZEN },
              data: { status: WalletHoldStatus.CANCELLED, releasedAt: now },
            });
            if (clear.clearWithdrawFrozen > 0) {
              await tx.walletWithdrawalRequest.updateMany({
                where: {
                  userId: existingStaff.id,
                  status: { in: ['PENDING_REVIEW', 'APPROVED', 'PAYING', 'FAILED'] as any },
                },
                data: {
                  status: 'CANCELED' as any,
                  reviewedBy: operatorId ?? null,
                  reviewedAt: now,
                  reviewRemark: '服务者重新入驻时清理历史提现冻结，申请单同步废除',
                  failReason: '服务者重新入驻时正数提现冻结已清理',
                },
              });
            }
          }

          if (clear.clearWalletAmount > 0) {
            await tx.walletTransaction.create({
              data: {
                userId: existingStaff.id,
                direction: 'OUT',
                bizType: 'STAFF_EXIT_CLEAR' as any,
                amount: Number(clear.clearWalletAmount.toFixed(2)),
                status: 'AVAILABLE',
                sourceType: 'STAFF_REJOIN_CLEAR',
                sourceId: log.id,
                availableAfter: clear.data.availableBalance === 0 ? 0 : Number(account?.availableBalance ?? 0),
                frozenAfter: clear.data.frozenBalance === 0 ? 0 : Number(account?.frozenBalance ?? 0),
                remark: '员工重新入店，正数钱包余额清零',
              } as any,
            });
          }

          if (clear.clearDeposit > 0) {
            await tx.walletDepositTransaction.create({
              data: {
                userId: existingStaff.id,
                amount: -Number(clear.clearDeposit.toFixed(2)),
                bizType: 'STAFF_EXIT_CLEAR' as any,
                remark: '员工重新入店，正数保证金余额清零',
                operatorId: operatorId ?? null,
              },
            });
          }

          return tx.user.update({
            where: { id: existingStaff.id },
            data: {
              ...restData,
              phone: normalizedPhone,
              password: hashedPassword,
              name: createUserDto.name,
              realName: normalizedRealName,
              idCard: normalizedIdCard,
              userType,
              roleId: staffRoleId,
              needResetPwd: true,
              staffTags: normalizedStaffTags,
              staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
              staffCooldownUntil: null,
              staffExitedAt: null,
              staffDormantFreezeBaseAt: now,
              canWithdraw: true,
              workStatus: PlayerWorkStatus.IDLE,
              ...workModePayload,
            },
            include: this.getUserIncludeFields(),
          });
        });

        return this.decorateUserWithStaffRule(rejoinedUser, config);
      }
    }

    // 检查用户是否已存在
    const existingUser = await this.prisma.user.findUnique({
      where: { phone: normalizedPhone },
    });

    if (existingUser) {
      throw new BadRequestException('用户已存在');
    }

    // 加密密码
    const hashedPassword = await bcrypt.hash(password, 10);

    // const user = await this.prisma.user.create({
    //   data: {
    //     phone,
    //     password: hashedPassword,
    //     userType,
    //     needResetPwd: userType !== UserType.REGISTERED_USER, // 员工首次登录需要重置密码
    //     ...rest,
    //   },
    //   include: this.getUserIncludeFields(), // 改为使用 include
    // });

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          phone: normalizedPhone,
          password: hashedPassword,
          userType,
          ...(staffRoleId ? { roleId: staffRoleId } : {}),
          needResetPwd: userType !== UserType.REGISTERED_USER,// 员工首次登录需要重置密码
          ...restData,
          ...(isTargetStaff ? { status: UserStatus.ACTIVE, staffEmploymentStatus: StaffEmploymentStatus.ACTIVE } : {}),
          staffTags: normalizedStaffTags,
          ...workModePayload,
        },
        include: this.getUserIncludeFields(),
      });

      // ✅ 创建钱包账户（一人一账，幂等）
      await this.wallet.ensureWalletAccount(created.id, tx as any);

      return created;
    });

    // 记录操作日志
    if (operatorId) {
      await this.createUserLog(
          operatorId,
          user.id,
          'CREATE_USER',
          'USER',
          null,
          null,
          user,
          `创建用户: ${normalizedPhone}`
      );
    }

    return this.decorateUserWithStaffRule(user, await this.staffRuleEngineService.getConfig());
  }

  async findAll(params: {
    page?: number;
    limit?: number;
    search?: string;
    userType?: UserType;
    status?: string;
    staffEmploymentStatus?: string;
    anonymousOnly?: string | boolean;
    includeStaffMembers?: string | boolean;
    memberState?: string;
    scene?: string;
    actor?: { userType?: UserType; permissions?: string[]; id?: number; userId?: number };

    loginInactiveDays?: number;   // 新增：超过多少天未登录
    acceptInactiveDays?: number;  // 新增：超过多少天未接单
  })
  {
    const {
      search,
      userType,
      status,
      staffEmploymentStatus,
      anonymousOnly,
      includeStaffMembers,
      memberState,
      scene,
      actor,
      loginInactiveDays,
      acceptInactiveDays
    } = params;
    const page = Number(params.page ?? 1);
    const limit = Number(params.limit ?? 10);
    const skip = (page - 1) * limit;

    const where: any = {};
    const AND: any[] = [];

    const sceneKey = String(scene || '').trim().toUpperCase() || 'DEFAULT';
    const actorAllowedUserTypes = this.getActorAllowedUserTypes(actor);

    const resolveSceneUserTypes = (): UserType[] | null => {
      const sceneTypeMap: Record<string, UserType[] | null> = {
        MEMBER: [UserType.REGISTERED_USER],
        STAFF: [UserType.STAFF],
        STAFF_RENTAL_RISK: [UserType.STAFF],
        INTERNAL: [UserType.SUPER_ADMIN, UserType.ADMIN, UserType.CUSTOMER_SERVICE, UserType.OPERATION, UserType.FINANCE],
        ALL: actorAllowedUserTypes,
        DEFAULT: actorAllowedUserTypes,
      };

      const requestedTypes = sceneTypeMap[sceneKey];
      if (requestedTypes === undefined) {
        throw new ForbiddenException('无效的用户管理场景');
      }

      if (requestedTypes === null) {
        return actorAllowedUserTypes;
      }

      const filteredTypes = requestedTypes.filter((type) => actorAllowedUserTypes.includes(type));
      if (!filteredTypes.length) {
        throw new ForbiddenException('当前角色无权访问该用户管理场景');
      }
      return filteredTypes;
    };

    const includeStaffMembersInMemberScene = sceneKey === 'MEMBER' && String(includeStaffMembers || '') === 'true';
    const sceneUserTypes = includeStaffMembersInMemberScene ? null : resolveSceneUserTypes();
    if (sceneKey === 'STAFF_RENTAL_RISK' && !String(search || '').trim()) {
      return {
        data: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
      };
    }
    if (includeStaffMembersInMemberScene) {
      AND.push({
        OR: [
          { userType: UserType.REGISTERED_USER },
          {
            userType: UserType.STAFF,
            memberProfile: {
              isNot: null,
            },
          },
        ],
      });
    } else if (sceneUserTypes?.length) {
      AND.push({ userType: { in: sceneUserTypes } });
    }

    if (search) {
      const keyword = String(search).trim();

      if (sceneKey === 'STAFF_RENTAL_RISK') {
        AND.push({
          OR: [
            { name: keyword },
            { realName: keyword },
          ],
        });
      } else {
        /**
         * 1️⃣ 搜索：支持会员编码 / 手机号 / name / realName
         * - 纯数字仍兼容后台用户ID精确查询，但前端会员场景不再提示用户ID。
         */
        const OR: any[] = [
          { phone: { contains: keyword } },
          { name: { contains: keyword } },
          { realName: { contains: keyword } },
          { memberProfile: { is: { memberCode: { contains: keyword } } } },
        ];

        if (/^\d+$/.test(keyword)) {
          OR.push({ id: Number(keyword) });
        }

        AND.push({ OR });
      }
    }

    /**
     * 2️⃣ 用户类型
     */
    if (userType) {
      if (sceneUserTypes?.length && !sceneUserTypes.includes(userType)) {
        throw new ForbiddenException('当前场景不允许查询该用户类型');
      }
      AND.push({ userType });
    }

    /**
     * 3️⃣ 状态
     */
    if (status) {
      AND.push({ status });
    }

    if (staffEmploymentStatus) {
      AND.push({ staffEmploymentStatus: String(staffEmploymentStatus).trim() });
    } else if (sceneKey === 'STAFF_RENTAL_RISK') {
      AND.push({ staffEmploymentStatus: { in: ['ACTIVE', 'FROZEN'] } });
    }

    if (String(anonymousOnly || '') === 'true') {
      AND.push({
        OR: [
          { phone: { startsWith: 'guest_' } },
          { name: { startsWith: '访客' } },
        ],
      });
    }

    if (sceneKey === 'MEMBER') {
      const normalizedMemberState = String(memberState || 'ALL').trim().toUpperCase();
      const activeMemberWhere = {
        OR: [
          { walletAccount: { is: { availableBalance: { gt: 0 } } } },
          { memberPointAccount: { is: { availablePoints: { gt: 0 } } } },
          { memberProfile: { is: { totalRechargeAmount: { gt: 0 } } } },
          { memberProfile: { is: { totalConsumeAmount: { gt: 0 } } } },
          { memberProfile: { is: { annualContribution: { gt: 0 } } } },
          {
            userCoupons: {
              some: {
                status: 'UNUSED',
                OR: [
                  { expiresAt: null },
                  { expiresAt: { gt: new Date() } },
                ],
              },
            },
          },
        ],
      };

      if (normalizedMemberState === 'ACTIVE') {
        AND.push(activeMemberWhere);
      } else if (normalizedMemberState === 'INACTIVE') {
        AND.push({ NOT: activeMemberWhere });
      }
    }

    /**
     * 4️⃣ 超过 X 天未登录
     */
    if (loginInactiveDays) {
      const date = new Date();
      date.setDate(date.getDate() - Number(loginInactiveDays));

      AND.push({
        OR: [
          { lastLoginAt: null },
          { lastLoginAt: { lte: date } }
        ]
      });
    }

    /**
     * 5️⃣ 超过 X 天未接单
     */
    if (acceptInactiveDays) {
      const date = new Date();
      date.setDate(date.getDate() - Number(acceptInactiveDays));

      AND.push({
        orderParticipants: {
          none: {
            acceptedAt: {
              gt: date,
            },
          },
        },
      });
    }

    if (AND.length) {
      where.AND = AND;
    }

    if (sceneKey === 'STAFF' || sceneKey === 'ALL' || includeStaffMembersInMemberScene || userType === UserType.STAFF) {
      await this.autoFreezeDormantStaffUsers();
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        include: {
          ...this.getUserIncludeFields(),

          /**
           * 钱包
           */
          walletAccount: {
            select: {
              walletUid: true,
              availableBalance: true,
              frozenBalance: true,
              withdrawFrozenBalance: true,
              depositBalance: true,
            }
          },

          /**
           * 最后接单时间
           */
          orderParticipants: {
            where: {
              acceptedAt: {
                not: null,
              },
            },
            select: {
              acceptedAt: true,
            },
            orderBy: {
              acceptedAt: 'desc',
            },
            take: 1,
          }
        },
        orderBy: { createdAt: 'desc' },
      }),

      this.prisma.user.count({ where }),
    ]);

    const [staffReviewMeta, staffRuleConfig] = await Promise.all([
      this.buildStaffReviewMeta(
        users.filter((user: any) => user?.userType === UserType.STAFF).map((user: any) => Number(user?.id || 0)),
      ),
      this.staffRuleEngineService.getConfig(),
    ]);

    /**
     * 6️⃣ 数据加工
     */
    const data = users.map((u: any) => {

      const available = Number(u?.walletAccount?.availableBalance ?? 0);
      const frozen = Number(u?.walletAccount?.frozenBalance ?? 0);
      const withdrawFrozen = Number(u?.walletAccount?.withdrawFrozenBalance ?? 0);
      const deposit = Number(u?.walletAccount?.depositBalance ?? 0);
      const nonWithdrawFrozen = Math.max(0, Number((frozen - withdrawFrozen).toFixed(2)));

      const lastAcceptOrderAt =
          u?.orderParticipants?.[0]?.acceptedAt ?? null;

      const reviewMeta = u?.userType === UserType.STAFF
        ? (staffReviewMeta.get(Number(u?.id || 0)) || { averageScore: null, reviewCount: 0, recentReviews: [] })
        : { averageScore: null, reviewCount: 0, recentReviews: [] };

      return this.decorateUserWithStaffRule({
        ...u,

        wallet: {
          walletUid: u?.walletAccount?.walletUid ?? null,
          availableBalance: available,
          frozenBalance: frozen,
          withdrawFrozenBalance: withdrawFrozen,
          totalBalance: Number((available + frozen).toFixed(2)),
          depositBalance: deposit,
          nonWithdrawFrozenBalance: nonWithdrawFrozen,
          rentalRiskReferenceBalance: Number((available + nonWithdrawFrozen).toFixed(2)),
        },

        lastAcceptOrderAt,
        reviewStats: {
          averageScore: reviewMeta.averageScore,
          reviewCount: reviewMeta.reviewCount,
        },
        recentReviews: reviewMeta.recentReviews,
      }, staffRuleConfig);
    });

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getStaffWalletStatistics() {
    await this.autoFreezeDormantStaffUsers();

    const result = await this.prisma.walletAccount.aggregate({
      where: {
        user: {
          userType: UserType.STAFF,
        },
      },
      _sum: {
        availableBalance: true,
        frozenBalance: true,
        depositBalance: true,
      },
    });

    const available = Number(result._sum.availableBalance ?? 0);
    const frozen = Number(result._sum.frozenBalance ?? 0);
    const deposit = Number(result._sum.depositBalance ?? 0);

    return {
      totalAvailableBalance: available,
      totalFrozenBalance: frozen,
      totalDepositBalance: deposit,
      totalBalance: Number((available + frozen + deposit).toFixed(2)),
    };
  }

  private buildStaffCooldownUntil(base = new Date(), days = this.staffExitCooldownDays) {
    const next = new Date(base);
    next.setDate(next.getDate() + Number(days || 0));
    return next;
  }

  private normalizeStaffTags(input: any) {
    return this.staffRuleEngineService.normalizeUserTags(input);
  }

  private getStaffJoinedAt(user: any) {
    return user?.offlineJoinedAt ? new Date(user.offlineJoinedAt) : new Date(user?.createdAt || Date.now());
  }

  private buildStaffRuleSummary(user: any, config: any) {
    const matchedRule = user?.userType === UserType.STAFF
      ? this.staffRuleEngineService.resolveMatchedRule(config, user?.staffTags)
      : null;

    return {
      staffTags: this.normalizeStaffTags(user?.staffTags),
      matchedStaffRule: matchedRule,
      matchedDepositAmount: Number(matchedRule?.depositAmount ?? user?.depositLimit ?? 2000),
      matchedFirstWithdrawMinBalance: Number(matchedRule?.firstWithdrawMinBalance ?? 1000),
      matchedFirstWithdrawMinAcceptedOrders: Number(matchedRule?.firstWithdrawMinAcceptedOrders ?? 20),
      matchedQuitCoolingDays: Number(matchedRule?.quitCoolingDays ?? this.staffExitCooldownDays),
      matchedDepositForfeitDays: Number(matchedRule?.depositForfeitDays ?? 0),
    };
  }

  private decorateUserWithStaffRule(user: any, config: any) {
    if (!user || user.userType !== UserType.STAFF) return user;
    return {
      ...user,
      ...this.buildStaffRuleSummary(user, config),
    };
  }

  private async countEffectiveAcceptedOrders(userId: number, db: any = this.prisma) {
    return db.orderParticipant.count({
      where: {
        userId: Number(userId),
        acceptedAt: { not: null },
        rejectedAt: null,
        dispatch: {
          status: { in: ['ARCHIVED', 'COMPLETED'] as any },
        },
      },
    });
  }

  private buildStaffExitPreviewFromUser(user: any, config: any, effectiveAcceptedOrderCount = 0) {
    const ruleSummary = this.buildStaffRuleSummary(user, config);
    const availableBalance = Number(user?.walletAccount?.availableBalance ?? 0);
    const frozenBalance = Number(user?.walletAccount?.frozenBalance ?? 0);
    const depositBalance = Number(user?.walletAccount?.depositBalance ?? 0);
    const depositAmountRule = Number(ruleSummary.matchedDepositAmount || 0);
    const joinedAt = this.getStaffJoinedAt(user);
    const inShopDays = Math.max(0, Math.floor((Date.now() - joinedAt.getTime()) / (1000 * 60 * 60 * 24)));
    const isDepositForfeitByDays = inShopDays < Number(ruleSummary.matchedDepositForfeitDays || 0);
    const isDepositForfeitByOrders = Number(effectiveAcceptedOrderCount || 0) < this.staffExitDepositRefundMinAcceptedOrders;
    const depositShortfallAmount = Math.max(0, Number((depositAmountRule - depositBalance).toFixed(2)));
    const isDepositInsufficient = depositShortfallAmount > 0;
    const isDepositForfeit = isDepositForfeitByDays || isDepositForfeitByOrders || isDepositInsufficient;
    const refundDepositAmount = isDepositForfeit ? 0 : depositBalance;
    const forfeitDepositAmount = Math.max(0, Number((depositBalance - refundDepositAmount).toFixed(2)));
    const releaseAmount = Number((frozenBalance + refundDepositAmount).toFixed(2));
    const maxAvailableForDepositTopUp = Math.max(0, Number((availableBalance + releaseAmount).toFixed(2)));
    const depositTopUpForfeitAmount = isDepositForfeit
      ? Math.min(depositShortfallAmount, maxAvailableForDepositTopUp)
      : 0;
    const depositTopUpUnpaidAmount = Math.max(0, Number((depositShortfallAmount - depositTopUpForfeitAmount).toFixed(2)));
    const finalAvailableBalance = Number((availableBalance + releaseAmount - depositTopUpForfeitAmount).toFixed(2));

    return {
      userId: Number(user.id),
      staffTags: ruleSummary.staffTags,
      matchedStaffRule: ruleSummary.matchedStaffRule,
      joinedAt,
      inShopDays,
      quitCoolingDays: ruleSummary.matchedQuitCoolingDays,
      depositForfeitDays: ruleSummary.matchedDepositForfeitDays,
      effectiveAcceptedOrderCount: Number(effectiveAcceptedOrderCount || 0),
      minAcceptedOrdersForDepositRefund: this.staffExitDepositRefundMinAcceptedOrders,
      isDepositForfeit,
      isDepositForfeitByDays,
      isDepositForfeitByOrders,
      isDepositInsufficient,
      availableBalance,
      frozenBalance,
      depositBalance,
      refundDepositAmount,
      forfeitDepositAmount,
      depositTopUpForfeitAmount,
      depositTopUpUnpaidAmount,
      releaseAmount,
      finalAvailableBalance,
      clearAmount: Number((availableBalance + frozenBalance + depositBalance).toFixed(2)),
      depositAmountRule,
      firstWithdrawMinBalance: ruleSummary.matchedFirstWithdrawMinBalance,
      firstWithdrawMinAcceptedOrders: ruleSummary.matchedFirstWithdrawMinAcceptedOrders,
      refundWhenDepositInsufficient: false,
      blacklistAllowed: finalAvailableBalance <= 0,
      suggestedExitMode: StaffExitMode.RELEASE_TO_AVAILABLE,
    };
  }

  async getStaffExitPreview(id: number, actor?: { userType?: UserType; permissions?: string[] }) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        ...this.getUserIncludeFields(),
        walletAccount: {
          select: {
            availableBalance: true,
            frozenBalance: true,
            depositBalance: true,
          },
        },
      },
    });

    if (!user) throw new NotFoundException('用户不存在');
    this.assertActorCanAccessUser(actor, user.userType);
    if (user.userType !== UserType.STAFF) {
      throw new BadRequestException('仅员工支持退店操作');
    }
    if (user.staffEmploymentStatus === StaffEmploymentStatus.EXITED) {
      throw new BadRequestException('该员工已退店，不支持重复退店或清退');
    }
    if (user.staffEmploymentStatus === StaffEmploymentStatus.BLACKLISTED) {
      throw new BadRequestException('该员工已在黑名单中，不支持退店操作');
    }

    const [config, effectiveAcceptedOrderCount] = await Promise.all([
      this.staffRuleEngineService.getConfig(),
      this.countEffectiveAcceptedOrders(id),
    ]);

    return this.buildStaffExitPreviewFromUser(user, config, effectiveAcceptedOrderCount);
  }

  async exitStaffShop(id: number, dto: StaffExitDto, operatorId?: number, actor?: { userType?: UserType }) {
    if (dto?.mode === StaffExitMode.CLEAR_ALL) {
      return this.clearStaffAssets(
        id,
        {
          addToBlacklist: dto?.addToBlacklist,
          remark: dto?.addToBlacklist ? '员工清退并加入黑名单' : '员工清退',
        },
        operatorId,
        actor as any,
      );
    }

    const oldUser = await this.prisma.user.findUnique({
      where: { id },
      include: {
        ...this.getUserIncludeFields(),
        walletAccount: {
          select: {
            availableBalance: true,
            frozenBalance: true,
            depositBalance: true,
          },
        },
      },
    });

    if (!oldUser) {
      throw new NotFoundException('用户不存在');
    }
    this.assertActorCanAccessUser(actor, oldUser.userType);
    this.assertUserButtonPermission(actor, oldUser.userType, 'exit', '当前角色无权操作员工退店');

    if (oldUser.userType !== UserType.STAFF) {
      throw new BadRequestException('仅员工支持退店操作');
    }

    if (oldUser.staffEmploymentStatus === StaffEmploymentStatus.EXITED) {
      throw new BadRequestException('该员工已退店，不支持重复退店或清退');
    }

    if (oldUser.staffEmploymentStatus === StaffEmploymentStatus.BLACKLISTED) {
      throw new BadRequestException('该员工已在黑名单中，不支持重复退店');
    }

    const mode = dto?.mode;
    const addToBlacklist = Boolean(dto?.addToBlacklist);
    const [config, effectiveAcceptedOrderCount] = await Promise.all([
      this.staffRuleEngineService.getConfig(),
      this.countEffectiveAcceptedOrders(id),
    ]);
    const preview = this.buildStaffExitPreviewFromUser(oldUser, config, effectiveAcceptedOrderCount);
    const available = Number(preview.availableBalance ?? 0);
    const frozen = Number(preview.frozenBalance ?? 0);
    const deposit = Number(preview.depositBalance ?? 0);
    const refundableDeposit = Number(preview.refundDepositAmount ?? 0);
    const forfeitDeposit = Number(preview.forfeitDepositAmount ?? 0);
    const depositTopUpForfeit = Number(preview.depositTopUpForfeitAmount ?? 0);
    const releaseAmount = Number((frozen + refundableDeposit).toFixed(2));
    const finalAvailable = Number((available + releaseAmount - depositTopUpForfeit).toFixed(2));

    if (addToBlacklist && finalAvailable > 0) {
      throw new BadRequestException('加入黑名单前需先清空可用余额，请使用一键清零');
    }

    const now = new Date();
    const nextEmploymentStatus = addToBlacklist ? StaffEmploymentStatus.BLACKLISTED : StaffEmploymentStatus.EXITED;

    return this.prisma.$transaction(async (tx) => {
      await this.wallet.ensureWalletAccount(id, tx as any);

      const log = await tx.userLog.create({
        data: {
          userId: operatorId || 0,
          action: 'STAFF_EXIT_SHOP',
          targetType: 'USER',
          targetId: id,
          oldData: {
            staffEmploymentStatus: oldUser.staffEmploymentStatus,
            availableBalance: available,
            frozenBalance: frozen,
            depositBalance: deposit,
            effectiveAcceptedOrderCount: preview.effectiveAcceptedOrderCount,
          },
          newData: {
            mode,
            addToBlacklist,
            refundDepositAmount: refundableDeposit,
            forfeitDepositAmount: forfeitDeposit,
            depositTopUpForfeitAmount: depositTopUpForfeit,
          },
          remark: addToBlacklist ? '员工退店并加入黑名单' : '员工退店',
        },
      });

      const updatedUser = await tx.user.update({
        where: { id },
        data: {
          staffEmploymentStatus: nextEmploymentStatus,
          ...(addToBlacklist ? { status: UserStatus.DISABLED } : {}),
          staffCooldownUntil: addToBlacklist ? null : this.buildStaffCooldownUntil(now, Number(preview.quitCoolingDays || this.staffExitCooldownDays)),
          staffExitedAt: now,
          workMode: 'ONLINE',
          offlineJoinedAt: null,
          workStatus: PlayerWorkStatus.IDLE,
          workOnlineExpiresAt: null,
          canWithdraw: !addToBlacklist,
        },
        include: this.getUserIncludeFields(),
      });

      const accountAfter = await tx.walletAccount.update({
        where: { userId: id },
        data: {
          availableBalance: { increment: Number((releaseAmount - depositTopUpForfeit).toFixed(2)) },
          frozenBalance: 0,
          earningFrozenBalance: 0,
          withdrawFrozenBalance: 0,
          depositBalance: 0,
        } as any,
        select: { availableBalance: true, frozenBalance: true },
      });

      if (frozen > 0) {
        await tx.walletTransaction.updateMany({
          where: { userId: id, status: WalletTxStatus.FROZEN },
          data: { status: WalletTxStatus.AVAILABLE },
        });
        await tx.walletHold.updateMany({
          where: { userId: id, status: WalletHoldStatus.FROZEN },
          data: { status: WalletHoldStatus.RELEASED, releasedAt: now },
        });
      }

      if (refundableDeposit > 0) {
        await tx.walletDepositTransaction.create({
          data: {
            userId: id,
            amount: -refundableDeposit,
            bizType: 'STAFF_EXIT_RELEASE' as any,
            remark: '员工退店，保证金按规则退回可用余额',
            operatorId: operatorId ?? null,
          },
        });
      }

      if (forfeitDeposit > 0) {
        await tx.walletDepositTransaction.create({
          data: {
            userId: id,
            amount: -forfeitDeposit,
            bizType: 'STAFF_EXIT_CLEAR' as any,
            remark: '员工退店，保证金按规则不退',
            operatorId: operatorId ?? null,
          },
        });
      }

      if (depositTopUpForfeit > 0) {
        await tx.walletDepositTransaction.create({
          data: {
            userId: id,
            amount: -depositTopUpForfeit,
            bizType: 'STAFF_EXIT_CLEAR' as any,
            remark: '员工退店，保证金未缴满，从余额补扣后不退',
            operatorId: operatorId ?? null,
          },
        });
        await tx.walletTransaction.create({
          data: {
            userId: id,
            direction: 'OUT',
            bizType: 'STAFF_EXIT_CLEAR' as any,
            amount: depositTopUpForfeit,
            status: 'AVAILABLE',
            sourceType: 'STAFF_EXIT_DEPOSIT_TOP_UP_FORFEIT',
            sourceId: log.id,
            availableAfter: Number(accountAfter?.availableBalance ?? 0),
            frozenAfter: Number(accountAfter?.frozenBalance ?? 0),
            remark: '员工退店，保证金未缴满，从余额补扣',
          } as any,
        });
      }

      if (releaseAmount > 0) {
        await tx.walletTransaction.create({
          data: {
            userId: id,
            direction: 'IN',
            bizType: 'STAFF_EXIT_RELEASE' as any,
            amount: releaseAmount,
            status: 'AVAILABLE',
            sourceType: 'STAFF_EXIT_SHOP_RELEASE',
            sourceId: log.id,
            availableAfter: Number(accountAfter?.availableBalance ?? 0),
            frozenAfter: Number(accountAfter?.frozenBalance ?? 0),
          } as any,
        });
      }

      return updatedUser;
    });
  }

  async clearStaffAssets(
    id: number,
    dto: StaffClearDto,
    operatorId?: number,
    actor?: { userType?: UserType; permissions?: string[] },
  ) {
    const oldUser = await this.prisma.user.findUnique({
      where: { id },
      include: {
        ...this.getUserIncludeFields(),
        walletAccount: {
          select: {
            availableBalance: true,
            frozenBalance: true,
            depositBalance: true,
          },
        },
      },
    });

    if (!oldUser) throw new NotFoundException('用户不存在');
    this.assertActorCanAccessUser(actor, oldUser.userType);
    this.assertUserButtonPermission(actor, oldUser.userType, 'clear', '当前角色无权操作员工清退');
    if (oldUser.userType !== UserType.STAFF) {
      throw new BadRequestException('仅员工支持清退操作');
    }
    if (oldUser.staffEmploymentStatus === StaffEmploymentStatus.EXITED) {
      throw new BadRequestException('该员工已退店，不支持重复退店或清退');
    }
    if (oldUser.staffEmploymentStatus === StaffEmploymentStatus.BLACKLISTED) {
      throw new BadRequestException('该员工已在黑名单中，不支持重复清退');
    }

    const addToBlacklist = Boolean(dto?.addToBlacklist);
    const remark = String(dto?.remark || '').trim() || (addToBlacklist ? '员工清退并加入黑名单' : '员工清退');
    const available = Number(oldUser?.walletAccount?.availableBalance ?? 0);
    const frozen = Number(oldUser?.walletAccount?.frozenBalance ?? 0);
    const deposit = Number(oldUser?.walletAccount?.depositBalance ?? 0);
    const clearAmount = Number((available + frozen + deposit).toFixed(2));
    const now = new Date();
    const nextEmploymentStatus = addToBlacklist ? StaffEmploymentStatus.BLACKLISTED : StaffEmploymentStatus.EXITED;

    return this.prisma.$transaction(async (tx) => {
      await this.wallet.ensureWalletAccount(id, tx as any);

      const log = await tx.userLog.create({
        data: {
          userId: operatorId || 0,
          action: 'STAFF_CLEAR',
          targetType: 'USER',
          targetId: id,
          oldData: {
            staffEmploymentStatus: oldUser.staffEmploymentStatus,
            availableBalance: available,
            frozenBalance: frozen,
            depositBalance: deposit,
          },
          newData: {
            addToBlacklist,
            remark,
          },
          remark,
        },
      });

      const updatedUser = await tx.user.update({
        where: { id },
        data: {
          staffEmploymentStatus: nextEmploymentStatus,
          ...(addToBlacklist ? { status: UserStatus.DISABLED } : {}),
          staffCooldownUntil: addToBlacklist ? null : this.buildStaffCooldownUntil(now),
          staffExitedAt: now,
          workMode: 'ONLINE',
          offlineJoinedAt: null,
          workStatus: PlayerWorkStatus.IDLE,
          workOnlineExpiresAt: null,
          canWithdraw: false,
        },
        include: this.getUserIncludeFields(),
      });

      const accountAfter = await tx.walletAccount.update({
        where: { userId: id },
        data: {
          availableBalance: 0,
          frozenBalance: 0,
          earningFrozenBalance: 0,
          withdrawFrozenBalance: 0,
          depositBalance: 0,
        } as any,
        select: { availableBalance: true, frozenBalance: true },
      });

      if (frozen > 0) {
        await tx.walletTransaction.updateMany({
          where: { userId: id, status: WalletTxStatus.FROZEN },
          data: { status: WalletTxStatus.REVERSED as any },
        });
        await tx.walletHold.updateMany({
          where: { userId: id, status: WalletHoldStatus.FROZEN },
          data: { status: WalletHoldStatus.CANCELLED, releasedAt: now },
        });
      }

      if (deposit > 0) {
        await tx.walletDepositTransaction.create({
          data: {
            userId: id,
            amount: -deposit,
            bizType: 'STAFF_EXIT_CLEAR' as any,
            remark: '员工清退，保证金清零',
            operatorId: operatorId ?? null,
          },
        });
      }

      if (clearAmount > 0) {
        await tx.walletTransaction.create({
          data: {
            userId: id,
            direction: 'OUT',
            bizType: 'STAFF_EXIT_CLEAR' as any,
            amount: clearAmount,
            status: 'AVAILABLE',
            sourceType: 'STAFF_CLEAR',
            sourceId: log.id,
            availableAfter: Number(accountAfter?.availableBalance ?? 0),
            frozenAfter: Number(accountAfter?.frozenBalance ?? 0),
          } as any,
        });
      }

      return updatedUser;
    });
  }

  async findOne(id: number, actor?: { userType?: UserType }) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        ...this.getUserIncludeFields(),
        walletAccount: {
          select: {
            walletUid: true,
            availableBalance: true,
            frozenBalance: true,
            depositBalance: true,
          },
        },
        memberRechargeOrders: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        customerOrders: {
          select: {
            id: true,
            autoSerial: true,
            status: true,
            paidAmount: true,
            finalPayableAmount: true,
            createdAt: true,
            paymentTime: true,
            project: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        userCoupons: {
          select: {
            id: true,
            status: true,
            expiresAt: true,
            usedAt: true,
            template: {
              select: {
                id: true,
                name: true,
                type: true,
                discountValue: true,
              },
            },
          },
          orderBy: { id: 'desc' },
          take: 10,
        },
        memberPointTransactions: {
          select: {
            id: true,
            direction: true,
            bizType: true,
            points: true,
            remark: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        userLogs: {
          select: {
            id: true,
            action: true,
            oldData: true,
            newData: true,
            remark: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    this.assertActorCanAccessUser(actor, user.userType);

    return this.decorateUserWithStaffRule(user, await this.staffRuleEngineService.getConfig());
  }

  async update(
    id: number,
    updateUserDto: UpdateUserDto,
    operatorId?: number,
    actor?: { userType?: UserType; roleName?: string; permissions?: string[] },
  ) {

    const oldUser = await this.prisma.user.findUnique({
      where: { id },
      include: this.getUserIncludeFields(),
    });

    if (!oldUser) {
      throw new NotFoundException('用户不存在');
    }
    this.assertActorCanAccessUser(actor, oldUser.userType);
    if (!this.isSuperAdmin(actor)) {
      if (oldUser.userType === UserType.STAFF) {
        this.assertNonSuperStaffUpdatePayload(updateUserDto);
        this.assertUserButtonPermission(actor, oldUser.userType, 'edit', '当前角色无权编辑该类型用户资料');
      } else {
      const hasRolePatch = Object.prototype.hasOwnProperty.call(updateUserDto as any, 'roleId');
      const blockedFields = ['userType', 'password', 'needResetPwd'];
      const touchedBlockedFields = blockedFields.filter((field) =>
        Object.prototype.hasOwnProperty.call(updateUserDto as any, field),
      );
      if (touchedBlockedFields.length) {
        throw new ForbiddenException('当前角色无权修改用户身份或密码');
      }
      if (hasRolePatch) {
        this.assertUserButtonPermission(actor, oldUser.userType, 'assign-role', '当前角色无权分配该类型用户角色');
      }
      const hasProfilePatch = Object.keys(updateUserDto as any).some((field) => field !== 'roleId');
      if (hasProfilePatch) {
        this.assertUserButtonPermission(actor, oldUser.userType, 'edit', '当前角色无权编辑该类型用户资料');
      }
      }
    }

    if (updateUserDto.password) {
      updateUserDto.password = await bcrypt.hash(updateUserDto.password, 10);
    }

    const hasWorkModePatch = Object.prototype.hasOwnProperty.call(updateUserDto, 'workMode')
        || Object.prototype.hasOwnProperty.call(updateUserDto, 'offlineJoinedAt');

    const workModePayload = hasWorkModePatch
        ? this.normalizeWorkModePayload({
          workMode: (updateUserDto as any).workMode ?? (oldUser as any).workMode ?? 'ONLINE',
          offlineJoinedAt: (updateUserDto as any).offlineJoinedAt ?? (oldUser as any).offlineJoinedAt ?? null,
        })
        : null;

    const nextStatus = String((updateUserDto as any)?.staffEmploymentStatus || oldUser?.staffEmploymentStatus || '');
    if (oldUser.userType === UserType.STAFF && nextStatus === StaffEmploymentStatus.ACTIVE) {
      if (oldUser.staffEmploymentStatus === StaffEmploymentStatus.BLACKLISTED) {
        throw new BadRequestException('黑名单陪玩不支持再次入店');
      }
      if (
        oldUser.staffEmploymentStatus === StaffEmploymentStatus.EXITED &&
        oldUser.staffCooldownUntil &&
        new Date(oldUser.staffCooldownUntil).getTime() > Date.now()
      ) {
        throw new BadRequestException('当前仍在退店冷却期内，不支持恢复正常状态');
      }
    }

    if (
      oldUser.userType === UserType.STAFF &&
      oldUser.staffEmploymentStatus === StaffEmploymentStatus.FROZEN &&
      Object.prototype.hasOwnProperty.call(updateUserDto, 'canWithdraw') &&
      (updateUserDto as any).canWithdraw === true &&
      nextStatus !== StaffEmploymentStatus.ACTIVE
    ) {
      throw new BadRequestException('冻结中的员工不支持开启提现权限，请先恢复正常状态');
    }

    const normalizedStaffTags = Object.prototype.hasOwnProperty.call(updateUserDto, 'staffTags')
      ? this.normalizeStaffTags((updateUserDto as any).staffTags)
      : undefined;
    if (normalizedStaffTags !== undefined) {
      this.assertStaffRuleGroupSingle(normalizedStaffTags);
    }

    const shouldRestoreWithdrawOnStaffUnfreeze =
      oldUser.userType === UserType.STAFF &&
      oldUser.staffEmploymentStatus === StaffEmploymentStatus.FROZEN &&
      nextStatus === StaffEmploymentStatus.ACTIVE;

    return this.prisma.$transaction(async (tx) => {

      const user = await tx.user.update({
        where: { id },
        data: {
          ...updateUserDto,
          ...(shouldRestoreWithdrawOnStaffUnfreeze ? { canWithdraw: true } : {}),
          ...(shouldRestoreWithdrawOnStaffUnfreeze ? { staffDormantFreezeBaseAt: new Date() } : {}),
          ...(shouldRestoreWithdrawOnStaffUnfreeze ? { status: UserStatus.ACTIVE } : {}),
          ...(normalizedStaffTags !== undefined ? { staffTags: normalizedStaffTags } : {}),
          ...(workModePayload || {}),
        },
        include: this.getUserIncludeFields(),
      });

      // ==========================
      // 押金阈值降低 → 自动退还押金
      // ==========================
      if (
          updateUserDto.depositLimit !== undefined &&
          Number(updateUserDto.depositLimit) < Number(oldUser.depositLimit || 2000)
      ) {

        const wallet = await tx.walletAccount.findUnique({
          where: { userId: id },
          select: {
            depositBalance: true,
            availableBalance: true,
            frozenBalance: true,
          },
        });

        if (wallet) {

          const currentDeposit = Number(wallet.depositBalance || 0);
          const newLimit = Number(updateUserDto.depositLimit);

          if (currentDeposit > newLimit) {

            const refundAmount = currentDeposit - newLimit;

            // 更新钱包余额
            const walletAfter = await tx.walletAccount.update({
              where: { userId: id },
              data: {
                depositBalance: { decrement: refundAmount },
                availableBalance: { increment: refundAmount },
              },
              select: {
                availableBalance: true,
                frozenBalance: true,
              },
            });

            // ==========================
            // 写押金流水
            // ==========================
            const depositTx = await tx.walletDepositTransaction.create({
              data: {
                userId: id,
                amount: -refundAmount,
                bizType: 'DEPOSIT_REFUND',
                remark: '押金阈值降低退还',
              },
            });
            // ==========================
            // 写钱包流水
            // ==========================
            await tx.walletTransaction.create({
              data: {
                userId: id,
                direction: 'IN',
                bizType: 'DEPOSIT_REFUND',
                amount: refundAmount,
                status: 'AVAILABLE',
                sourceType: 'DEPOSIT_LIMIT_ADJUST',
                sourceId: depositTx.id,
                availableAfter: walletAfter.availableBalance,
                frozenAfter: walletAfter.frozenBalance,
              },
            });

          }
        }
      }

      // 记录操作日志
      if (operatorId) {

        const changedFields = this.getChangedFields(oldUser, user, updateUserDto);

        if (Object.keys(changedFields).length > 0) {

          await this.createUserLog(
              operatorId,
              id,
              'UPDATE_USER',
              'USER',
              this.getOldValues(oldUser, changedFields),
              changedFields,
              null,
              this.generateUpdateRemark(changedFields, oldUser, user)
          );

        }
      }

      return this.decorateUserWithStaffRule(user, await this.staffRuleEngineService.getConfig());

    });

  }

  async updateMyPassword(userId: number, newPassword: string) {
    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException('密码长度至少 6 位');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        needResetPwd: false,
      },
      // 这里沿用你现有 include，避免前端字段缺失
      include: this.getUserIncludeFields(),
    });
  }

  // 新增：获取可用的服务者评级列表
  async getAvailableRatings() {
    return this.prisma.staffRating.findMany({
      where: {
        status: 'ACTIVE',
      },
      select: {
        id: true,
        name: true,
        description: true,
        rate: true,
        scope: true,
        rules: true,
        sortOrder: true,
      },
      orderBy: [
        { sortOrder: 'asc' },
        { id: 'asc' },
      ],
    });
  }

  // 新增辅助方法：获取修改的字段
  private getChangedFields(oldUser: any, newUser: any, updateDto: any): Record<string, any> {
    const changedFields: Record<string, any> = {};

    // 遍历更新DTO中的字段，检查是否真的发生了变化
    Object.keys(updateDto).forEach(key => {
      if (updateDto[key] !== undefined && updateDto[key] !== null) {
        const oldValue = oldUser[key];
        const newValue = newUser[key];

        // 特殊处理：数字和字符串的比较
        if (typeof oldValue === 'number' && typeof newValue === 'number') {
          if (oldValue !== newValue) {
            changedFields[key] = newValue;
          }
        }
        // 特殊处理：日期比较
        else if (oldValue instanceof Date && newValue instanceof Date) {
          if (oldValue.getTime() !== newValue.getTime()) {
            changedFields[key] = newValue;
          }
        }
        // 默认比较
        else if (oldValue !== newValue) {
          changedFields[key] = newValue;
        }
      }
    });

    return changedFields;
  }

  // 获取旧值（只包含修改的字段）
  private getOldValues(oldUser: any, changedFields: Record<string, any>): Record<string, any> {
    const oldValues: Record<string, any> = {};
    Object.keys(changedFields).forEach(key => {
      oldValues[key] = oldUser[key];
    });
    return oldValues;
  }

  // 生成更新备注
  private generateUpdateRemark(changedFields: Record<string, any>, oldUser: any, newUser: any): string {
    const changes: string[] = [];

    Object.keys(changedFields).forEach(key => {
      const oldValue = oldUser[key];
      const newValue = newUser[key];

      // 根据字段类型生成可读的描述
      switch (key) {
        case 'name':
          changes.push(`姓名: ${oldValue || '空'} → ${newValue}`);
          break;
        case 'userType':
          changes.push(`用户身份: ${oldValue} → ${newValue}`);
          break;
        case 'status':
          changes.push(`账号状态: ${oldValue} → ${newValue}`);
          break;
        case 'level':
          changes.push(`等级: ${oldValue} → ${newValue}`);
          break;
        case 'rating':
          // 特殊处理评级字段
          if (oldValue === null || oldValue === undefined) {
            changes.push(`设置评级: ${newValue}`);
          } else if (newValue === null || newValue === undefined) {
            changes.push(`取消评级: ${oldValue}`);
          } else {
            changes.push(`变更评级: ${oldValue} → ${newValue}`);
          }
          break;
        case 'balance':
          changes.push(`余额: ¥${oldValue} → ¥${newValue}`);
          break;
        case 'realName':
          changes.push(`真实姓名: ${oldValue || '空'} → ${newValue}`);
          break;
        case 'email':
          changes.push(`邮箱: ${oldValue || '空'} → ${newValue}`);
          break;
        case 'needResetPwd':
          changes.push(`需重置密码: ${oldValue ? '是' : '否'} → ${newValue ? '是' : '否'}`);
          break;
        default:
          changes.push(`${key}: ${oldValue} → ${newValue}`);
      }
    });

    return changes.length > 0 ? `修改了: ${changes.join('; ')}` : '未修改任何字段';
  }

  async changeLevel(
    id: number,
    changeLevelDto: ChangeLevelDto,
    operatorId: number,
    actor?: { userType?: UserType; permissions?: string[] },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.getUserIncludeFields(), // 改为使用 include
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    this.assertActorCanAccessUser(actor, user.userType);
    this.assertUserButtonPermission(actor, user.userType, 'change-level', '当前角色无权调整服务者评级');

    // 只有员工才能调整等级
    if (user.userType !== 'STAFF') {
      throw new ForbiddenException('只有员工身份才能调整等级');
    }

    const oldRating = user.rating;
    const newRating = changeLevelDto.rating;

    // 如果等级没有变化，直接返回
    if (oldRating === newRating) {
      return user;
    }

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: { rating: newRating },
      include: this.getUserIncludeFields(), // 改为使用 include
    });

    // 记录操作日志 - 只记录等级变化
    await this.createUserLog(
        operatorId,
        id,
        'CHANGE_LEVEL',
        'USER',
        { rating: oldRating },
        { rating: newRating },
        null,
        changeLevelDto.remark || `等级调整: ${oldRating} → ${newRating}`
    );

    return updatedUser;
  }

  async resetPassword(
    id: number,
    resetPasswordDto: ResetPasswordDto,
    operatorId: number,
    actor?: { userType?: UserType; permissions?: string[] },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.getUserIncludeFields(), // 改为使用 include
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    this.assertActorCanAccessUser(actor, user.userType);
    this.assertUserButtonPermission(actor, user.userType, 'reset-password', '当前角色无权重置该类型用户密码');

    // 生成随机密码
    const tempPassword = Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: {
        password: hashedPassword,
        needResetPwd: true,
      },
      include: this.getUserIncludeFields(), // 改为使用 include
    });

    // 记录操作日志 - 只记录密码重置
    await this.createUserLog(
        operatorId,
        id,
        'RESET_PASSWORD',
        'USER',
        { needResetPwd: user.needResetPwd },
        { needResetPwd: true },
        null,
        resetPasswordDto.remark || '重置用户密码'
    );

    return {
      ...updatedUser,
      tempPassword, // 仅返回给操作者
    };
  }

  async resetWithdrawQrCode(
    id: number,
    operatorId?: number,
    actor?: { userType?: UserType; permissions?: string[] },
    remark?: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.getUserIncludeFields(),
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    this.assertActorCanAccessUser(actor, user.userType);
    this.assertUserButtonPermission(actor, user.userType, 'withdraw-qr-reset', '当前角色无权重置收款码');

    if (!user.withdrawQrCodeKey) {
      throw new BadRequestException('该用户当前没有已上传的收款码');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: {
        withdrawQrCodeKey: null,
        withdrawQrCodeUploadedAt: null,
      },
      include: this.getUserIncludeFields(),
    });

    if (operatorId) {
      await this.createUserLog(
        operatorId,
        id,
        'RESET_WITHDRAW_QR_CODE',
        'USER',
        {
          withdrawQrCodeKey: user.withdrawQrCodeKey,
          withdrawQrCodeUploadedAt: user.withdrawQrCodeUploadedAt,
        },
        {
          withdrawQrCodeKey: null,
          withdrawQrCodeUploadedAt: null,
        },
        updatedUser,
        remark || '管理员清理收款码，允许重新上传',
      );
    }

    return this.decorateUserWithStaffRule(updatedUser, await this.staffRuleEngineService.getConfig());
  }

  async remove(id: number, operatorId?: number, actor?: { userType?: UserType; permissions?: string[] }) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.getUserIncludeFields(), // 改为使用 include
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    this.assertActorCanAccessUser(actor, user.userType);
    this.assertUserButtonPermission(actor, user.userType, 'delete', '当前角色无权删除该类型用户');

    await this.prisma.user.delete({
      where: { id },
    });

    // 记录操作日志
    if (operatorId) {
      await this.createUserLog(
          operatorId,
          id,
          'DELETE_USER',
          'USER',
          user,
          null,
          null,
          '删除用户'
      );
    }

    return { message: '用户删除成功' };
  }

  // 修改：使用 include 而不是 select
  private getUserIncludeFields() {
    return {
      staffRating: {
        select: {
          id: true,
          name: true,
          rate: true,
          scope: true,
          description: true,
        }
      },
      Role: {  // 添加 Role 关联
        select: {
          id: true,
          name: true,
          description: true
        }
      },
      memberProfile: {
        select: {
          memberCode: true,
          levelCode: true,
          totalRechargeAmount: true,
          totalConsumeAmount: true,
          annualContribution: true,
          lastRechargeAt: true,
        },
      },
      memberPointAccount: {
        select: {
          availablePoints: true,
          totalEarnedPoints: true,
          totalSpentPoints: true,
        },
      },
      wechatBindings: {
        select: {
          id: true,
          platform: true,
          appId: true,
          openId: true,
          unionId: true,
          lastBindAt: true,
          lastLoginAt: true,
        },
        orderBy: [{ lastLoginAt: 'desc' as const }, { updatedAt: 'desc' as const }],
        take: 5,
      }
    };
  }

  private async createUserLog(
      operatorId: number,
      targetUserId: number,
      action: string,
      targetType: string,
      oldData: any,
      newData: any,
      fullData: any,
      remark?: string,
  ) {
    await this.prisma.userLog.create({
      data: {
        userId: operatorId,
        action,
        targetType,
        targetId: targetUserId,
        oldData,
        newData,
        remark,
      },
    });
  }

  //打手修改状态
  async updateMyWorkStatus(userId: number, workStatus: any) {
    await this.autoFreezeDormantStaffUsers([userId]);

    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { userType: true, staffEmploymentStatus: true, staffTags: true },
    });
    if (!current || current.userType !== UserType.STAFF) {
      throw new BadRequestException('当前账号不是员工');
    }
    if (current.staffEmploymentStatus !== StaffEmploymentStatus.ACTIVE) {
      if (current.staffEmploymentStatus === StaffEmploymentStatus.FROZEN) {
        const config = await this.staffRuleEngineService.getConfig();
        throw new BadRequestException(this.getStaffDormantFreezeMessage(this.staffRuleEngineService.getDormantFreezeDays(config, (current as any)?.staffTags)));
      }
      throw new BadRequestException('当前员工已退店或已加入黑名单，无法修改接单状态');
    }
    const nextWorkStatus = String(workStatus || '').toUpperCase();
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        workStatus,
        ...(nextWorkStatus === PlayerWorkStatus.IDLE
          ? {
            workMode: 'ONLINE',
            workOnlineExpiresAt: this.buildPlayerOnlineLeaseExpiresAt(),
            offlineJoinedAt: null,
          }
          : {}),
      },
      select: { id: true, name: true, phone: true, workStatus: true },
    });
  }

  async touchPlayerOnlineLease(id: number) {
    return this.prisma.user.updateMany({
      where: {
        id,
        userType: UserType.STAFF,
        workMode: 'ONLINE',
      },
      data: {
        workOnlineExpiresAt: this.buildPlayerOnlineLeaseExpiresAt(),
      },
    });
  }

  async updatePlayerWorkMode(id: number, workMode: 'ONLINE' | 'OFFLINE') {
    await this.autoFreezeDormantStaffUsers([id]);

    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { userType: true, staffEmploymentStatus: true, staffTags: true },
    });
    if (!current || current.userType !== UserType.STAFF) {
      throw new BadRequestException('当前账号不是员工');
    }
    if (current.staffEmploymentStatus !== StaffEmploymentStatus.ACTIVE) {
      if (current.staffEmploymentStatus === StaffEmploymentStatus.FROZEN) {
        const config = await this.staffRuleEngineService.getConfig();
        throw new BadRequestException(this.getStaffDormantFreezeMessage(this.staffRuleEngineService.getDormantFreezeDays(config, (current as any)?.staffTags)));
      }
      throw new BadRequestException('当前员工已退店或已加入黑名单，无法切换工作模式');
    }
    const payload = this.normalizeWorkModePayload({
      workMode,
      offlineJoinedAt: workMode === 'OFFLINE' ? new Date() : null,
    });

    return this.prisma.user.update({
      where: { id },
      data: payload,
      select: {
        id: true,
        name: true,
        phone: true,
        workMode: true,
        offlineJoinedAt: true,
        workOnlineExpiresAt: true,
      },
    });
  }

//  获取空闲的打手
  async getPlayerOptions(params: {
    keyword?: string;
    onlyIdle?: boolean;
    limit?: number;
    page?: number;
    paginate?: boolean;
    onlyOnline?: boolean;
    includeFrozen?: boolean;
  }) {
    const { keyword, onlyIdle = true, limit, page, paginate, onlyOnline = false, includeFrozen = false } = params || {};
    const leaseNow = new Date();
    await this.autoFreezeDormantStaffUsers();
    if (!this.autoOfflineDisabled) {
      await this.prisma.user.updateMany({
        where: {
          userType: UserType.STAFF,
          workMode: 'ONLINE',
          OR: [
            { workOnlineExpiresAt: null },
            { workOnlineExpiresAt: { lte: leaseNow } },
          ],
        },
        data: {
          workStatus: PlayerWorkStatus.IDLE,
          workOnlineExpiresAt: null,
        },
      });
    }

    const where: any = {
      userType: UserType.STAFF,
      staffEmploymentStatus: includeFrozen
        ? { in: [StaffEmploymentStatus.ACTIVE, StaffEmploymentStatus.FROZEN] }
        : StaffEmploymentStatus.ACTIVE,
    };
    if (onlyIdle) where.workStatus = PlayerWorkStatus.IDLE;
    if (onlyOnline) {
      where.workMode = 'ONLINE';
      where.workOnlineExpiresAt = { gt: leaseNow };
    }

    if (keyword) {
      where.OR = [{ name: { contains: keyword } }, { realName: { contains: keyword } }, { phone: { contains: keyword } }];
    }

    const take = Number(limit ?? 100);
    const pageNo = Number.isFinite(Number(page)) && Number(page) > 0 ? Number(page) : 1;
    const pageSize = Number.isFinite(take) && take > 0 ? take : 100;
    const allUsers = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        realName: true,
        phone: true,
        workMode: true,
        offlineJoinedAt: true,
        workOnlineExpiresAt: true,
        workStatus: true,
        rating: true,
        staffRating: {           // ✅ 关联等级表
          select: {
            name: true,    // 等级名称
          },
        },
      },
      orderBy: [
        { rating: 'desc' },
        { id: 'asc' },
      ],
    });
    const dayNow = new Date();
    const start = new Date(dayNow.getFullYear(), dayNow.getMonth(), dayNow.getDate(), 0, 0, 0, 0);
    const end = new Date(dayNow.getFullYear(), dayNow.getMonth(), dayNow.getDate(), 23, 59, 59, 999);

    const ids = allUsers.map((u) => u.id);
    let countMap: Record<number, number> = {};
    if (ids.length) {
      const grouped = await this.prisma.orderParticipant.groupBy({
        by: ['userId'],
        where: {
          userId: { in: ids },
          acceptedAt: { not: null }, // ✅ 只统计已接单的，替换掉的不会计数
          rejectedAt: null,          // ✅ 排除拒单
          dispatch: {
            OR: [
              { status: 'ARCHIVED' as any, archivedAt: { gte: start, lte: end } },
              { status: 'COMPLETED' as any, completedAt: { gte: start, lte: end } },
            ],
          },
        },
        _count: { _all: true },
      });

      countMap = grouped.reduce((acc: any, g: any) => {
        acc[Number(g.userId)] = Number(g._count?._all ?? 0);
        return acc;
      }, {});
    }

    const rows = allUsers
        .map((u) => ({ ...u,
          displayName: String(u?.name || '').trim() || `#${u.id}`,
          ratingName: u?.staffRating?.name ?? '-',   // ✅ 等级名称
          todayHandledCount: countMap[Number(u.id)] ?? 0}))
        .sort((a, b) => {
          const ca = Number(a.todayHandledCount ?? 0);
          const cb = Number(b.todayHandledCount ?? 0);
          if (ca !== cb) return ca - cb;         // ✅ 接单最少优先
          const ra = Number(a.rating ?? 0);
          const rb = Number(b.rating ?? 0);
          if (rb !== ra) return rb - ra;
          return Number(a.id) - Number(b.id);
        });

    if (paginate) {
      const currentPage = pageNo;
      const currentLimit = pageSize;
      const total = rows.length;
      const start = (currentPage - 1) * currentLimit;
      return {
        data: rows.slice(start, start + currentLimit),
        total,
        page: currentPage,
        limit: currentLimit,
        totalPages: Math.max(1, Math.ceil(total / currentLimit)),
      };
    }

    return rows;
  }

}
