export type AdminAuthPayload = {
  member?: { roles?: string[] };
};

export function isAdmin(payload: AdminAuthPayload, adminRoleId: string): boolean {
  if (!adminRoleId) return false;
  const roles = payload.member?.roles ?? [];
  return roles.includes(adminRoleId);
}
