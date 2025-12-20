import { PartialType } from '@nestjs/mapped-types';
import { CreateStaffRatingDto } from './create-staff-rating.dto';

export class UpdateStaffRatingDto extends PartialType(CreateStaffRatingDto) {}
