import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { BizForbiddenException } from '../exceptions/biz-forbidden.exception';

@Injectable()
export class UserStatusGuard implements CanActivate {
    // ✅ 冻结用户允许访问的接口前缀
    private readonly frozenAllowPrefix = [
        '/wallet/account',
        '/wallet/transactions',
        '/wallet/holds',
        '/wallet/withdraw/qr-code',
        '/wallet/withdraw/qr-code-url',
        '/wallet/withdrawals/apply',
        '/wallet/withdrawals/mine',
        '/wallet',
        '/wallet-withdrawals',
        '/auth/logout',
        '/auth/me',
        '/meta/enums',
    ];

    canActivate(ctx: ExecutionContext) {
        const req = ctx.switchToHttp().getRequest();
        const user = req.user as { status?: UserStatus };

        if (!user?.status) return true;

        // 禁用：即使 token 还在，也禁止一切访问
        if (user.status === UserStatus.DISABLED) {
            throw new BizForbiddenException(
                'ACCOUNT_DISABLED',
                '账号已禁用，请联系管理员',
            );
        }

        // 冻结：只能访问钱包
        if (user.status === UserStatus.FROZEN) {
            const path = req.path || req.url || '';
            const ok = this.frozenAllowPrefix.some(p => path.startsWith(p));
            if (!ok) {
                throw new BizForbiddenException(
                    'ACCOUNT_FROZEN',
                    '账号已冻结，仅可使用钱包相关功能',
                );
            }
        }

        return true;
    }
}
