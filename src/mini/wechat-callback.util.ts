import { SystemConfigService } from '../system-config/system-config.service';

function trimUrl(url?: string) {
  return String(url || '').trim().replace(/\/+$/, '');
}

export function getWechatPublicBaseUrl() {
  return trimUrl(
    process.env.APP_PUBLIC_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.WECHAT_PUBLIC_BASE_URL ||
    '',
  );
}

export function getWechatOrderNotifyUrl() {
  const explicit = trimUrl(process.env.WECHAT_PAY_NOTIFY_URL || '');
  if (explicit) return explicit;
  const base = getWechatPublicBaseUrl();
  return base ? `${base}/mini/orders/wechat/notify` : '';
}

export function getWechatRechargeNotifyUrl() {
  const explicit = trimUrl(process.env.WECHAT_PAY_RECHARGE_NOTIFY_URL || '');
  if (explicit) return explicit;
  const base = getWechatPublicBaseUrl();
  return base ? `${base}/mini/member/recharge/wechat/notify` : '';
}

export async function getWechatPublicBaseUrlFromConfig(systemConfigService: SystemConfigService) {
  const configured = trimUrl(await systemConfigService.getString(SystemConfigService.KEYS.APP_PUBLIC_BASE_URL, ''));
  if (configured) return configured;
  return getWechatPublicBaseUrl();
}

export async function getWechatOrderNotifyUrlFromConfig(systemConfigService: SystemConfigService) {
  const configured = trimUrl(await systemConfigService.getString(SystemConfigService.KEYS.WECHAT_PAY_NOTIFY_URL, ''));
  if (configured) return configured;
  const base = await getWechatPublicBaseUrlFromConfig(systemConfigService);
  return base ? `${base}/mini/orders/wechat/notify` : '';
}

export async function getWechatRechargeNotifyUrlFromConfig(systemConfigService: SystemConfigService) {
  const configured = trimUrl(await systemConfigService.getString(SystemConfigService.KEYS.WECHAT_PAY_RECHARGE_NOTIFY_URL, ''));
  if (configured) return configured;
  const base = await getWechatPublicBaseUrlFromConfig(systemConfigService);
  return base ? `${base}/mini/member/recharge/wechat/notify` : '';
}
