import { esAdmin } from '~/utils/roles'

// Rutas que NO requieren sesión.
const PUBLIC = new Set(['/login'])

// Rutas solo-admin (las demás internas las ven todos los autenticados).
const ADMIN_ONLY = ['/', '/reportes', '/reportes-aux']

export default defineNuxtRouteMiddleware((to) => {
  // En SSR no hay localStorage; con ssr:false esto corre en cliente.
  if (import.meta.server) return

  const { load, isValid, session } = useAuth()
  load()

  const autenticado = isValid()

  // Página pública (login): si ya hay sesión válida, mandar al destino por rol.
  if (PUBLIC.has(to.path)) {
    if (autenticado) {
      return navigateTo(esAdmin(session.value?.user?.role) ? '/' : '/alumnos')
    }
    return
  }

  // Ruta protegida sin sesión válida → login.
  if (!autenticado) {
    return navigateTo('/login')
  }

  // Ruta solo-admin con usuario no-admin → su landing permitido.
  const admin = esAdmin(session.value?.user?.role)
  const esRutaAdmin = ADMIN_ONLY.some(p => to.path === p) || to.path.startsWith('/reportes-aux') || to.path.startsWith('/docentes')
  if (esRutaAdmin && !admin) {
    return navigateTo('/alumnos')
  }
})
