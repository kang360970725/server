import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MINI_FEATURE_KEY } from './mini-feature.decorator';
import { MiniRuntimeService } from './mini-runtime.service';

@Injectable()
export class MiniFeatureGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly runtimeService: MiniRuntimeService) {}

  async canActivate(context: ExecutionContext) {
    const feature = this.reflector.getAllAndOverride<string>(MINI_FEATURE_KEY, [
      context.getHandler(), context.getClass(),
    ]);
    if (!feature) return true;
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const runtime = req.miniRuntime || await this.runtimeService.resolve(req.headers || {});
    req.miniRuntime = runtime;
    res.setHeader('X-Miniapp-Mode', runtime.mode);
    res.setHeader('X-Miniapp-Config-Revision', String(runtime.revision));
    if (runtime.features?.[feature] !== false) return true;
    throw new NotFoundException('该功能当前暂未开放');
  }
}
