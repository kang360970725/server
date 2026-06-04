import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { miniOk } from './mini.response';

@ApiTags('mini-announcements')
@Controller('mini/announcements')
export class MiniAnnouncementsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get(':id')
  @Public()
  @ApiOperation({ summary: '获取小程序可见公告详情' })
  @ApiParam({ name: 'id', example: 1 })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: { id: 1, title: '公告标题', content: '<p>公告内容</p>', audience: 'APPLET' },
      },
    },
  })
  async detail(@Param('id', ParseIntPipe) id: number) {
    const data = await this.notificationsService.getMiniappAnnouncementDetail(id);
    return miniOk(data);
  }
}
