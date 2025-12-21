import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangeLevelDto } from './dto/change-level.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UserType, PlayerWorkStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async create(createUserDto: CreateUserDto, operatorId?: number) {
    const { phone, password, userType = UserType.REGISTERED_USER, ...rest } = createUserDto;

    // 检查用户是否已存在
    const existingUser = await this.prisma.user.findUnique({
      where: { phone },
    });

    if (existingUser) {
      throw new BadRequestException('用户已存在');
    }

    // 加密密码
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await this.prisma.user.create({
      data: {
        phone,
        password: hashedPassword,
        userType,
        needResetPwd: userType !== UserType.REGISTERED_USER, // 员工首次登录需要重置密码
        ...rest,
      },
      include: this.getUserIncludeFields(), // 改为使用 include
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
  }) {
    const { page = 1, limit = 10, search, userType, status } = params;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (search) {
      where.OR = [
        { phone: { contains: search } },
        { name: { contains: search } },
        { realName: { contains: search } },
      ];
    }

    if (userType) {
      where.userType = userType;
    }

    if (status) {
      where.status = status;
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        include: this.getUserIncludeFields(), // 改为使用 include
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: number) {
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

    return user;
  }

  async update(id: number, updateUserDto: UpdateUserDto, operatorId?: number) {
    const oldUser = await this.prisma.user.findUnique({
      where: { id },
      include: this.getUserIncludeFields(), // 改为使用 include
    });

    if (!oldUser) {
      throw new NotFoundException('用户不存在');
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: updateUserDto,
      include: this.getUserIncludeFields(), // 改为使用 include
    });

    // 记录操作日志 - 只记录修改的字段
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

  async changeLevel(id: number, changeLevelDto: ChangeLevelDto, operatorId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.getUserIncludeFields(), // 改为使用 include
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }

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

  async resetPassword(id: number, resetPasswordDto: ResetPasswordDto, operatorId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.getUserIncludeFields(), // 改为使用 include
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }

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

  async remove(id: number, operatorId?: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.getUserIncludeFields(), // 改为使用 include
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }

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

//  获取空闲的打手
  async getPlayerOptions(params: { keyword?: string; onlyIdle?: boolean }) {
    const { keyword, onlyIdle = true } = params || {};
    const where: any = {
      userType: UserType.STAFF, // 你当前打手归 STAFF，后续你若拆 PLAYER 再改
    };
    if (onlyIdle) where.workStatus = PlayerWorkStatus.IDLE;

    if (keyword) {
      where.OR = [
        { name: { contains: keyword } },
        { phone: { contains: keyword } },
      ];
    }

    return this.prisma.user.findMany({
      where,
      select: { id: true, name: true, phone: true, workStatus: true },
      orderBy: [{ workStatus: 'asc' }, { id: 'desc' }],
      take: 50,
    });
  }
}
