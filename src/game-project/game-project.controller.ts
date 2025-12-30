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
    UseGuards,
} from '@nestjs/common';
import { GameProjectService } from './game-project.service';
import { CreateGameProjectDto, UpdateGameProjectDto } from './dto/game-project.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';

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

    @Get()
    @UseGuards(PermissionsGuard)
    @Permissions('system:game-project:page')
    findAll() {
        return this.gameProjectService.findAll();
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
}
