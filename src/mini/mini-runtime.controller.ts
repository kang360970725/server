import { Controller, Get, Logger, Req } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { miniOk } from './mini.response';
import { MiniRuntimeService } from './mini-runtime.service';

@Controller('mini')
export class MiniRuntimeController {
  private readonly logger = new Logger(MiniRuntimeController.name);

  constructor(private readonly runtimeService: MiniRuntimeService) {}

  @Public()
  @Get('bootstrap')
  async bootstrap(@Req() req: any) {
    const runtime = req?.miniRuntime || await this.runtimeService.resolve(req?.headers || {});
    this.logger.log(JSON.stringify({
      event: 'mini_bootstrap_resolved',
      appId: runtime.client?.appId || '',
      version: runtime.client?.version || '',
      build: runtime.client?.build || '',
      envVersion: runtime.client?.envVersion || '',
      mode: runtime.mode,
      revision: runtime.revision,
    }));
    return miniOk({
      mode: runtime.mode,
      revision: runtime.revision,
      features: runtime.features,
      serverTime: new Date().toISOString(),
    });
  }
}
