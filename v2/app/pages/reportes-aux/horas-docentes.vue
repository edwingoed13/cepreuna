<script setup lang="ts">
import { fmtNumero } from '~/utils/format'

interface CatSimple { id: number; denominacion: string }
interface CatGrupo { grupo_aulas_id: number; grupo: string; area: string; turno: string; sede: string; area_id: number; turno_id: number; sede_id: number }
interface CatPersona { id: number; nombre: string; grupos: number[] }
interface Fila {
  coordinador: string | null; auxiliar: string | null
  sede: string; turno: string; area: string; grupo: string
  asistencias: number; total_horas_dictadas: number; total_horas_pago: number
}
interface Totales { horas_pago: number; horas_dictadas: number; registros: number }

const { api, descargar } = useApi()
const toast = useToast()

// Catálogos
const cSedes = ref<CatSimple[]>([])
const cTurnos = ref<CatSimple[]>([])
const cAreas = ref<CatSimple[]>([])
const cGrupos = ref<CatGrupo[]>([])
const cCoords = ref<CatPersona[]>([])
const cAuxes = ref<CatPersona[]>([])

// Selecciones
const selSedes = ref<number[]>([])
const selTurnos = ref<number[]>([])
const selAreas = ref<number[]>([])
const selGrupos = ref<number[]>([])
const selCoords = ref<number[]>([])
const selAuxes = ref<number[]>([])

// Fechas (default: mes actual)
function ymd(d: Date) { return d.toISOString().slice(0, 10) }
const hoy = new Date()
const desde = ref(ymd(new Date(hoy.getFullYear(), hoy.getMonth(), 1)))
const hasta = ref(ymd(hoy))
const tipoCarga = ref('todos')
const tipoOpts = [
  { label: 'Titulares y suplentes', value: 'todos' },
  { label: 'Solo titulares', value: '1' },
  { label: 'Solo suplentes', value: '2' }
]

// Datos
const filas = ref<Fila[]>([])
const totales = ref<Totales | null>(null)
const loading = ref(false)
const generado = ref(false)

// Items para los multi-selects
const itemsSedes = computed(() => cSedes.value.map(s => ({ label: s.denominacion, value: s.id })))
const itemsTurnos = computed(() => cTurnos.value.map(t => ({ label: t.denominacion, value: t.id })))
const itemsAreas = computed(() => cAreas.value.map(a => ({ label: a.denominacion, value: a.id })))
const itemsCoords = computed(() => cCoords.value.map(c => ({ label: c.nombre, value: c.id })))
const itemsAuxes = computed(() => cAuxes.value.map(a => ({ label: a.nombre, value: a.id })))

// Cascada: grupos disponibles según coord/aux + sede/turno/área.
const gruposDisponibles = computed<CatGrupo[]>(() => {
  let g = cGrupos.value
  if (selCoords.value.length) {
    const ids = new Set(cCoords.value.filter(c => selCoords.value.includes(c.id)).flatMap(c => c.grupos))
    g = g.filter(x => ids.has(x.grupo_aulas_id))
  }
  if (selAuxes.value.length) {
    const ids = new Set(cAuxes.value.filter(a => selAuxes.value.includes(a.id)).flatMap(a => a.grupos))
    g = g.filter(x => ids.has(x.grupo_aulas_id))
  }
  if (selSedes.value.length) g = g.filter(x => selSedes.value.includes(x.sede_id))
  if (selTurnos.value.length) g = g.filter(x => selTurnos.value.includes(x.turno_id))
  if (selAreas.value.length) g = g.filter(x => selAreas.value.includes(x.area_id))
  return g
})
const itemsGrupos = computed(() => gruposDisponibles.value.map(g => ({
  label: `${g.grupo} · ${g.area} · ${g.turno} · ${g.sede}`,
  value: g.grupo_aulas_id
})))

// Quitar grupos seleccionados que ya no estén disponibles tras un cambio de cascada.
watch(gruposDisponibles, (disp) => {
  const ids = new Set(disp.map(g => g.grupo_aulas_id))
  const filtrado = selGrupos.value.filter(id => ids.has(id))
  if (filtrado.length !== selGrupos.value.length) selGrupos.value = filtrado
})

async function cargarCatalogos() {
  try {
    const [s, t, a, g, co, au] = await Promise.all([
      api<CatSimple[]>('/api/stats/catalogos/sedes'),
      api<CatSimple[]>('/api/stats/catalogos/turnos'),
      api<CatSimple[]>('/api/stats/catalogos/areas'),
      api<CatGrupo[]>('/api/stats/catalogos/grupos'),
      api<CatPersona[]>('/api/stats/catalogos/coordinadores'),
      api<CatPersona[]>('/api/stats/catalogos/auxiliares')
    ])
    cSedes.value = s; cTurnos.value = t; cAreas.value = a
    cGrupos.value = g; cCoords.value = co; cAuxes.value = au
  } catch {
    toast.add({ title: 'Error', description: 'No se pudieron cargar los catálogos.', color: 'error' })
  }
}

