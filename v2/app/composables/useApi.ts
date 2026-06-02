// Wrapper de $fetch con Bearer token. 401 → logout; 403 → toast "sin permisos".
export function useApi() {
  const { token, logout } = useAuth()
  const config = useRuntimeConfig()
  const toast = useToast()

  const base = config.public.apiBase || '' // '' en dev (devProxy), origen del backend en prod

  async function api<T = unknown>(path: string, opts: Parameters<typeof $fetch>[1] = {}): Promise<T> {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined) }
    if (token.value) headers.Authorization = `Bearer ${token.value}`

    try {
      return await $fetch<T>(base + path, { ...opts, headers })
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status
      if (status === 401) {
        logout()
      } else if (status === 403) {
        toast.add({ title: 'Sin permisos', description: 'No tienes acceso a este recurso.', color: 'error' })
      }
      throw err
    }
  }

  // Descarga un archivo (Excel) con el Bearer token y dispara el guardado en el navegador.
  async function descargar(path: string, fallbackName = 'archivo.xlsx') {
    const headers: Record<string, string> = {}
    if (token.value) headers.Authorization = `Bearer ${token.value}`
    const res = await fetch(base + path, { headers })
    if (!res.ok) {
      if (res.status === 401) logout()
      throw new Error('HTTP ' + res.status)
    }
    const cd = res.headers.get('content-disposition') || ''
    const m = cd.match(/filename="?([^";]+)"?/)
    const filename = m?.[1] || fallbackName
    const blob = await res.blob()
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }

  return { api, descargar }
}
