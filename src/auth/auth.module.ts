import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../prisma.service'; // 正确路径
import { SystemConfigModule } from '../system-config/system-config.module';

@Module({
  imports: [
    SystemConfigModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key',
      signOptions: { expiresIn: '2h' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, PrismaService], // 确保 PrismaService 在这里提供
  exports: [JwtModule, AuthService],
})
export class AuthModule {}
