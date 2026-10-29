import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { FeedbackService } from './feedback.service';

const FEEDBACK_PAGE = 'service:feedback:page';
const LEGACY_COMPLAINT_PAGE = 'orders:complaints:page';

@Controller('feedback/tickets')
export class FeedbackController {
  constructor(private readonly service: FeedbackService) {}

  @Get()
  @Permissions(FEEDBACK_PAGE, LEGACY_COMPLAINT_PAGE)
  list(@Query() query: any) { return this.service.adminList(query); }

  @Get(':id')
  @Permissions(FEEDBACK_PAGE, LEGACY_COMPLAINT_PAGE)
  detail(@Param('id', ParseIntPipe) id: number) { return this.service.adminDetail(id); }

  @Post(':id/replies')
  @Permissions(FEEDBACK_PAGE, LEGACY_COMPLAINT_PAGE)
  reply(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.service.adminReply(Number(req.user?.id || req.user?.userId || req.user?.sub), id, body);
  }

  @Post(':id/status')
  @Permissions(FEEDBACK_PAGE, LEGACY_COMPLAINT_PAGE)
  status(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.service.adminStatus(Number(req.user?.id || req.user?.userId || req.user?.sub), id, body);
  }
}
