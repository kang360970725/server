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
  ForbiddenException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { MemberService } from '../member/member.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangeLevelDto } from './dto/change-level.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserType } from '@prisma/client';
import { UpdateWorkStatusDto } from './dto/update-work-status.dto';
import { StaffExitDto } from './dto/staff-exit.dto';
import { StaffClearDto } from './dto/staff-clear.dto';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { miniOk } from '../mini/mini.response';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly memberService: MemberService,
  ) {}

  private static readonly userManagePermissions = [
    'users:member:page',
    'users:staff:page',
    'users:internal:page',
  ] as const;

  private assertSuperAdmin(req: any) {
    if (req?.user?.userType !== UserType.SUPER_ADMIN) {
      throw new ForbiddenException('当前操作仅超级管理员可执行');
    }
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  create(@Body() createUserDto: CreateUserDto, @Request() req) {
    return this.usersService.create(createUserDto, req.user.userId, req.user);
  }

  @Get()
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions, 'orders:list:page')
  findAll(
      @Query('page') page?: number,
      @Query('limit') limit?: number,
      @Query('search') search?: string,
      @Query('userType') userType?: UserType,
      @Query('status') status?: string,
      @Query('staffEmploymentStatus') staffEmploymentStatus?: string,
      @Query('anonymousOnly') anonymousOnly?: string,
      @Query('includeStaffMembers') includeStaffMembers?: string,
      @Query('loginInactiveDays') loginInactiveDays?: number,
      @Query('acceptInactiveDays') acceptInactiveDays?: number,
      @Query('scene') scene?: string,
      @Request() req?: any,
  ) {
    return this.usersService.findAll({
      page,
      limit,
      search,
      userType,
      status,
      staffEmploymentStatus,
      anonymousOnly,
      includeStaffMembers,
      loginInactiveDays,
      acceptInactiveDays,
      scene,
      actor: req?.user,
    });
  }

  @Get('staff/wallet-statistics')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  getStaffWalletStatistics() {
    return this.usersService.getStaffWalletStatistics();
  }

  @Get(':id')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  findOne(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.usersService.findOne(id, req.user);
  }

  @Get(':id/member-game-cards')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  listMemberGameCards(@Param('id', ParseIntPipe) id: number) {
    return this.memberService.listAdminGameCards(id);
  }

  @Post(':id/member-game-cards')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  createMemberGameCard(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Request() req: any) {
    this.assertSuperAdmin(req);
    return this.memberService.createAdminGameCard(id, body || {});
  }

  @Post(':id/member-game-cards/:cardId/set-primary')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  setMemberGameCardPrimary(
      @Param('id', ParseIntPipe) id: number,
      @Param('cardId', ParseIntPipe) cardId: number,
      @Request() req: any,
  ) {
    this.assertSuperAdmin(req);
    return this.memberService.setAdminGameCardPrimary(id, cardId);
  }

  @Delete(':id/member-game-cards/:cardId')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  deleteMemberGameCard(
      @Param('id', ParseIntPipe) id: number,
      @Param('cardId', ParseIntPipe) cardId: number,
      @Request() req: any,
  ) {
    this.assertSuperAdmin(req);
    return this.memberService.deleteAdminGameCard(id, cardId);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  update(
      @Param('id', ParseIntPipe) id: number,
      @Body() updateUserDto: UpdateUserDto,
      @Request() req,
  ) {
    return this.usersService.update(id, updateUserDto, req.user.userId, req.user);
  }

  @Post(':id/withdraw-qr-code/reset')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  resetWithdrawQrCode(
      @Param('id', ParseIntPipe) id: number,
      @Body() body: { remark?: string },
      @Request() req,
  ) {
    return this.usersService.resetWithdrawQrCode(id, req.user.userId, req.user, body?.remark);
  }

  @Post(':id/staff-exit')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  staffExit(
      @Param('id', ParseIntPipe) id: number,
      @Body() dto: StaffExitDto,
      @Request() req,
  ) {
    return this.usersService.exitStaffShop(id, dto, req.user.userId, req.user);
  }

  @Post(':id/staff-exit-preview')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  staffExitPreview(
      @Param('id', ParseIntPipe) id: number,
      @Request() req,
  ) {
    return this.usersService.getStaffExitPreview(id, req.user);
  }

  @Post(':id/staff-clear')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  staffClear(
      @Param('id', ParseIntPipe) id: number,
      @Body() dto: StaffClearDto,
      @Request() req,
  ) {
    return this.usersService.clearStaffAssets(id, dto, req.user.userId, req.user);
  }

  // 管理端用：获取可用评级（在用户管理页里常见）
  @Get('ratings/available')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  getAvailableRatings() {
    return this.usersService.getAvailableRatings();
  }

  @Patch(':id/level')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  changeLevel(
      @Param('id', ParseIntPipe) id: number,
      @Body() changeLevelDto: ChangeLevelDto,
      @Request() req,
  ) {
    return this.usersService.changeLevel(id, changeLevelDto, req.user.userId, req.user);
  }

  @Post(':id/reset-password')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  resetPassword(
      @Param('id', ParseIntPipe) id: number,
      @Body() resetPasswordDto: ResetPasswordDto,
      @Request() req,
  ) {
    return this.usersService.resetPassword(id, resetPasswordDto, req.user.userId, req.user);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @Permissions(...UsersController.userManagePermissions)
  remove(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.usersService.remove(id, req.user.userId, req.user);
  }

  // ✅ 自助：陪玩/员工自己改上班状态（不应被 users:page 挡住）
  @Post('work-status')
  updateMyWorkStatus(@Body() dto: UpdateWorkStatusDto, @Request() req) {
    return this.usersService.updateMyWorkStatus(req.user.userId, dto.workStatus);
  }

  // ✅ 通用：派单/筛选陪玩下拉（避免被 users:page 误伤）
  @Post('players/options')
  async getPlayerOptions(@Body() body: any) {
    return miniOk(await this.usersService.getPlayerOptions(body));
  }

  @Patch('players/:id/work-mode')
  @UseGuards(PermissionsGuard)
  @Permissions('orders:detail:page', 'users:staff:page')
  updatePlayerWorkMode(
      @Param('id', ParseIntPipe) id: number,
      @Body() body: { workMode?: 'ONLINE' | 'OFFLINE' },
  ) {
    return this.usersService.updatePlayerWorkMode(id, (body?.workMode ?? 'ONLINE') as 'ONLINE' | 'OFFLINE');
  }

  // users.controller.ts 里新增一个接口（保持 @UseGuards(JwtAuthGuard) 生效即可）
  @Post('me/password')
  updateMyPassword(@Body() body: { newPassword: string }, @Request() req) {
    return this.usersService.updateMyPassword(req.user.userId, body.newPassword);
  }
}
