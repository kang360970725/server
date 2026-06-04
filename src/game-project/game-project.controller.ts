import {
    Controller,
    Get,
    Post,
    Body,
    Patch,
    Param,
    Delete,
    ParseIntPipe,
    Put,
    Req,
    UseGuards,
} from '@nestjs/common';
import { GameProjectService } from './game-project.service';
import { CreateGameProjectDto, UpdateGameProjectDto } from './dto/game-project.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';

@Controller('game-project')
@UseGuards(JwtAuthGuard)
export class GameProjectController {
    constructor(private readonly gameProjectService: GameProjectService) {}

    @Post()
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    create(@Body() createGameProjectDto: CreateGameProjectDto) {
        return this.gameProjectService.create(createGameProjectDto);
    }

    // options 通常被多个页面复用（下拉选择），这里我也按“项目管理页”保护
    @Post('options')
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    options(@Body() body: any) {
        return this.gameProjectService.options(body);
    }

    @Post('upload-info')
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    uploadInfo(@Body() body: { filename?: string; scene?: string }) {
        return this.gameProjectService.getUploadInfo(body || {});
    }

    // 商品联动下拉：从菜单项目管理中筛选“商品”分类
    @Post('options/product')
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    productOptions(@Body() body: any) {
        return this.gameProjectService.options({ ...(body || {}), category: '商品' });
    }

    @Get()
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    findAll() {
        return this.gameProjectService.findAll();
    }

    @Post('list')
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    list(@Body() body: any) {
        return this.gameProjectService.list(body || {});
    }

    @Get(':id')
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.gameProjectService.findOne(id);
    }

    @Put(':id')
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    updatePut(
        @Param('id', ParseIntPipe) id: number,
        @Body() updateGameProjectDto: UpdateGameProjectDto,
    ) {
        return this.gameProjectService.update(id, updateGameProjectDto);
    }

    @Patch(':id')
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() updateGameProjectDto: UpdateGameProjectDto,
    ) {
        return this.gameProjectService.update(id, updateGameProjectDto);
    }

    @Delete(':id')
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.gameProjectService.remove(id);
    }

    @Public()
    @Post('public/menu/list')
    publicMenuList(@Body() body: any) {
        return this.gameProjectService.publicMenuList(body || {});
    }

    @Public()
    @Get('public/menu/:id')
    publicMenuDetail(@Param('id', ParseIntPipe) id: number) {
        return this.gameProjectService.publicMenuDetail(id);
    }

    @Get(':id/rating-summary')
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    ratingSummary(@Param('id', ParseIntPipe) id: number) {
        return this.gameProjectService.ratingSummary(id);
    }

    @Post(':id/reviews/list')
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    listReviews(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
        return this.gameProjectService.listReviews({
            projectId: id,
            page: body?.page,
            limit: body?.limit,
            includeHidden: body?.includeHidden,
        });
    }

    @Post('reviews/:reviewId/hide')
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    hideReview(@Req() req: any, @Param('reviewId', ParseIntPipe) reviewId: number, @Body() body: any) {
        const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
        return this.gameProjectService.hideReview(reviewId, {
            hidden: Boolean(body?.hidden),
            reason: body?.reason ? String(body.reason) : undefined,
            operatorId: Number.isFinite(operatorId) ? operatorId : undefined,
        });
    }
}
