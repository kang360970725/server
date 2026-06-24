export function resolveRoleName(user: any): string {
  return String(user?.roleName || user?.Role?.name || '').trim();
}

export function isDispatchMonitoredStaff(user: any): boolean {
  const userType = String(user?.userType || '').trim().toUpperCase();
  if (userType !== 'STAFF') return false;

  const roleName = resolveRoleName(user).toUpperCase();
  if (!roleName) return true;

  const exemptRoleNames = [
    'FINANCE_ADMIN',
    'CS_MANAGER',
  ];
  if (exemptRoleNames.includes(roleName)) return false;

  const exemptKeywords = [
    'SUPER',
    'ADMIN',
    '客服',
    'CS',
    '运营',
    'OPERATION',
    '财务',
    'FINANCE',
  ];
  return !exemptKeywords.some((keyword) => roleName.includes(keyword));
}
