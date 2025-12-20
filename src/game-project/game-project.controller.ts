import { Controller, Get, Post, Body, Patch, Param, Delete, Query, ParseIntPipe, Put} from '@nestjs/common';
import { GameProjectService } from './game-project.service';
import { CreateGameProjectDto } from './dto/game-project.dto';
import { UpdateGameProjectDto } from './dto/game-project.dto';

@Controller('game-project')
export class GameProjectController {
    constructor(private readonly gameProjectService: GameProjectService) {}

    @Post()
    create(@Body() createGameProjectDto: CreateGameProjectDto) {
        return this.gameProjectService.create(createGameProjectDto);
    }

    @Get()
    findAll() {
        return this.gameProjectService.findAll();
    }

    @Get(':id')
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.gameProjectService.findOne(id);
    }

    // 添加 PUT 方法
    @Put(':id')
    updatePut(
        @Param('id', ParseIntPipe) id: number,
        @Body() updateGameProjectDto: UpdateGameProjectDto,
    ) {
        return this.gameProjectService.update(id, updateGameProjectDto);
    }

    @Patch(':id')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() updateGameProjectDto: UpdateGameProjectDto,
    ) {
        return this.gameProjectService.update(id, updateGameProjectDto);
    }

    @Delete(':id')
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.gameProjectService.remove(id);
    }
}
