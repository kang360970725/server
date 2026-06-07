import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangeLevelDto } from './dto/change-level.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UserType, PlayerWorkStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { WalletService } from '../wallet/wallet.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService, private wallet: WalletService) {}

  private getActorAllowedUserTypes(actor?: { userType?: UserType; permissions?: string[] }): UserType[] | null {
    const permissions = Array.isArray(actor?.permissions) ? actor!.permissions! : [];
    const allowed = new Set<UserType>();

    if (permissions.includes('users:member:page')) {
      allowed.add(UserType.REGISTERED_USER);
    }

    if (permissions.includes('users:staff:page')) {
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
    actor: { userType?: UserType; permissions?: string[] } | undefined,
    targetUserType?: UserType,
  ) {
    const allowed = this.getActorAllowedUserTypes(actor);
    if (!targetUserType || !allowed.includes(targetUserType)) {
      throw new ForbiddenException('无权访问该用户');
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
    };
  }

  async create(
    createUserDto: CreateUserDto,
    operatorId?: number,
    actor?: { userType?: UserType; permissions?: string[] },
  ) {
    const { phone, password, userType = UserType.REGISTERED_USER, ...rest } = createUserDto;
    this.assertActorCanAccessUser(actor, userType);
    const workModePayload = this.normalizeWorkModePayload({
      workMode: createUserDto.workMode,
      offlineJoinedAt: createUserDto.offlineJoinedAt,
    });

    // 检查用户是否已存在
    const existingUser = await this.prisma.user.findUnique({
      where: { phone },
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
          phone,
          password: hashedPassword,
          userType,
          needResetPwd: userType !== UserType.REGISTERED_USER,// 员工首次登录需要重置密码
          ...rest,
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
          `创建用户: ${phone}`
      );
    }

    return user;
  }

  async findAll(params: {
    page?: number;
    limit?: number;
    search?: string;
    userType?: UserType;
    status?: string;
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

    const sceneUserTypes = resolveSceneUserTypes();
    if (sceneUserTypes?.length) {
      AND.push({ userType: { in: sceneUserTypes } });
    }

    /**
     * 1️⃣ 搜索：支持 ID / 手机号 / name / realName
     */
    if (search) {
      const keyword = String(search).trim();

      const OR: any[] = [
        { phone: { contains: keyword } },
        { name: { contains: keyword } },
        { realName: { contains: keyword } }
      ];

      if (/^\d+$/.test(keyword)) {
        OR.push({ id: Number(keyword) });
      }

      AND.push({ OR });
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

    /**
     * 6️⃣ 数据加工
     */
    const data = users.map((u: any) => {

      const available = Number(u?.walletAccount?.availableBalance ?? 0);
      const frozen = Number(u?.walletAccount?.frozenBalance ?? 0);

      const lastAcceptOrderAt =
          u?.orderParticipants?.[0]?.acceptedAt ?? null;

      return {
        ...u,

        wallet: {
          walletUid: u?.walletAccount?.walletUid ?? null,
          availableBalance: available,
          frozenBalance: frozen,
          totalBalance: Number((available + frozen).toFixed(2)),
          depositBalance: u?.walletAccount?.depositBalance
        },

        lastAcceptOrderAt
      };
    });

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: number, actor?: { userType?: UserType }) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        ...this.getUserIncludeFields(),
        recharges: {
          // select: {
          //   id: true,
          //   amount: true,
          //   status: true,
          //   createdAt: true,
          // },
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

    return user;
  }

  async update(id: number, updateUserDto: UpdateUserDto, operatorId?: number, actor?: { userType?: UserType }) {

    const oldUser = await this.prisma.user.findUnique({
      where: { id },
      include: this.getUserIncludeFields(),
    });

    if (!oldUser) {
      throw new NotFoundException('用户不存在');
    }
    this.assertActorCanAccessUser(actor, oldUser.userType);

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

    return this.prisma.$transaction(async (tx) => {

      const user = await tx.user.update({
        where: { id },
        data: {
          ...updateUserDto,
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

      return user;

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

  // 新增：获取可用的员工评级列表
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

  async changeLevel(id: number, changeLevelDto: ChangeLevelDto, operatorId: number, actor?: { userType?: UserType }) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.getUserIncludeFields(), // 改为使用 include
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    this.assertActorCanAccessUser(actor, user.userType);

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

  async resetPassword(id: number, resetPasswordDto: ResetPasswordDto, operatorId: number, actor?: { userType?: UserType }) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.getUserIncludeFields(), // 改为使用 include
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    this.assertActorCanAccessUser(actor, user.userType);

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

  async remove(id: number, operatorId?: number, actor?: { userType?: UserType }) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.getUserIncludeFields(), // 改为使用 include
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    this.assertActorCanAccessUser(actor, user.userType);

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
    return this.prisma.user.update({
      where: { id: userId },
      data: { workStatus },
      select: { id: true, name: true, phone: true, workStatus: true },
    });
  }

  async updatePlayerWorkMode(id: number, workMode: 'ONLINE' | 'OFFLINE') {
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
  }) {
    const { keyword, onlyIdle = true, limit, page, paginate, onlyOnline = false } = params || {};
    const where: any = { userType: UserType.STAFF };
    if (onlyIdle) where.workStatus = PlayerWorkStatus.IDLE;
    if (onlyOnline) where.workMode = 'ONLINE';

    if (keyword) {
      where.OR = [{ name: { contains: keyword } }, { phone: { contains: keyword } }];
    }

    const take = Number(limit ?? 100);
    const pageNo = Number.isFinite(Number(page)) && Number(page) > 0 ? Number(page) : 1;
    const pageSize = Number.isFinite(take) && take > 0 ? take : 100;
    const allUsers = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        phone: true,
        workMode: true,
        offlineJoinedAt: true,
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
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

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
