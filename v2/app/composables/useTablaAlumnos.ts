import type { Ref } from 'vue'

export interface GrupoDerivado {
  id: number | string
  label: string
  sede: string
  count: number
}

interface RegistroBase {
  grupo_aulas_id?: number | string | null
  grupo?: string | null
  area?: string | null
  turno?: string | null
  sede?: string | null
  sede_aula?: string | null
}

interface Opts<T> {
  // Predicado extra de filtrado (búsqueda DNI client-side, estado, etc.).
  extraFilter?: (r: T) => boolean
  // Accesores de orden por columna (clave → valor comparable).
  sortAccessors?: Record<string, (r: T) => string | number>
}

// Lógica compartida por Alumnos (pagos) y Alumnos-Calificación: deriva los
// grupos para el panel, filtra por grupo seleccionado, ordena y pagina.
export function useTablaAlumnos<T extends RegistroBase>(registros: Ref<T[]>, opts: Opts<T> = {}) {
  const gruposSel = ref<Set<string>>(new Set())
  const busquedaGrupo = ref('')
  const sortBy = ref<string>('')
  const sortDir = ref<'asc' | 'desc'>('asc')
  const page = ref(1)
  const pageSize = ref(50)

  // Grupos para el panel (de grupo_aulas_id).
  const gruposDerivados = computed<GrupoDerivado[]>(() => {
    const map = new Map<string, GrupoDerivado>()
    for (const r of registros.value) {
      const id = r.grupo_aulas_id
      if (id == null) continue
      const key = String(id)
      if (!map.has(key)) {
        const partes = [r.grupo, r.area, r.turno].filter(Boolean).join(' · ')
        map.set(key, {
          id,
          label: partes || `#${key}`,
          sede: r.sede_aula || r.sede || '—',
          count: 0
        })
      }
      map.get(key)!.count++
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'es'))
  })

  const gruposFiltradosPanel = computed(() => {
    const q = busquedaGrupo.value.trim().toLowerCase()
    if (!q) return gruposDerivados.value
    return gruposDerivados.value.filter(g =>
      g.label.toLowerCase().includes(q) || g.sede.toLowerCase().includes(q))
  })

  function toggleGrupo(id: number | string) {
    const key = String(id)
    const next = new Set(gruposSel.value)
    next.has(key) ? next.delete(key) : next.add(key)
    gruposSel.value = next
    page.value = 1
  }
  function limpiarGrupos() {
    gruposSel.value = new Set()
    page.value = 1
  }

  function ordenar(col: string) {
    if (sortBy.value === col) {
      sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortBy.value = col
      sortDir.value = 'asc'
    }
  }
  function sortIcon(col: string) {
    if (sortBy.value !== col) return 'i-lucide-chevrons-up-down'
    return sortDir.value === 'asc' ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
  }

  // Registros tras: filtro por grupo + extraFilter.
  const filtrados = computed(() => {
    const sel = gruposSel.value
    return registros.value.filter(r => {
      if (sel.size && !sel.has(String(r.grupo_aulas_id))) return false
      if (opts.extraFilter && !opts.extraFilter(r)) return false
      return true
    })
  })

  // Orden.
  const ordenados = computed(() => {
    const col = sortBy.value
    if (!col) return filtrados.value
    const acc = opts.sortAccessors?.[col]
    const arr = [...filtrados.value]
    arr.sort((a, b) => {
      const va = acc ? acc(a) : (a as any)[col]
      const vb = acc ? acc(b) : (b as any)[col]
      let cmp: number
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb
      else cmp = String(va ?? '').localeCompare(String(vb ?? ''), 'es')
      return sortDir.value === 'asc' ? cmp : -cmp
    })
    return arr
  })

  const totalFiltrado = computed(() => ordenados.value.length)
  const totalPaginas = computed(() => Math.max(1, Math.ceil(totalFiltrado.value / pageSize.value)))

  // Resetear página si se sale de rango.
  watch([totalFiltrado, pageSize], () => {
    if (page.value > totalPaginas.value) page.value = totalPaginas.value
  })

  const visibles = computed(() => {
    const start = (page.value - 1) * pageSize.value
    return ordenados.value.slice(start, start + pageSize.value)
  })

  // Índice base para la columna "N°".
  const offset = computed(() => (page.value - 1) * pageSize.value)

  return {
    gruposSel, busquedaGrupo, gruposDerivados, gruposFiltradosPanel,
    toggleGrupo, limpiarGrupos,
    sortBy, sortDir, ordenar, sortIcon,
    page, pageSize, totalFiltrado, totalPaginas, visibles, offset,
    filtrados
  }
}
