import { IsBoolean, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

export const MINIAPP_PROTOCOL_KEYS = [
  'platform_user_service_agreement',
  'member_service_agreement',
  'privacy_policy_cookie',
  'minor_protection_rules',
  'order_service_agreement',
  'after_sales_service_agreement',
  'wallet_service_agreement',
  'recharge_service_agreement',
  'passwordless_payment_authorization',
  'merchant_entry_cooperation_agreement',
  'merchant_settlement_agreement',
  'merchant_deposit_agreement',
  'product_service_publish_rules',
  'platform_advertising_cooperation_agreement',
  'revenue_sharing_service_agreement',
  'third_party_payment_cooperation_agreement',
  'electronic_signature_usage_agreement',
  'marketing_activity_cooperation_agreement',
] as const;

export type MiniappProtocolKey = string;

export class UpsertMiniappProtocolDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  id?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  originalKey?: string;

  @IsString()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: '协议键仅支持字母、数字、下划线、中划线' })
  key: string;

  @IsInt()
  @Min(1)
  categoryId: number;

  @IsString()
  @MaxLength(120)
  title: string;

  @IsString()
  content: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  coverImage?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort?: number;
}
