// src/common/cloudbase.storage.ts
import axios from 'axios';
import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';

const ENV_ID = process.env.TCB_ENV_ID || 'prod-1g23nvkf9b94d870';
const SECRET_ID = process.env.TCB_SECRET_ID || '';
const SECRET_KEY = process.env.TCB_SECRET_KEY || '';

// ===== token cache（内存）=====
let cachedAccessToken: string | null = null;
let cachedExpireAtMs = 0;

function assertSecret() {
    if (!SECRET_ID || !SECRET_KEY) {
        throw new BadRequestException('缺少云开发密钥：请配置环境变量 TCB_SECRET_ID / TCB_SECRET_KEY');
    }
}

function sha256Hex(s: string) {
    return crypto.createHash('sha256').update(s).digest('hex');
}

function hmacSha256(key: Buffer | string, msg: string) {
    return crypto.createHmac('sha256', key).update(msg).digest();
}

/**
 * CloudBase HTTP API 网关域名（env 维度）
 */
function gatewayBase() {
    return `https://${ENV_ID}.api.tcloudbasegateway.com`;
}

/**
 * token 域名（env + region 维度）
 * 你 bucket 是 ap-shanghai，所以这里固定 ap-shanghai（如后续报 region 不对，再按错误调整）
 */
function tokenHost() {
    return `${ENV_ID}.ap-shanghai.tcb-api.tencentcloudapi.com`;
}

/**
 * 构建 CloudBase token 接口所需的 TC3 Authorization
 * 文档：POST /auth/v1/token/clientCredential
 * Body: {"grant_type":"client_credentials"}
 * Header: Authorization: TC3-HMAC-SHA256 ...
 */
function buildTC3AuthForToken(params: {
    host: string; // <envId>.ap-shanghai.tcb-api.tencentcloudapi.com
    path: string; // /auth/v1/token/clientCredential
    payload: any; // {"grant_type":"client_credentials"}
    contentType: string; // application/json
}) {
    assertSecret();

    const { host, path, payload, contentType } = params;

    const algorithm = 'TC3-HMAC-SHA256';
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // YYYY-MM-DD

    // canonical request
    const signedHeaders = 'content-type;host';
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
    const hashedPayload = sha256Hex(JSON.stringify(payload));

    const canonicalRequest = [
        'POST',
        path,
        '',
        canonicalHeaders,
        signedHeaders,
        hashedPayload,
    ].join('\n');

    const service = 'tcb';
    const credentialScope = `${date}/${service}/tc3_request`;
    const stringToSign = [
        algorithm,
        `${timestamp}`,
        credentialScope,
        sha256Hex(canonicalRequest),
    ].join('\n');

    // signature
    const secretDate = hmacSha256(`TC3${SECRET_KEY}`, date);
    const secretService = hmacSha256(secretDate, service);
    const secretSigning = hmacSha256(secretService, 'tc3_request');
    const signature = crypto
        .createHmac('sha256', secretSigning)
        .update(stringToSign)
        .digest('hex');

    const authorization =
        `${algorithm} ` +
        `Credential=${SECRET_ID}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, ` +
        `Signature=${signature}`;

    return { authorization };
}

/**
 * 获取服务端 AccessToken（clientCredential）
 * - 使用 TC3-HMAC-SHA256 签名（Secret 不进 body）
 * - 缓存 token
 */
async function getServerAccessToken(): Promise<string> {
    assertSecret();

    const now = Date.now();
    if (cachedAccessToken && now < cachedExpireAtMs - 60_000) {
        return cachedAccessToken;
    }

    const host = tokenHost(); // `${ENV_ID}.ap-shanghai.tcb-api.tencentcloudapi.com`
    const path = `/auth/v1/token/clientCredential`;
    const url = `https://${host}${path}`;

    // 文档要求：grant_type 固定 client_credentials
    const payload = { grant_type: 'client_credentials' };

    // ✅ Basic base64(SecretId:SecretKey)
    const basic = Buffer.from(`${SECRET_ID}:${SECRET_KEY}`).toString('base64');

    let res: any;
    try {
        res = await axios.post(url, payload, {
            headers: {
                Host: host,
                'Content-Type': 'application/json',
                Authorization: `Basic ${basic}`,
            },
        });
    } catch (e: any) {
        // 把服务端返回内容抛出来（别再打印 secret）
        const data = e?.response?.data;
        const msg =
            data?.message ||
            data?.error_description ||
            data?.error ||
            e?.message ||
            '获取 CloudBase AccessToken 失败';
        throw new BadRequestException(msg);
    }

    const accessToken = res?.data?.access_token;
    const tokenType = res?.data?.token_type;
    const expiresIn = Number(res?.data?.expires_in || 432000); // 文档示例 5 天 :contentReference[oaicite:1]{index=1}

    if (!accessToken || String(tokenType).toLowerCase() !== 'bearer') {
        // 把原始响应带上，方便你定位（不包含 secret）
        throw new BadRequestException(
            `获取 CloudBase AccessToken 失败（响应异常）：${JSON.stringify(res?.data || {})}`,
        );
    }

    cachedAccessToken = accessToken;
    cachedExpireAtMs = now + expiresIn * 1000;

    return accessToken;
}


