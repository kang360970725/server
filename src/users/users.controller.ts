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

  private assertButtonPermission(req: any, key: string, message = '当前角色无权执行该操作') {
    const user = req?.user || {};
    const permissions = Array.isArray(user?.permissions) ? user.permissions : [];
    const roleName = String(user?.roleName || '').trim().toUpperCase();
    if (user?.userType === UserType.SUPER_ADMIN || roleName === 'SUPER_ADMIN' || permissions.includes(key)) {
      return;
    }
    throw new ForbiddenException(message);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @Permissions('users:member:create:button', 'users:staff:create:button', 'users:internal:create:button')
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
  @Permissions('users:staff:wallet-stats:button')
  getStaffWalletStatistics(@Request() req) {
    this.assertButtonPermission(req, 'users:staff:wallet-stats:button', '当前角色无权查看员工资金统计');
    return this.usersService.getStaffWalletStatistics();
  }

  // 管理端用：获取可用评级。必须放在 :id 路由前，避免 ratings 被解析为用户 ID。
  @Get('ratings/available')
  @UseGuards(PermissionsGuard)
  @Permissions(
      ...UsersController.userManagePermissions,
      'users:staff:create:button',
      'users:staff:edit:button',
      'users:staff:change-level:button',
      'staff-ratings:page',
  )
  getAvailableRatings() {
    return this.usersService.getAvailableRatings();
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
  @Permissions('users:member:game-card:button')
  createMemberGameCard(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Request() req: any) {
    this.assertButtonPermission(req, 'users:member:game-card:button', '当前角色无权维护会员游戏名片');
    return this.memberService.createAdminGameCard(id, body || {});
  }

  @Post(':id/member-game-cards/:cardId/set-primary')
  @UseGuards(PermissionsGuard)
  @Permissions('users:member:game-card:button')
  setMemberGameCardPrimary(
      @Param('id', ParseIntPipe) id: number,
      @Param('cardId', ParseIntPipe) cardId: number,
      @Request() req: any,
  ) {
    this.assertButtonPermission(req, 'users:member:game-card:button', '当前角色无权维护会员游戏名片');
    return this.memberService.setAdminGameCardPrimary(id, cardId);
  }

  @Delete(':id/member-game-cards/:cardId')
  @UseGuards(PermissionsGuard)
  @Permissions('users:member:game-card:button')
  deleteMemberGameCard(
      @Param('id', ParseIntPipe) id: number,
      @Param('cardId', ParseIntPipe) cardId: number,
      @Request() req: any,
  ) {
    this.assertButtonPermission(req, 'users:member:game-card:button', '当前角色无权维护会员游戏名片');
    return this.memberService.deleteAdminGameCard(id, cardId);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @Permissions(
      'users:member:edit:button',
      'users:staff:edit:button',
      'users:internal:edit:button',
      'users:staff:assign-role:button',
      'users:internal:assign-role:button',
  )
  update(
      @Param('id', ParseIntPipe) id: number,
      @Body() updateUserDto: UpdateUserDto,
      @Request() req,
  ) {
    return this.usersService.update(id, updateUserDto, req.user.userId, req.user);
  }

  @Post(':id/withdraw-qr-code/reset')
  @UseGuards(PermissionsGuard)
  @Permissions('users:staff:withdraw-qr-reset:button')
  resetWithdrawQrCode(
      @Param('id', ParseIntPipe) id: number,
      @Body() body: { remark?: string },
      @Request() req,
  ) {
    return this.usersService.resetWithdrawQrCode(id, req.user.userId, req.user, body?.remark);
  }

  @Post(':id/staff-exit')
  @UseGuards(PermissionsGuard)
  @Permissions('users:staff:exit:button')
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
  @Permissions('users:staff:clear:button')
  staffClear(
      @Param('id', ParseIntPipe) id: number,
      @Body() dto: StaffClearDto,
      @Request() req,
  ) {
    return this.usersService.clearStaffAssets(id, dto, req.user.userId, req.user);
  }

  @Patch(':id/level')
  @UseGuards(PermissionsGuard)
  @Permissions('users:staff:change-level:button')
  changeLevel(
      @Param('id', ParseIntPipe) id: number,
      @Body() changeLevelDto: ChangeLevelDto,
      @Request() req,
  ) {
    return this.usersService.changeLevel(id, changeLevelDto, req.user.userId, req.user);
  }

  @Post(':id/reset-password')
  @UseGuards(PermissionsGuard)
  @Permissions('users:staff:reset-password:button', 'users:internal:reset-password:button')
  resetPassword(
      @Param('id', ParseIntPipe) id: number,
      @Body() resetPasswordDto: ResetPasswordDto,
      @Request() req,
  ) {
    return this.usersService.resetPassword(id, resetPasswordDto, req.user.userId, req.user);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @Permissions('users:member:delete:button', 'users:staff:delete:button', 'users:internal:delete:button')
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
  @Permissions('orders:detail:page', 'users:staff:page', 'service:online-board:page', 'orders:workbench:page')
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
