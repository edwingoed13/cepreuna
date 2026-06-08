<script setup lang="ts">
import { fmtNumero, fmtPct } from '~/utils/format'
import { estadoCalificacion } from '~/utils/estados'

interface RegistroCalif {
  nro_documento: string
  paterno: string; materno: string; nombres: string
  sede: string; sede_aula?: string; area: string; turno: string; grupo: string
  grupo_aulas_id: number | string | null
  total_docentes: number
  docentes_calificados: number
  cursos_faltantes?: string | null
}

const { api } = useApi()
const toast = useToast()

const registros = ref<RegistroCalif[]>([])
const loading = ref(false)
const error = ref(false)

const dni = ref('')
// 'todos' es el sentinel de "sin filtro" (USelect/Reka no admite value '').
const estado = ref<'todos' | 'completo' | 'parcial' | 'sin'>('todos')

const estadoOpts = [
  { label: 'Todos', value: 'todos' },
  { label: '✓ Completa', value: 'completo' },
  { label: '◐ Parcial', value: 'parcial' },
  { label: '✗ Sin calificar', value: 'sin' }
]

const filtrosActivos = computed(() => (dni.value.trim() ? 1 : 0) + (estado.value !== 'todos' ? 1 : 0))

async function cargar() {
  loading.value = true
  error.value = false
  try {
    // Carga única (cacheada en backend); DNI/estado se filtran client-side en vivo.
    const d = await api<{ registros: RegistroCalif[] }>('/api/stats/calificaciones')
    registros.value = d.registros || []
  } catch {
    error.value = true
    toast.add({ title: 'Error', description: 'No se pudo cargar las calificaciones.', color: 'error' })
  } finally {
    loading.value = false
  }
}

function limpiar() { dni.value = ''; estado.value = 'todos' }

function clasif(r: RegistroCalif) {
  return estadoCalificacion(Number(r.docentes_calificados) || 0, Number(r.total_docentes) || 0)
}

const tabla = useTablaAlumnos<RegistroCalif>(registros, {
  extraFilter: (r) => {
    const query = dni.value.trim().toLowerCase()
    if (query && !`${r.nro_documento} ${r.paterno} ${r.materno} ${r.nombres}`.toLowerCase().includes(query)) return false
    return estado.value === 'todos' || clasif(r).tipo === estado.value
  },
  sortAccessors: {
    nro_documento: r => r.nro_documento,
    nombre: r => `${r.paterno} ${r.materno} ${r.nombres}`,
    sede: r => r.sede, area: r => r.area, turno: r => r.turno, grupo: r => r.grupo,
    calif: (r) => {
      const y = Number(r.total_docentes) || 0
      const x = Number(r.docentes_calificados) || 0
      return y === 0 ? -1 : x / y
    }
  }
})

watch([estado, dni], () => { tabla.page.value = 1 })

const kpis = computed(() => {
  let comp = 0, parc = 0, sin = 0
  for (const r of registros.value) {
    const t = clasif(r).tipo
    if (t === 'completo') comp++
    else if (t === 'parcial') parc++
    else if (t === 'sin') sin++
  }
  return { total: registros.value.length, comp, parc, sin }
})

function celdaCalif(r: RegistroCalif) {
  const y = Number(r.total_docentes) || 0
  const x = Number(r.docentes_calificados) || 0
  const c = clasif(r)
  const texto = y === 0 ? 'Sin docentes' : `${x} de ${y}`
  const tooltip = c.tipo === 'parcial' && r.cursos_faltantes ? 'Le falta calificar: ' + r.cursos_faltantes : undefined
  return { tipo: c.tipo, texto, tooltip }
}

const cols = [
  { key: 'nro_documento', label: 'DNI', sticky: true },
  { key: 'nombre', label: 'Apellidos y Nombres', sticky: true },
  { key: 'sede', label: 'Sede' },
  { key: 'area', label: 'Área' },
  { key: 'turno', label: 'Turno' },
  { key: 'grupo', label: 'Grupo' }
]
const sortActive = (key: string) => tabla.sortBy.value === key

onMounted(cargar)
</script>

