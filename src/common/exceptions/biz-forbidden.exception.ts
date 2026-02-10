import { ForbiddenException } from '@nestjs/common';

export class BizForbiddenException extends ForbiddenException {
    constructor(code: string, message: string) {
        super({
            statusCode: 403,
            code,
            message,
        });
    }
}