function queryString() {
  const p = new URLSearchParams()
  p.set('desde', desde.value)
  p.set('hasta', hasta.value)
  if (tipoCarga.value !== 'todos') p.set('tipo_carga', tipoCarga.value)
  const csv = (arr: number[]) => arr.join(',')
  if (selSedes.value.length) p.set('sedes', csv(selSedes.value))
  if (selTurnos.value.length) p.set('turnos', csv(selTurnos.value))
  if (selAreas.value.length) p.set('areas', csv(selAreas.value))
  if (selGrupos.value.length) p.set('grupos', csv(selGrupos.value))
  if (selCoords.value.length) p.set('coordinadores', csv(selCoords.value))
  if (selAuxes.value.length) p.set('auxiliares', csv(selAuxes.value))
  return '?' + p.toString()
}

async function generar() {
  if (!desde.value || !hasta.value) {
    toast.add({ title: 'Fechas requeridas', description: 'Indica el rango de fechas.', color: 'warning' })
    return
  }
  loading.value = true
  try {
    const d = await api<{ filas: Fila[]; totales: Totales }>('/api/stats/reportes-aux/horas-docentes' + queryString())
    filas.value = d.filas || []
    totales.value = d.totales || null
    generado.value = true
    sortBy.value = ''
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo generar el reporte.', color: 'error' })
  } finally {
    loading.value = false
  }
}

async function exportar() {
  try {
    await descargar('/api/stats/reportes-aux/horas-docentes/excel' + queryString(), `horas-docentes_${desde.value}_a_${hasta.value}.xlsx`)
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo generar el Excel.', color: 'error' })
  }
}

function limpiar() {
  selSedes.value = []; selTurnos.value = []; selAreas.value = []
  selGrupos.value = []; selCoords.value = []; selAuxes.value = []
  tipoCarga.value = 'todos'
}

// Orden de la tabla
const sortBy = ref('')
const sortDir = ref<'asc' | 'desc'>('asc')
const accessors: Record<string, (f: Fila) => string | number> = {
  coordinador: f => f.coordinador || '', auxiliar: f => f.auxiliar || '',
  sede: f => f.sede, turno: f => f.turno, area: f => f.area, grupo: f => f.grupo,
  asistencias: f => f.asistencias, h_dictadas: f => f.total_horas_dictadas, h_pago: f => f.total_horas_pago
}
function ordenar(c: string) {
  if (sortBy.value === c) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortBy.value = c; sortDir.value = 'asc' }
}
function sortIcon(c: string) {
  if (sortBy.value !== c) return 'i-lucide-chevrons-up-down'
  return sortDir.value === 'asc' ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
}
const filasOrdenadas = computed(() => {
  if (!sortBy.value) return filas.value
  const acc = accessors[sortBy.value]
  const arr = [...filas.value].sort((a, b) => {
    const va = acc(a), vb = acc(b)
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'es')
    return sortDir.value === 'asc' ? cmp : -cmp
  })
  return arr
})

const cols = [
  { key: 'coordinador', label: 'Coordinador' },
  { key: 'auxiliar', label: 'Auxiliar' },
  { key: 'sede', label: 'Sede' },
  { key: 'turno', label: 'Turno' },
  { key: 'area', label: 'Área' },
  { key: 'grupo', label: 'Grupo' },
  { key: 'asistencias', label: 'Asist.', num: true },
  { key: 'h_dictadas', label: 'H. dict.', num: true },
  { key: 'h_pago', label: 'H. pago', num: true }
]

onMounted(cargarCatalogos)
</script>

