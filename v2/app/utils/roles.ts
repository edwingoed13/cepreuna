// Roles con acceso de administrador (idéntico al backend: requireAdmin).
export const ADMIN_ROLES = ['Administrador', 'Super Admin', 'Oficina de Administración'] as const

export type AdminRole = typeof ADMIN_ROLES[number]

export function esAdmin(role?: string | null): boolean {
  return !!role && (ADMIN_ROLES as readonly string[]).includes(role)
}