/**
 * 调用 CloudBase HTTP API 网关
 * - Authorization: Bearer <access_token>
 */
async function postStorageApi<T>(path: string, body: any): Promise<T> {
    const token = await getServerAccessToken();
    const url = `${gatewayBase()}${path}`;

    try {
        const res = await axios.post(url, body, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
        });
        return res.data as T;
    } catch (e: any) {
        const data = e?.response?.data;
        const msg = data?.message || data?.error || e?.message || 'CloudBase API 调用失败';
        throw new BadRequestException(msg);
    }
}

/**
 * 上传：先拿 upload info，再 PUT 到 COS
 * HTTP API：/v1/storages/get-objects-upload-info
 */
export async function tcbUploadFile(params: { cloudPath: string; fileContent: Buffer }) {
    const { cloudPath, fileContent } = params;
    if (!cloudPath) throw new BadRequestException('cloudPath 不能为空');
    if (!fileContent?.length) throw new BadRequestException('fileContent 不能为空');

    const arr = await postStorageApi<
        Array<{
            objectId: string;
            uploadUrl?: string;
            authorization?: string;
            token?: string;
            cloudObjectMeta?: string;
            code?: string;
            message?: string;
            cloudObjectId?: string;
            downloadUrl?: string;
            downloadUrlEncoded?: string;
        }>
        >('/v1/storages/get-objects-upload-info', [{ objectId: cloudPath }]);

    const item = Array.isArray(arr) ? arr[0] : null;
    // ⚠️ 只打印安全字段，千万不要打印 authorization / token
    console.log('[CloudBase][UploadInfo]', {
        objectId: item?.objectId,
        cloudObjectId: item?.cloudObjectId,
        hasUploadUrl: Boolean(item?.uploadUrl),
        hasAuthorization: Boolean(item?.authorization),
        hasToken: Boolean(item?.token),
        cloudObjectMeta: item?.cloudObjectMeta,
        downloadUrl: item?.downloadUrl,
        downloadUrlEncoded: item?.downloadUrlEncoded,
    });
    if (!item) throw new BadRequestException('获取上传信息失败（空响应）');
    if ((item as any).code) {
        throw new BadRequestException(`获取上传信息失败：${(item as any).code} ${(item as any).message || ''}`);
    }

    const uploadUrl = item.uploadUrl;
    const authorization = item.authorization;
    const token = item.token;
    const meta = item.cloudObjectMeta;

    if (!uploadUrl || !authorization) {
        throw new BadRequestException('获取上传信息失败（缺少 uploadUrl/authorization）');
    }
    if (!meta) {
        throw new BadRequestException('获取上传信息失败（缺少 cloudObjectMeta）');
    }

    // ✅ 关键：严格按 CloudBase 文档要求的 header 上传
    // - Authorization
    // - X-Cos-Security-Token
    // - X-Cos-Meta-Fileid
    // 且不要乱加 Content-Type（可能影响签名）
    await axios.put(uploadUrl, fileContent, {
        headers: {
            Authorization: authorization,
            ...(token ? { 'X-Cos-Security-Token': token } : {}),
            'X-Cos-Meta-Fileid': meta,
        },
        maxBodyLength: Infinity,
    });

    return {
        cloudPath,
        cloudObjectId: item.cloudObjectId || null,
        downloadUrl: item.downloadUrl || null,
        downloadUrlEncoded: item.downloadUrlEncoded || null,
    };
}

/**
 * 获取临时下载链接：/v1/storages/get-objects-download-info
 */
export async function tcbGetTempFileURL(params: { cloudPath: string; maxAgeSeconds: number }) {
    const { cloudPath, maxAgeSeconds } = params;
    if (!cloudPath) return null;

    const arr = await postStorageApi<
        Array<{
            cloudObjectId?: string;
            downloadUrl?: string;
            code?: string;
            message?: string;
        }>
        >('/v1/storages/get-objects-download-info', [
        {
            // 这里用 cloudPath 作为对象标识；如平台要求 cloudObjectId，后续根据报错再改
            cloudObjectId: cloudPath,
            maxAge: maxAgeSeconds,
        },
    ]);

    const item = Array.isArray(arr) ? arr[0] : null;
    if (!item) return null;
    if ((item as any).code) {
        throw new BadRequestException(`获取下载链接失败：${(item as any).code} ${(item as any).message || ''}`);
    }

    return item.downloadUrl || null;
}
