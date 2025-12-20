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

@Controller('staff-ratings')
@UseGuards(JwtAuthGuard)
export class StaffRatingsController {
    constructor(private readonly staffRatingsService: StaffRatingsService) {}

    @Post()
    create(@Body() createStaffRatingDto: CreateStaffRatingDto) {
        return this.staffRatingsService.create(createStaffRatingDto);
    }

    @Get()
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
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.staffRatingsService.findOne(id);
    }

    @Patch(':id')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() updateStaffRatingDto: UpdateStaffRatingDto,
    ) {
        return this.staffRatingsService.update(id, updateStaffRatingDto);
    }

    @Delete(':id')
    remove(@Param('id', ParseIntPipe) id: number) {
        return this.staffRatingsService.remove(id);
    }
}
