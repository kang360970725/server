import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { MiniRuntimeService } from './mini-runtime.service';

@Injectable()
export class MiniRuntimeInterceptor implements NestInterceptor {
  constructor(private readonly runtimeService: MiniRuntimeService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const isMiniClient = Boolean(req?.headers?.['x-miniapp-version'] || String(req?.url || '').startsWith('/mini/'));
    if (!isMiniClient) return next.handle();

    return from(req.miniRuntime ? Promise.resolve(req.miniRuntime) : this.runtimeService.resolve(req.headers || {})).pipe(
      mergeMap((runtime) => {
        req.miniRuntime = runtime;
        res.setHeader('X-Miniapp-Mode', runtime.mode);
        res.setHeader('X-Miniapp-Config-Revision', String(runtime.revision));
        return next.handle();
      }),
    );
  }
}
