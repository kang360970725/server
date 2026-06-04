import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  ForbiddenException
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { PrismaService } from '../prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  static readonly DEFAULT_ACCESS_TOKEN_EXPIRES_IN = '2h';
  static readonly MINI_ACCESS_TOKEN_EXPIRES_IN = '30d';

  constructor(
      private prisma: PrismaService,
      private jwtService: JwtService,
  ) {}

  private signAccessToken(
    user: { id?: number; userId?: number; phone?: string; name?: string },
    expiresIn: StringValue | number = AuthService.DEFAULT_ACCESS_TOKEN_EXPIRES_IN as StringValue,
  ) {
    const uid = Number(user?.id || user?.userId || 0);
    if (!uid) throw new UnauthorizedException('无效用户');
    const payload = {
      phone: String(user?.phone || '').trim(),
      sub: uid,
      name: String(user?.name || '').trim(),
    };
    return this.jwtService.sign(payload, { expiresIn });
  }

  private buildMiniProfileCompletion(user: any) {
    const phone = String(user?.phone || '').trim();
    const name = String(user?.name || '').trim();
    const avatar = String(user?.avatar || '').trim();
    const bindings = Array.isArray(user?.wechatBindings) ? user.wechatBindings : [];
    const latestBinding = bindings[0] || null;
    const bindingNickname = String(latestBinding?.nickname || '').trim();

    const needPhone = !phone || phone.startsWith('wx_');
    const needNickname = !bindingNickname && (!name || name.startsWith('微信用户'));
    const needAvatar = !avatar;

    return {
      completed: !(needPhone || needNickname || needAvatar),
      needPhone,
      needNickname,
      needAvatar,
    };
  }

  async register(registerDto: RegisterDto) {
    // 添加 null 检查
    if (!registerDto) {
      throw new BadRequestException('请求数据不能为空');
    }

    const { phone, password, name } = registerDto;

    // 检查必要字段
    if (!phone || !password) {
      throw new BadRequestException('手机号和密码是必填项');
    }

    // 检查用户是否已存在
    const existingUser = await this.prisma.user.findUnique({
      where: { phone },
    });

    if (existingUser) {
      throw new ConflictException('用户已存在');
    }

    // 加密密码
    const hashedPassword = await bcrypt.hash(password, 10);

    // 创建用户 - 只使用基本字段
    const user = await this.prisma.user.create({
      data: {
        phone,
        password: hashedPassword,
        name: name || `用户${phone.slice(-4)}`,
        userType: 'REGISTERED_USER', // 默认用户类型
      },
      select: {
        id: true,
        phone: true,
        name: true,
        userType: true,
        level: true,
        balance: true,
        createdAt: true,
      },
    });

    // 生成 token
    const access_token = this.signAccessToken(user);

    return {
      access_token,
      user,
    };
  }

  async login(loginDto: LoginDto) {
    const { phone, password } = loginDto;

    const user = await this.prisma.user.findUnique({
      where: { phone },
    });

    // ✅ 账号不存在：返回 200 + success=false（不抛 401）
    if (!user) {
      return {
        success: false,
        message: '手机号或密码错误',
      };
    }

    // ✅ 密码错误：同样返回 200 + success=false
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return {
        success: false,
        message: '手机号或密码错误',
      };
    }
// 查到 user 之后，校验密码之前或之后都可以
    if (user.status === UserStatus.DISABLED) {
      throw new ForbiddenException('账号已禁用，禁止登录');
    }
    // ✅ 登录成功
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
      },
    });
    const access_token = this.signAccessToken(user);

    // 返回用户信息（不包含密码）
    const { password: _, ...userWithoutPassword } = user;

    return {
      success: true,
      access_token,
      user: {
        ...userWithoutPassword,
        lastLoginAt: new Date(),
      },
    };
  }


  async validateUser(userId: number) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        name: true,
        userType: true,
        level: true,
        balance: true,
        avatar: true,
        createdAt: true,
      },
    });
  }

  async getUserWithPermissions(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        name: true,
        userType: true,
        level: true,
        balance: true,
        avatar: true,
        needResetPwd: true,
        roleId: true,
        createdAt: true,
        memberProfile: {
          select: {
            levelCode: true,
            memberCode: true,
            totalRechargeAmount: true,
            annualContribution: true,
          },
        },
        memberPointAccount: {
          select: {
            availablePoints: true,
            totalEarnedPoints: true,
            totalSpentPoints: true,
          },
        },
        walletAccount: {
          select: {
            availableBalance: true,
            frozenBalance: true,
            depositBalance: true,
            walletUid: true,
          },
        },
        wechatBindings: {
          select: {
            id: true,
            platform: true,
            appId: true,
            openId: true,
            unionId: true,
            nickname: true,
            avatarUrl: true,
            lastBindAt: true,
            lastLoginAt: true,
          },
          orderBy: [{ lastLoginAt: 'desc' as const }, { updatedAt: 'desc' as const }],
          take: 5,
        },
        Role: {
          select: {
            id: true,
            name: true,
            permissions: { select: { key: true } },
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }

    const permissions = user.Role?.permissions?.map((p) => p.key) || [];
    const profileCompletion = this.buildMiniProfileCompletion(user);

    // ✅ 不把 Role.permissions 全量给前端也行；这里保留 Role 基础信息方便展示
    return {
      ...user,
      permissions,
      profileCompletion,
      profileCompleted: profileCompletion.completed,
    };
  }

  refreshAccessToken(
    user: { id?: number; userId?: number; phone?: string; name?: string },
    options?: { mini?: boolean },
  ) {
    const mini = !!options?.mini;
    const access_token = this.signAccessToken(
      user,
      mini ? AuthService.MINI_ACCESS_TOKEN_EXPIRES_IN : AuthService.DEFAULT_ACCESS_TOKEN_EXPIRES_IN,
    );
    return {
      access_token,
      expiresInSeconds: mini ? 30 * 24 * 60 * 60 : 2 * 60 * 60,
    };
  }

}
