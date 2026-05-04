import { Body, Controller, Get, Post, Request, UseGuards } from '@nestjs/common';
import { Public } from './decorators/public.decorator';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Public()
  @Post('login')
  login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getProfile(@Request() req) {
    // 这里你原来多调用了一次 validateUser，但最终返回的是 getUserWithPermissions
    return await this.authService.getUserWithPermissions(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('refresh')
  refresh(@Request() req) {
    return this.authService.refreshAccessToken(req.user);
  }
}