<template>
  <div class="p-4 lg:p-6 space-y-4">
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard label="Total alumnos" :value="fmtNumero(kpis.total)" icon="i-lucide-users" />
      <KpiCard label="Calificación completa" :value="fmtNumero(kpis.comp)" :hint="fmtPct(kpis.comp, kpis.total)" color="success" icon="i-lucide-check" />
      <KpiCard label="Calificación parcial" :value="fmtNumero(kpis.parc)" :hint="fmtPct(kpis.parc, kpis.total)" color="warning" icon="i-lucide-circle-dashed" />
      <KpiCard label="Sin calificar" :value="fmtNumero(kpis.sin)" :hint="fmtPct(kpis.sin, kpis.total)" color="error" icon="i-lucide-x" />
    </div>

    <UCard :ui="{ body: 'p-3 sm:p-4' }">
      <div class="flex flex-wrap items-end gap-3">
        <UFormField label="Buscar" class="flex-1 min-w-[180px]">
          <UInput v-model="dni" placeholder="DNI o nombre…" icon="i-lucide-search" class="w-full" />
        </UFormField>
        <UFormField label="Estado">
          <USelect v-model="estado" :items="estadoOpts" value-key="value" class="w-44" />
        </UFormField>
        <UButton v-if="filtrosActivos" label="Limpiar" color="neutral" variant="ghost" icon="i-lucide-x" @click="limpiar" />
        <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" :loading="loading" aria-label="Recargar" @click="cargar" />
      </div>
      <p v-if="filtrosActivos" class="text-[11px] text-amber-600 dark:text-amber-400 mt-2 flex items-center gap-1">
        <UIcon name="i-lucide-filter" class="size-3" />{{ filtrosActivos }} filtro{{ filtrosActivos === 1 ? '' : 's' }} activo{{ filtrosActivos === 1 ? '' : 's' }}
      </p>
    </UCard>

    <GruposFilter
      :grupos="tabla.gruposFiltradosPanel.value"
      :seleccionados="tabla.gruposSel.value"
      @toggle="tabla.toggleGrupo"
      @limpiar="tabla.limpiarGrupos"
      @update:busqueda="(v: string) => tabla.busquedaGrupo.value = v"
    />

    <UCard :ui="{ header: 'p-3 sm:px-4', body: 'p-0' }">
      <template #header>
        <h3 class="font-bold text-sm flex items-center gap-2">
          <UIcon name="i-lucide-clipboard-check" class="size-4 text-sky-600 dark:text-sky-400" />
          Calificación docente
          <span class="text-muted font-normal">· {{ fmtNumero(tabla.totalFiltrado.value) }}</span>
        </h3>
      </template>

      <div class="overflow-x-auto max-h-[70vh] overflow-y-auto">
        <table class="w-full text-xs border-separate border-spacing-0">
          <thead class="sticky top-0 z-10">
            <tr class="text-muted uppercase tracking-tight">
              <th class="px-3 py-2 text-right font-bold w-12 bg-elevated/80 backdrop-blur border-b border-default sticky left-0 z-20">N°</th>
              <th
                v-for="(c, ci) in cols"
                :key="c.key"
                class="px-3 py-2 text-left font-bold cursor-pointer select-none whitespace-nowrap bg-elevated/80 backdrop-blur border-b border-default"
                :class="[c.sticky ? 'sticky z-20' : '', c.sticky && ci === 0 ? 'left-12' : '', sortActive(c.key) ? 'text-sky-600 dark:text-sky-400' : '']"
                :style="c.sticky && ci === 1 ? 'left: 7.5rem' : ''"
                @click="tabla.ordenar(c.key)"
              >
                <span class="inline-flex items-center gap-1">{{ c.label }}<UIcon :name="tabla.sortIcon(c.key)" class="size-3" /></span>
              </th>
              <th
                class="px-3 py-2 text-center font-bold cursor-pointer select-none bg-elevated/80 backdrop-blur border-b border-default"
                :class="sortActive('calif') ? 'text-sky-600 dark:text-sky-400' : ''"
                @click="tabla.ordenar('calif')"
              >
                <span class="inline-flex items-center gap-1">Calificación<UIcon :name="tabla.sortIcon('calif')" class="size-3" /></span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="8" class="p-0">
                <AcademicLoader title="Calculando calificaciones" subtitle="Procesando la cobertura por alumno — la primera vez puede tardar unos segundos." />
              </td>
            </tr>
            <tr v-else-if="error">
              <td colspan="8" class="text-center py-12">
                <UIcon name="i-lucide-wifi-off" class="size-8 text-muted mx-auto mb-2" />
                <p class="text-sm text-muted mb-3">No se pudo cargar las calificaciones.</p>
                <UButton label="Reintentar" icon="i-lucide-refresh-cw" size="sm" @click="cargar" />
              </td>
            </tr>
            <tr v-else-if="!tabla.visibles.value.length">
              <td colspan="8" class="text-center py-12 text-muted">
                <UIcon name="i-lucide-search-x" class="size-8 mx-auto mb-2 opacity-50" />
                <p class="text-sm">Sin resultados.</p>
              </td>
            </tr>
            <tr v-for="(r, idx) in tabla.visibles.value" v-else :key="idx" class="border-b border-default hover:bg-elevated/40 group">
              <td class="px-3 py-1.5 text-right font-mono text-muted sticky left-0 bg-default group-hover:bg-elevated/40 z-10">{{ tabla.offset.value + idx + 1 }}</td>
              <td class="px-3 py-1.5 font-mono sticky left-12 bg-default group-hover:bg-elevated/40 z-10">{{ r.nro_documento }}</td>
              <td class="px-3 py-1.5 font-medium whitespace-nowrap sticky bg-default group-hover:bg-elevated/40 z-10" style="left: 7.5rem">{{ r.paterno }} {{ r.materno }} {{ r.nombres }}</td>
              <td class="px-3 py-1.5">{{ r.sede }}</td>
              <td class="px-3 py-1.5">{{ r.area }}</td>
              <td class="px-3 py-1.5">{{ r.turno }}</td>
              <td class="px-3 py-1.5">{{ r.grupo }}</td>
              <td class="px-2 py-1 text-center"><EstadoCelda v-bind="celdaCalif(r)" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2 text-xs text-muted">
        <span>{{ fmtNumero(tabla.totalFiltrado.value) }} registros</span>
        <USelectMenu v-model="tabla.pageSize.value" :items="[25, 50, 100, 250]" size="xs" class="w-20" />
        <span>por página</span>
      </div>
      <UPagination v-model:page="tabla.page.value" :total="tabla.totalFiltrado.value" :items-per-page="tabla.pageSize.value" :sibling-count="1" />
    </div>
  </div>
</template>
