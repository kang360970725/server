import {Body, Controller, Get, Param, ParseIntPipe, Patch, Query, Req} from '@nestjs/common';
import {Permissions} from '../auth/decorators/permissions.decorator';
import {MiniEngagementService} from './mini-engagement.service';

@Controller('member/engagement')
export class MemberEngagementAdminController {
  constructor(private readonly service:MiniEngagementService){}
  private userId(req:any){return Number(req?.user?.userId??req?.user?.id??req?.user?.sub);}
  @Get('staff-card/me') mine(@Req() req:any){return this.service.myStaffCard(this.userId(req));}
  @Patch('staff-card/me') updateMine(@Req() req:any,@Body() body:any){return this.service.saveMyStaffCard(this.userId(req),body);}
  @Permissions('users:staff:page')
  @Get('staff-cards') list(@Query('status') status?:string){return this.service.adminStaffCards(status);}
  @Permissions('users:staff:page')
  @Patch('staff-cards/:id') update(@Param('id',ParseIntPipe) id:number,@Body() body:any){return this.service.adminUpdateStaffCard(id,body);}
  @Permissions('users:staff:page')
  @Patch('staff-cards/:id/review') review(@Req() req:any,@Param('id',ParseIntPipe) id:number,@Body() body:any){return this.service.reviewStaffCard(id,body,Number(req?.user?.userId||0));}
}
