import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

export class SendTestRealtimeNotificationDto {
  @IsOptional()
  @IsIn(['STAFF', 'CUSTOMER_SERVICE', 'BOTH'])
  targetRole?: 'STAFF' | 'CUSTOMER_SERVICE' | 'BOTH';

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  targetUserIds?: number[];

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsIn(['DISPATCH_ASSIGNED', 'DISPATCH_ARCHIVED', 'DISPATCH_COMPLETED', 'SYSTEM_ANNOUNCEMENT', 'CS_DUTY_SUBSTITUTION', 'CUSTOM'])
  mockType?: 'DISPATCH_ASSIGNED' | 'DISPATCH_ARCHIVED' | 'DISPATCH_COMPLETED' | 'SYSTEM_ANNOUNCEMENT' | 'CS_DUTY_SUBSTITUTION' | 'CUSTOM';
}
