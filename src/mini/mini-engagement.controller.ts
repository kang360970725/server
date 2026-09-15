import {Body, Controller, Get, Param, ParseIntPipe, Post, Req} from '@nestjs/common';
import {miniOk} from './mini.response';
import {MiniEngagementService} from './mini-engagement.service';

@Controller('mini/engagement')
export class MiniEngagementController {
  constructor(private readonly service: MiniEngagementService) {}
  private userId(req: any) { return Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub); }

  @Get('dashboard') dashboard(@Req() req: any) { return this.service.dashboard(this.userId(req)).then((x) => miniOk(x)); }
  @Post('checkin') checkin(@Req() req: any) { return this.service.checkin(this.userId(req)).then((x) => miniOk(x, '签到成功')); }
  @Post('projects/:id/view') view(@Req() req: any, @Param('id', ParseIntPipe) id: number) { return this.service.recordView(this.userId(req), id).then((x) => miniOk(x)); }
  @Get('projects/:id/favorite') favoriteState(@Req() req: any, @Param('id', ParseIntPipe) id: number) { return this.service.favoriteState(this.userId(req), id).then((x) => miniOk(x)); }
  @Post('projects/:id/favorite') toggleFavorite(@Req() req: any, @Param('id', ParseIntPipe) id: number) { return this.service.toggleFavorite(this.userId(req), id).then((x) => miniOk(x)); }
  @Get('favorites') favorites(@Req() req: any) { return this.service.favorites(this.userId(req)).then((x) => miniOk(x)); }
  @Get('staff-card/me') myStaffCard(@Req() req:any){return this.service.myStaffCard(this.userId(req)).then((x)=>miniOk(x));}
  @Post('staff-card/me') saveStaffCard(@Req() req:any,@Body() body:any){return this.service.saveMyStaffCard(this.userId(req),body).then((x)=>miniOk(x,'名片已保存'));}
  @Get('staff-cards') staffCards(){return this.service.approvedStaffCards().then((x)=>miniOk(x));}
}