<template>
  <div class="p-4 lg:p-6 space-y-4">
    <div class="flex items-center gap-3">
      <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-400">
        <UIcon name="i-lucide-banknote" class="size-5" />
      </span>
      <div>
        <h2 class="text-lg font-black">Horas pago por docentes</h2>
        <p class="text-sm text-muted">Horas a pagar por coordinador, auxiliar, sede, turno, área y grupo.</p>
      </div>
    </div>

    <!-- Filtros -->
    <UCard :ui="{ body: 'p-3 sm:p-4' }">
      <div class="flex flex-wrap items-end gap-3">
        <UFormField label="Desde"><UInput v-model="desde" type="date" class="w-40" /></UFormField>
        <UFormField label="Hasta"><UInput v-model="hasta" type="date" class="w-40" /></UFormField>
        <UFormField label="Tipo de carga"><USelect v-model="tipoCarga" :items="tipoOpts" value-key="value" class="w-48" /></UFormField>
      </div>
      <div class="flex flex-wrap items-end gap-3 mt-3">
        <UFormField label="Sede"><FiltroMulti v-model="selSedes" :items="itemsSedes" placeholder="Todas las sedes" icon="i-lucide-map-pin" /></UFormField>
        <UFormField label="Turno"><FiltroMulti v-model="selTurnos" :items="itemsTurnos" placeholder="Todos los turnos" icon="i-lucide-clock" /></UFormField>
        <UFormField label="Área"><FiltroMulti v-model="selAreas" :items="itemsAreas" placeholder="Todas las áreas" icon="i-lucide-shapes" /></UFormField>
        <UFormField label="Coordinador"><FiltroMulti v-model="selCoords" :items="itemsCoords" placeholder="Todos" icon="i-lucide-user-cog" /></UFormField>
        <UFormField label="Auxiliar"><FiltroMulti v-model="selAuxes" :items="itemsAuxes" placeholder="Todos" icon="i-lucide-user" /></UFormField>
        <UFormField :label="`Grupo (${itemsGrupos.length})`"><FiltroMulti v-model="selGrupos" :items="itemsGrupos" placeholder="Todos los grupos" icon="i-lucide-layers" /></UFormField>
      </div>
      <div class="flex items-center gap-3 mt-4">
        <UButton label="Generar reporte" icon="i-lucide-play" :loading="loading" @click="generar" />
        <UButton label="Limpiar filtros" color="neutral" variant="ghost" icon="i-lucide-x" @click="limpiar" />
        <UButton v-if="generado && !loading" label="Excel" icon="i-lucide-download" color="success" variant="soft" class="ml-auto" @click="exportar" />
      </div>
    </UCard>

    <!-- KPIs -->
    <div v-if="generado && !loading" class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard label="Horas pago" :value="fmtNumero(totales?.horas_pago)" color="primary" icon="i-lucide-banknote" />
      <KpiCard label="Horas dictadas" :value="fmtNumero(totales?.horas_dictadas)" icon="i-lucide-clock" />
      <KpiCard label="Filas (grupos)" :value="fmtNumero(totales?.registros)" icon="i-lucide-rows-3" />
      <KpiCard label="Rango" :value="`${desde} → ${hasta}`" icon="i-lucide-calendar-range" />
    </div>

    <!-- Tabla -->
    <UCard v-if="generado && !loading" :ui="{ body: 'p-0' }">
      <div class="overflow-x-auto max-h-[65vh] overflow-y-auto">
        <table class="w-full text-xs border-separate border-spacing-0">
          <thead class="sticky top-0 z-10">
            <tr class="text-muted uppercase tracking-tight">
              <th
                v-for="c in cols"
                :key="c.key"
                class="px-3 py-2 font-bold cursor-pointer select-none whitespace-nowrap bg-elevated/80 backdrop-blur border-b border-default"
                :class="[c.num ? 'text-right' : 'text-left', sortBy === c.key ? 'text-sky-600 dark:text-sky-400' : '']"
                @click="ordenar(c.key)"
              >
                <span class="inline-flex items-center gap-1">{{ c.label }}<UIcon :name="sortIcon(c.key)" class="size-3" /></span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!filasOrdenadas.length"><td colspan="9" class="text-center py-10 text-muted">Sin resultados para los filtros.</td></tr>
            <tr v-for="(f, i) in filasOrdenadas" v-else :key="i" class="border-b border-default hover:bg-elevated/40">
              <td class="px-3 py-1.5">{{ f.coordinador || '—' }}</td>
              <td class="px-3 py-1.5">{{ f.auxiliar || '—' }}</td>
              <td class="px-3 py-1.5">{{ f.sede }}</td>
              <td class="px-3 py-1.5">{{ f.turno }}</td>
              <td class="px-3 py-1.5">{{ f.area }}</td>
              <td class="px-3 py-1.5 font-medium">{{ f.grupo }}</td>
              <td class="px-3 py-1.5 text-right font-mono">{{ fmtNumero(f.asistencias) }}</td>
              <td class="px-3 py-1.5 text-right font-mono">{{ fmtNumero(f.total_horas_dictadas) }}</td>
              <td class="px-3 py-1.5 text-right font-mono font-bold">{{ fmtNumero(f.total_horas_pago) }}</td>
            </tr>
          </tbody>
          <tfoot v-if="filasOrdenadas.length" class="sticky bottom-0">
            <tr class="bg-elevated font-bold border-t-2 border-default">
              <td class="px-3 py-2" colspan="7">TOTAL</td>
              <td class="px-3 py-2 text-right font-mono">{{ fmtNumero(totales?.horas_dictadas) }}</td>
              <td class="px-3 py-2 text-right font-mono text-cepreuna-700 dark:text-cepreuna-300">{{ fmtNumero(totales?.horas_pago) }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </UCard>

    <!-- Generando -->
    <AcademicLoader v-if="loading" title="Generando reporte" subtitle="Calculando las horas de pago por docente." icon="i-lucide-banknote" />

    <!-- Estado inicial -->
    <div v-else-if="!generado" class="text-center py-16 text-muted">
      <UIcon name="i-lucide-sliders-horizontal" class="size-10 mx-auto mb-3 opacity-50" />
      <p class="text-sm">Ajusta los filtros y pulsa <b>Generar reporte</b>.</p>
    </div>
  </div>
</template>
