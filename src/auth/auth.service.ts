import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException  // 添加这个导入
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
      private prisma: PrismaService,
      private jwtService: JwtService,
  ) {}

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
    const payload = { phone: user.phone, sub: user.id };
    const access_token = this.jwtService.sign(payload);

    return {
      access_token,
      user,
    };
  }

  async login(loginDto: LoginDto) {
    const { phone, password } = loginDto;

    // 查找用户
    const user = await this.prisma.user.findUnique({
      where: { phone },
    });

    if (!user) {
      throw new UnauthorizedException('手机号或密码错误');
    }

    // 验证密码
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('手机号或密码错误');
    }

    // 生成 token
    const payload = { phone: user.phone, sub: user.id };
    const access_token = this.jwtService.sign(payload);

    // 返回用户信息（不包含密码）
    const { password: _, ...userWithoutPassword } = user;

    return {
      access_token,
      user: userWithoutPassword,
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

    // ✅ 不把 Role.permissions 全量给前端也行；这里保留 Role 基础信息方便展示
    return {
      ...user,
      permissions,
    };
  }

}
