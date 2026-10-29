import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { miniOk } from '../mini/mini.response';
import { FeedbackService } from './feedback.service';

@Controller('mini/feedback')
export class MiniFeedbackController {
  constructor(private readonly service: FeedbackService) {}
  private uid(req: any) { return Number(req.user?.id || req.user?.userId || req.user?.sub); }

  @Post()
  async create(@Req() req: any, @Body() body: any) { return miniOk(await this.service.create(this.uid(req), body)); }
  @Get()
  async list(@Req() req: any, @Query() query: any) { return miniOk(await this.service.listMine(this.uid(req), query)); }
  @Get(':id')
  async detail(@Req() req: any, @Param('id', ParseIntPipe) id: number) { return miniOk(await this.service.detailMine(this.uid(req), id)); }
  @Post(':id/replies')
  async reply(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) { return miniOk(await this.service.replyMine(this.uid(req), id, body)); }
}
