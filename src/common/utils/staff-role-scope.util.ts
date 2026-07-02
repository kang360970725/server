export function resolveRoleName(user: any): string {
  return String(user?.roleName || user?.Role?.name || '').trim();
}

export function isStaffUser(user: any): boolean {
  return String(user?.userType || '').trim().toUpperCase() === 'STAFF';
}

export function isDispatchMonitoredStaff(user: any): boolean {
  if (!isStaffUser(user)) return false;

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
