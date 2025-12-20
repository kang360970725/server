import { IsPhoneNumber, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsPhoneNumber('CN')
  phone: string;

  @IsString()
  @MinLength(6)
  password: string;
}
