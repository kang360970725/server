import {BadRequestException, Body, Controller, Post} from '@nestjs/common';
import * as crypto from 'crypto';
import {SystemConfigService} from '../system-config/system-config.service';

@Controller('uploads')
export class CommonUploadController {
    constructor(private readonly systemConfigService: SystemConfigService) {
    }

    private readonly allowedModules = new Set([
        'game-project',
        'goods-category',
        'miniapp-home',
        'miniapp-customer-service',
        'announcement',
        'miniapp-protocol',
        'penalties',
        'general',
    ]);

    private readonly allowedScenes = new Set(['cover', 'rich', 'image', 'file', 'avatar']);

    @Post('info')
    async getUploadInfo(
        @Body()
        body: {
            module?: string;
            scene?: string;
            filename?: string;
        },
    ) {
        try {
            const cosConfig = await this.systemConfigService.getCosUploadConfig();
            const secretId = String(cosConfig.secretId || '').trim();
            const secretKey = String(cosConfig.secretKey || '').trim();
            const bucket = String(cosConfig.bucket || '').trim();
            const region = String(cosConfig.region || '').trim();
            const cdnDomain = String(cosConfig.cdnDomain || '').trim();
            const signExpireSeconds = 1800;

            if (!secretId || !secretKey || !bucket || !region) {
                throw new BadRequestException(
                    '缺少 COS 配置：COS_SECRET_ID/COS_SECRET_KEY/COS_BUCKET/COS_REGION',
                );
            }

            const moduleKey = String(body?.module || 'general').trim();
            const scene = String(body?.scene || 'file').trim();

            if (!this.allowedModules.has(moduleKey)) {
                throw new BadRequestException(`不支持的上传模块：${moduleKey}`);
            }
            if (!this.allowedScenes.has(scene)) {
                throw new BadRequestException(`不支持的上传场景：${scene}`);
            }

            const rawName = String(body?.filename || 'file').trim();
            const safeName = rawName.replace(/[^\w.\-]/g, '_').slice(-80) || 'file';
            const ext = safeName.includes('.') ? safeName.split('.').pop() : 'bin';
            const date = new Date();
            const y = date.getFullYear();
            const m = `${date.getMonth() + 1}`.padStart(2, '0');
            const d = `${date.getDate()}`.padStart(2, '0');
            const stamp = Date.now();
            const random = Math.random().toString(36).slice(2, 8);
            const cloudPath = `uploads/${moduleKey}/${scene}/${y}${m}${d}/${stamp}-${random}.${ext}`;

            const cosHost = `${bucket}.cos.${region}.myqcloud.com`;
            const encodedPath = `/${cloudPath
                .split('/')
                .map((seg) => encodeURIComponent(seg))
                .join('/')}`;
            const uploadUrl = `https://${cosHost}${encodedPath}`;
            const fileUrl = cdnDomain
                ? `https://${cdnDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/${cloudPath}`
                : uploadUrl;

            const now = Math.floor(Date.now() / 1000);
            const signStart = now - 60;
            const signEnd = now + signExpireSeconds;

            const signSource = 'manual';
            const keyTime = `${signStart};${signEnd}`;
            const signKey = crypto.createHmac('sha1', secretKey).update(keyTime).digest('hex');
            const httpString = `put\n${encodedPath}\n\nhost=${cosHost}\n`;
            const sha1HttpString = crypto.createHash('sha1').update(httpString).digest('hex');
            const stringToSign = `sha1\n${keyTime}\n${sha1HttpString}\n`;
            const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
            const authorization = [
                'q-sign-algorithm=sha1',
                `q-ak=${secretId}`,
                `q-sign-time=${keyTime}`,
                `q-key-time=${keyTime}`,
                'q-header-list=host',
                'q-url-param-list=',
                `q-signature=${signature}`,
            ].join('&');

            console.log('[uploads/info] success', {
                module: moduleKey,
                scene,
                fileName: rawName,
                cloudPath,
                bucket,
                region,
                signSource,
                expiredTime: signEnd,
            });

            return {
                mode: 'signature',
                module: moduleKey,
                scene,
                cloudPath,
                bucket,
                region,
                uploadUrl,
                fileUrl,
                authorization,
                expiredTime: signEnd,
            };
        } catch (e: any) {
            console.error('[uploads/info] failed', {
                message: e?.message,
                stack: e?.stack,
                body: {
                    module: body?.module,
                    scene: body?.scene,
                    filename: body?.filename,
                },
            });
            throw e;
        }
    }
}
