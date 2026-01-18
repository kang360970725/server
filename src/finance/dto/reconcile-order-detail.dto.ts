import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class ReconcileOrderDetailDto {
    /** 两者任选其一：优先 orderId */
    @IsOptional()
    @IsNumber()
    @Min(1)
    orderId?: number;

    @IsOptional()
    @IsString()
    autoSerial?: string;
}
