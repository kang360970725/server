import { IsPhoneNumber, IsString, MinLength, IsOptional } from 'class-validator';

export class RegisterDto {
  @IsPhoneNumber('CN')
  phone: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsString()
  @IsOptional()
  name?: string;
}
