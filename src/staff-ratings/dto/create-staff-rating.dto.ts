import {
    IsString,
    IsNumber,
    IsEnum,
    IsOptional,
    Min,
    Max,
} from 'class-validator';

// 使用与 Prisma Schema 相同的枚举值
export enum RatingScope {
    ONLINE = 'ONLINE',
    OFFLINE = 'OFFLINE',
    BOTH = 'BOTH'
}

export enum RatingStatus {
    ACTIVE = 'ACTIVE',
    INACTIVE = 'INACTIVE'
}

export class CreateStaffRatingDto {
    @IsString()
    name: string;

    @IsString()
    @IsOptional()
    description?: string;

    @IsString()
    rules: string;

    @IsNumber()
    @Min(0)
    @Max(1)
    rate: number;

    @IsEnum(RatingScope)
    scope: RatingScope;

    @IsEnum(RatingStatus)
    @IsOptional()
    status?: RatingStatus;

    @IsNumber()
    @IsOptional()
    sortOrder?: number;
}
