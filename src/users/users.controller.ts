import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  ParseIntPipe,
  UseGuards,
  Request,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangeLevelDto } from './dto/change-level.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserType } from '@prisma/client';
import { UpdateWorkStatusDto } from './dto/update-work-status.dto';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @UseGuards(PermissionsGuard)
  @Permissions('users:page')
  create(@Body() createUserDto: CreateUserDto, @Request() req) {
    return this.usersService.create(createUserDto, req.user.userId);
  }

  @Get()
  @UseGuards(PermissionsGuard)
  @Permissions('users:page')
  findAll(
      @Query('page') page?: number,
      @Query('limit') limit?: number,
      @Query('search') search?: string,
      @Query('userType') userType?: UserType,
      @Query('status') status?: string,
  ) {
    return this.usersService.findAll({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      search,
      userType,
      status,
    });
  }

  @Get(':id')
  @UseGuards(PermissionsGuard)
  @Permissions('users:page')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @Permissions('users:page')
  update(
      @Param('id', ParseIntPipe) id: number,
      @Body() updateUserDto: UpdateUserDto,
      @Request() req,
  ) {
    return this.usersService.update(id, updateUserDto, req.user.userId);
  }

  // 管理端用：获取可用评级（在用户管理页里常见）
  @Get('ratings/available')
  @UseGuards(PermissionsGuard)
  @Permissions('users:page')
  getAvailableRatings() {
    return this.usersService.getAvailableRatings();
  }

  @Patch(':id/level')
  @UseGuards(PermissionsGuard)
  @Permissions('users:page')
  changeLevel(
      @Param('id', ParseIntPipe) id: number,
      @Body() changeLevelDto: ChangeLevelDto,
      @Request() req,
  ) {
    return this.usersService.changeLevel(id, changeLevelDto, req.user.userId);
  }

  @Post(':id/reset-password')
  @UseGuards(PermissionsGuard)
  @Permissions('users:page')
  resetPassword(
      @Param('id', ParseIntPipe) id: number,
      @Body() resetPasswordDto: ResetPasswordDto,
      @Request() req,
  ) {
    return this.usersService.resetPassword(id, resetPasswordDto, req.user.userId);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @Permissions('users:page')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.usersService.remove(id, req.user.userId);
  }

  // ✅ 自助：陪玩/员工自己改上班状态（不应被 users:page 挡住）
  @Post('work-status')
  updateMyWorkStatus(@Body() dto: UpdateWorkStatusDto, @Request() req) {
    return this.usersService.updateMyWorkStatus(req.user.userId, dto.workStatus);
  }

  // ✅ 通用：派单/筛选陪玩下拉（避免被 users:page 误伤）
  @Post('players/options')
  getPlayerOptions(@Body() body: any) {
    return this.usersService.getPlayerOptions(body);
  }

  // users.controller.ts 里新增一个接口（保持 @UseGuards(JwtAuthGuard) 生效即可）
  @Post('me/password')
  updateMyPassword(@Body() body: { newPassword: string }, @Request() req) {
    return this.usersService.updateMyPassword(req.user.userId, body.newPassword);
  }
}
