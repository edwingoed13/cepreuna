import { esAdmin } from '~/utils/roles'

export interface SessionUser {
  id?: number
  name?: string
  email?: string
  role?: string
  grupos?: number[] | null
}

export interface Session {
  user: SessionUser
  token: string
}

const STORAGE_KEY = 'stats_session'

// Decodifica el exp del JWT (base64url-safe). Devuelve epoch en segundos o null.
function jwtExp(token: string): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const data = JSON.parse(json)
    return typeof data.exp === 'number' ? data.exp : null
  } catch {
    return null
  }
}

export function useAuth() {
  // useState para compartir la sesión entre componentes durante la vida de la app.
  const session = useState<Session | null>('auth-session', () => null)

  function load(): Session | null {
    if (import.meta.server) return null
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      session.value = raw ? JSON.parse(raw) as Session : null
    } catch {
      session.value = null
    }
    return session.value
  }

  function save(s: Session) {
    session.value = s
    if (import.meta.client) localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  }

  function logout(redirect = true) {
    session.value = null
    if (import.meta.client) localStorage.removeItem(STORAGE_KEY)
    if (redirect) navigateTo('/login')
  }

  function isValid(): boolean {
    const s = session.value ?? load()
    if (!s?.token) return false
    const exp = jwtExp(s.token)
    if (!exp || exp * 1000 < Date.now()) return false
    return true
  }

  const user = computed(() => session.value?.user ?? null)
  const token = computed(() => session.value?.token ?? null)
  const role = computed(() => session.value?.user?.role ?? null)
  const isAdmin = computed(() => esAdmin(session.value?.user?.role))

  return { session, user, token, role, isAdmin, load, save, logout, isValid }
}
