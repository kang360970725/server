import {
    Controller,
    Get,
    Post,
    Body,
    Patch,
    Param,
    Delete,
    Query,
    UseGuards,
    ParseIntPipe,
} from '@nestjs/common';
import { StaffRatingsService } from './staff-ratings.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateStaffRatingDto, RatingStatus } from './dto/create-staff-rating.dto';
import { UpdateStaffRatingDto } from './dto/update-staff-rating.dto';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';

@Controller('staff-ratings')
@UseGuards(JwtAuthGuard)
export class StaffRatingsController {
    constructor(private readonly staffRatingsService: StaffRatingsService) {}

    @Post()
    @UseGuards(PermissionsGuard)
    @Permissions('staff-ratings:page')
    create(@Body() createStaffRatingDto: CreateStaffRatingDto) {
        return this.staffRatingsService.create(createStaffRatingDto);
    }

    @Get()
    @UseGuards(PermissionsGuard)
    @Permissions('staff-ratings:page')
    findAll(
        @Query('current', ParseIntPipe) current: number = 1,
        @Query('pageSize', ParseIntPipe) pageSize: number = 10,
        @Query('name') name?: string,
        @Query('status') status?: RatingStatus,
    ) {
        return this.staffRatingsService.findAll({
            page: Number(current),
            pageSize: Number(pageSize),
            name,
            status,
        });
    }

    @Get(':id')
    @UseGuards(PermissionsGuard)
    @Permissions('staff-ratings:page')
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.staffRatingsService.findOne(id);
    }

    @Patch(':id')
    @UseGuards(PermissionsGuard)
    @Permissions('staff-ratings:page')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() updateStaffRatingDto: UpdateStaffRatingDto,
    ) {
        return this.staffRatingsService.update(id, updateStaffRatingDto);
    }

    @Delete(':id')
    @UseGuards(PermissionsGuard)
    @Permissions('staff-ratings:page')
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.staffRatingsService.remove(id);
    }
}
