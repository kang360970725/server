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
  Request
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangeLevelDto } from './dto/change-level.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserType } from '@prisma/client';
import {UpdateWorkStatusDto} from "./dto/update-work-status.dto";

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  create(@Body() createUserDto: CreateUserDto, @Request() req) {
    return this.usersService.create(createUserDto, req.user.userId);
  }

  @Get()
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
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  update(
      @Param('id', ParseIntPipe) id: number,
      @Body() updateUserDto: UpdateUserDto,
      @Request() req,
  ) {
    return this.usersService.update(id, updateUserDto, req.user.userId);
  }

  // 新增：获取可用的员工评级列表
  @Get('ratings/available')
  getAvailableRatings() {
    return this.usersService.getAvailableRatings();
  }

  @Patch(':id/level')
  changeLevel(
      @Param('id', ParseIntPipe) id: number,
      @Body() changeLevelDto: ChangeLevelDto,
      @Request() req,
  ) {
    return this.usersService.changeLevel(id, changeLevelDto, req.user.userId);
  }

  @Post(':id/reset-password')
  resetPassword(
      @Param('id', ParseIntPipe) id: number,
      @Body() resetPasswordDto: ResetPasswordDto,
      @Request() req,
  ) {
    return this.usersService.resetPassword(id, resetPasswordDto, req.user.userId);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Request() req) {
    return this.usersService.remove(id, req.user.userId);
  }

  @Post('work-status')
  updateMyWorkStatus(@Body() dto: UpdateWorkStatusDto, @Request() req) {
    return this.usersService.updateMyWorkStatus(req.user.userId, dto.workStatus);
  }

  @Post('players/options')
  getPlayerOptions(@Body() body: any) {
    return this.usersService.getPlayerOptions(body);
  }
}
