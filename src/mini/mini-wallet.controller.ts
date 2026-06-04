import { Controller, Get, Query, Req } from '@nestjs/common';
import { WalletService } from '../wallet/wallet.service';
import { miniOk } from './mini.response';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

@ApiTags('mini-wallet')
@ApiBearerAuth()
@Controller('mini/wallet')
export class MiniWalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get('account')
  @ApiOperation({ summary: '获取钱包账户' })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: { id: 1, userId: 1, availableBalance: '128.5', frozenBalance: '20.0' },
      },
    },
  })
  async account(@Req() req: any) {
    const userId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);
    const data = await this.walletService.getOrCreateMyAccount(userId);
    return miniOk(data);
  }

  @Get('transactions')
  @ApiOperation({ summary: '获取钱包流水' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: { data: [], total: 0, page: 1, limit: 20, totalPages: 0 },
      },
    },
  })
  async transactions(@Req() req: any, @Query() query: any) {
    const userId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);
    const data = await this.walletService.listMyTransactions(userId, query || {});
    return miniOk(data);
  }
}
