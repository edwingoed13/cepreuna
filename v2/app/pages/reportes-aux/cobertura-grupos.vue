<script setup lang="ts">
import { fmtNumero } from '~/utils/format'

interface CatSimple { id: number; denominacion: string }
interface CatGrupo { grupo_aulas_id: number; grupo: string; area: string; turno: string; sede: string; area_id: number; turno_id: number; sede_id: number }
interface CatPersona { id: number; nombre: string; grupos: number[] }
interface GrupoCob { grupo_aulas_id: number; grupo: string; area: string; turno: string; sede: string; sede_id: number; turno_id: number; area_id: number; auxiliares_asignados: string | null; coordinadores_asignados: string | null }
interface Asist { grupo_aulas_id: number; fecha: string; tomada_por: string }

const { api, descargar } = useApi()
const toast = useToast()

// Catálogos
const cSedes = ref<CatSimple[]>([]); const cTurnos = ref<CatSimple[]>([]); const cAreas = ref<CatSimple[]>([])
const cGrupos = ref<CatGrupo[]>([]); const cAuxes = ref<CatPersona[]>([])
const selSedes = ref<number[]>([]); const selTurnos = ref<number[]>([]); const selAreas = ref<number[]>([])
const selGrupos = ref<number[]>([]); const selAuxes = ref<number[]>([])

function ymd(d: Date) { return d.toISOString().slice(0, 10) }
function lunesSemana(base: Date) { const d = new Date(base); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d }
const hoy = new Date()
const desde = ref(ymd(lunesSemana(hoy)))
const hasta = ref(ymd(new Date(lunesSemana(hoy).getTime() + 4 * 86400000)))

const estado = ref('todos')   // 'todos' | faltas | 100 | sin
const diasModo = ref('habiles') // habiles | todos
const vista = ref<'semanal' | 'dinamica'>('semanal')
const estadoOpts = [
  { label: 'Todos', value: 'todos' },
  { label: 'Con faltas', value: 'faltas' },
  { label: '100% cumplimiento', value: '100' },
  { label: 'Sin auxiliar', value: 'sin' }
]
const diasOpts = [{ label: 'Solo Lun–Vie', value: 'habiles' }, { label: 'Incluir fin de semana', value: 'todos' }]

const grupos = ref<GrupoCob[]>([])
const asistencias = ref<Asist[]>([])
const loading = ref(false)
const generado = ref(false)

const itemsSedes = computed(() => cSedes.value.map(s => ({ label: s.denominacion, value: s.id })))
const itemsTurnos = computed(() => cTurnos.value.map(t => ({ label: t.denominacion, value: t.id })))
const itemsAreas = computed(() => cAreas.value.map(a => ({ label: a.denominacion, value: a.id })))
const itemsAuxes = computed(() => cAuxes.value.map(a => ({ label: a.nombre, value: a.id })))
const itemsGrupos = computed(() => cGrupos.value.map(g => ({ label: `${g.grupo} · ${g.area} · ${g.turno} · ${g.sede}`, value: g.grupo_aulas_id })))

async function cargarCatalogos() {
  try {
    const [s, t, a, g, au] = await Promise.all([
      api<CatSimple[]>('/api/stats/catalogos/sedes'),
      api<CatSimple[]>('/api/stats/catalogos/turnos'),
      api<CatSimple[]>('/api/stats/catalogos/areas'),
      api<CatGrupo[]>('/api/stats/catalogos/grupos'),
      api<CatPersona[]>('/api/stats/catalogos/auxiliares')
    ])
    cSedes.value = s; cTurnos.value = t; cAreas.value = a; cGrupos.value = g; cAuxes.value = au
  } catch { /* manejado por useApi */ }
}

function queryString() {
  const p = new URLSearchParams()
  p.set('desde', desde.value); p.set('hasta', hasta.value)
  const csv = (arr: number[]) => arr.join(',')
  if (selSedes.value.length) p.set('sedes', csv(selSedes.value))
  if (selTurnos.value.length) p.set('turnos', csv(selTurnos.value))
  if (selAreas.value.length) p.set('areas', csv(selAreas.value))
  if (selGrupos.value.length) p.set('grupos', csv(selGrupos.value))
  if (selAuxes.value.length) p.set('auxiliares', csv(selAuxes.value))
  return '?' + p.toString()
}

async function generar() {
  if (!desde.value || !hasta.value) { toast.add({ title: 'Fechas requeridas', color: 'warning' }); return }
  loading.value = true
  try {
    const d = await api<{ grupos: GrupoCob[]; asistencias: Asist[] }>('/api/stats/reportes-aux/cobertura-grupos' + queryString())
    grupos.value = d.grupos || []
    asistencias.value = d.asistencias || []
    generado.value = true
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo generar la cobertura.', color: 'error' })
  } finally {
    loading.value = false
  }
}

async function exportar() {
  try {
    await descargar('/api/stats/reportes-aux/cobertura-grupos/excel' + queryString() + '&vista=' + vista.value, `cobertura-grupos_${vista.value}_${desde.value}_a_${hasta.value}.xlsx`)
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo generar el Excel.', color: 'error' })
  }
}

// Rango rápido
async function rango(tipo: 'semana' | 'mes' | 'ciclo') {
  if (tipo === 'semana') {
    const l = lunesSemana(new Date())
    desde.value = ymd(l); hasta.value = ymd(new Date(l.getTime() + 4 * 86400000))
  } else if (tipo === 'mes') {
    desde.value = ymd(new Date(hoy.getFullYear(), hoy.getMonth(), 1)); hasta.value = ymd(hoy)
  } else {
    try {
      const r = await api<{ min_fecha: string; max_fecha: string }>('/api/stats/reportes-aux/rango-fechas')
      desde.value = r.min_fecha; hasta.value = r.max_fecha
    } catch { return }
  }
  generar()
}

// ----- Pivote -----
function fechasEntre(d1: string, d2: string): string[] {
  const out: string[] = []
  const a = new Date(d1 + 'T12:00:00'); const b = new Date(d2 + 'T12:00:00')
  for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay()
    if (diasModo.value === 'habiles' && (dow === 0 || dow === 6)) continue
    out.push(ymd(d))
  }
  return out
}
const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
const fechas = computed(() => fechasEntre(desde.value, hasta.value))
const asistSet = computed(() => new Set(asistencias.value.map(a => a.grupo_aulas_id + '|' + a.fecha)))
function tomada(gid: number, f: string) { return asistSet.value.has(gid + '|' + f) }

// Vista dinámica: 1 fila por grupo, columnas = fechas.
interface FilaDin extends GrupoCob { celdas: boolean[]; tomados: number; faltantes: number; pct: number }
const filasDinamica = computed<FilaDin[]>(() => grupos.value.map(g => {
  const celdas = fechas.value.map(f => tomada(g.grupo_aulas_id, f))
  const tomados = celdas.filter(Boolean).length
  const total = celdas.length
  return { ...g, celdas, tomados, faltantes: total - tomados, pct: total ? Math.round(100 * tomados / total) : 0 }
}))

// Vista semanal: 1 fila por (grupo × semana). Columnas Lun-Vie.
interface FilaSem extends GrupoCob { semana: string; dias: (boolean | null)[]; si: number; total: number; pct: number }
const semanas = computed(() => {
  const set = new Set<string>()
  for (const f of fechas.value) set.add(ymd(lunesSemana(new Date(f + 'T12:00:00'))))
  return [...set].sort()
})
const filasSemanal = computed<FilaSem[]>(() => {
  const rango = new Set(fechas.value)
  const out: FilaSem[] = []
  for (const g of grupos.value) {
    for (const lun of semanas.value) {
      const base = new Date(lun + 'T12:00:00')
      const dias: (boolean | null)[] = []
      let si = 0, total = 0
      for (let i = 0; i < 5; i++) {
        const f = ymd(new Date(base.getTime() + i * 86400000))
        if (!rango.has(f)) { dias.push(null); continue }
        const t = tomada(g.grupo_aulas_id, f)
        dias.push(t); total++; if (t) si++
      }
      out.push({ ...g, semana: lun, dias, si, total, pct: total ? Math.round(100 * si / total) : 0 })
    }
  }
  return out
})

// Filtro de estado (client-side) sobre la vista activa.
function aplicaEstado(pct: number, faltantes: number, aux: string | null): boolean {
  if (estado.value === 'faltas') return faltantes > 0
  if (estado.value === '100') return pct === 100
  if (estado.value === 'sin') return !aux
  return true
}
const filasDinFiltradas = computed(() => filasDinamica.value.filter(f => aplicaEstado(f.pct, f.faltantes, f.auxiliares_asignados)))
const filasSemFiltradas = computed(() => filasSemanal.value.filter(f => aplicaEstado(f.pct, f.total - f.si, f.auxiliares_asignados)))

// KPIs
const kpis = computed(() => {
  const filas = vista.value === 'semanal' ? filasSemFiltradas.value : filasDinFiltradas.value
  const gids = new Set(filas.map((f: any) => f.grupo_aulas_id))
  const pcts = filas.map((f: any) => f.pct)
  const prom = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0
  const conFaltas = filas.filter((f: any) => (vista.value === 'semanal' ? f.total - f.si : f.faltantes) > 0).length
  const sinAux = new Set(filas.filter((f: any) => !f.auxiliares_asignados).map((f: any) => f.grupo_aulas_id)).size
  return { grupos: gids.size, prom, conFaltas, sinAux }
})

function pctColor(p: number) {
  if (p >= 90) return 'text-green-600 dark:text-green-400'
  if (p >= 60) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}
function fechaCorta(f: string) { const d = new Date(f + 'T12:00:00'); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${DOW[d.getDay()]}` }

onMounted(cargarCatalogos)
</script>

<template>
  <div class="p-4 lg:p-6 space-y-4">
    <div class="flex items-center gap-3">
      <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <UIcon name="i-lucide-grid-3x3" class="size-5" />
      </span>
      <div>
        <h2 class="text-lg font-black">Cobertura de asistencia</h2>
        <p class="text-sm text-muted">Matriz SI/NO por grupo y día con % de cumplimiento.</p>
      </div>
    </div>

    <!-- Filtros -->
    <UCard :ui="{ body: 'p-3 sm:p-4' }">
      <div class="flex flex-wrap items-end gap-3">
        <UFormField label="Desde"><UInput v-model="desde" type="date" class="w-40" /></UFormField>
        <UFormField label="Hasta"><UInput v-model="hasta" type="date" class="w-40" /></UFormField>
        <div class="flex items-end gap-1">
          <UButton size="xs" color="neutral" variant="outline" label="Semana" @click="rango('semana')" />
          <UButton size="xs" color="neutral" variant="outline" label="Mes" @click="rango('mes')" />
          <UButton size="xs" color="neutral" variant="outline" label="Ciclo" @click="rango('ciclo')" />
        </div>
      </div>
      <div class="flex flex-wrap items-end gap-3 mt-3">
        <UFormField label="Sede"><FiltroMulti v-model="selSedes" :items="itemsSedes" placeholder="Todas" icon="i-lucide-map-pin" /></UFormField>
        <UFormField label="Turno"><FiltroMulti v-model="selTurnos" :items="itemsTurnos" placeholder="Todos" icon="i-lucide-clock" /></UFormField>
        <UFormField label="Área"><FiltroMulti v-model="selAreas" :items="itemsAreas" placeholder="Todas" icon="i-lucide-shapes" /></UFormField>
        <UFormField label="Grupo"><FiltroMulti v-model="selGrupos" :items="itemsGrupos" placeholder="Todos" icon="i-lucide-layers" /></UFormField>
        <UFormField label="Auxiliar"><FiltroMulti v-model="selAuxes" :items="itemsAuxes" placeholder="Todos" icon="i-lucide-user" /></UFormField>
      </div>
      <div class="flex flex-wrap items-end gap-3 mt-3">
        <UFormField label="Estado"><USelect v-model="estado" :items="estadoOpts" value-key="value" class="w-44" /></UFormField>
        <UFormField label="Días"><USelect v-model="diasModo" :items="diasOpts" value-key="value" class="w-48" /></UFormField>
        <UButton label="Generar" icon="i-lucide-play" :loading="loading" @click="generar" />
        <div v-if="generado" class="flex items-end gap-2 ml-auto">
          <UButtonGroup>
            <UButton :color="vista === 'semanal' ? 'primary' : 'neutral'" :variant="vista === 'semanal' ? 'solid' : 'outline'" size="sm" label="Semanal" @click="vista = 'semanal'" />
            <UButton :color="vista === 'dinamica' ? 'primary' : 'neutral'" :variant="vista === 'dinamica' ? 'solid' : 'outline'" size="sm" label="Por fecha" @click="vista = 'dinamica'" />
          </UButtonGroup>
          <UButton label="Excel" icon="i-lucide-download" color="success" variant="soft" size="sm" @click="exportar" />
        </div>
      </div>
    </UCard>

    <!-- KPIs -->
    <div v-if="generado && !loading" class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard label="Grupos" :value="fmtNumero(kpis.grupos)" color="primary" icon="i-lucide-layers" />
      <KpiCard label="Cumplimiento prom." :value="kpis.prom + '%'" :color="kpis.prom >= 90 ? 'success' : kpis.prom >= 60 ? 'warning' : 'error'" icon="i-lucide-gauge" />
      <KpiCard label="Con faltas" :value="fmtNumero(kpis.conFaltas)" color="warning" icon="i-lucide-calendar-x" />
      <KpiCard label="Sin auxiliar" :value="fmtNumero(kpis.sinAux)" color="error" icon="i-lucide-user-x" />
    </div>

    <!-- Matriz -->
    <UCard v-if="generado && !loading" :ui="{ body: 'p-0' }">
      <div class="overflow-x-auto max-h-[65vh] overflow-y-auto">
        <!-- VISTA SEMANAL -->
        <table v-if="vista === 'semanal'" class="w-full text-xs border-separate border-spacing-0">
          <thead class="sticky top-0 z-10">
            <tr class="text-muted uppercase tracking-tight">
              <th class="px-3 py-2 text-left font-bold bg-elevated/80 backdrop-blur border-b border-default sticky left-0 z-20">Grupo</th>
              <th class="px-3 py-2 text-left font-bold bg-elevated/80 backdrop-blur border-b border-default">Área</th>
              <th class="px-3 py-2 text-left font-bold bg-elevated/80 backdrop-blur border-b border-default">Turno</th>
              <th class="px-3 py-2 text-left font-bold bg-elevated/80 backdrop-blur border-b border-default">Auxiliar</th>
              <th class="px-3 py-2 text-left font-bold bg-elevated/80 backdrop-blur border-b border-default">Semana</th>
              <th v-for="d in ['Lun', 'Mar', 'Mié', 'Jue', 'Vie']" :key="d" class="px-2 py-2 text-center font-bold bg-elevated/80 backdrop-blur border-b border-default">{{ d }}</th>
              <th class="px-2 py-2 text-center font-bold bg-elevated/80 backdrop-blur border-b border-default">SI/Tot</th>
              <th class="px-2 py-2 text-center font-bold bg-elevated/80 backdrop-blur border-b border-default">%</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!filasSemFiltradas.length"><td colspan="12" class="text-center py-10 text-muted">Sin resultados.</td></tr>
            <tr v-for="(f, i) in filasSemFiltradas" v-else :key="i" class="border-b border-default hover:bg-elevated/40 group">
              <td class="px-3 py-1.5 font-medium sticky left-0 bg-default group-hover:bg-elevated/40 z-10">{{ f.grupo }}</td>
              <td class="px-3 py-1.5">{{ f.area }}</td>
              <td class="px-3 py-1.5">{{ f.turno }}</td>
              <td class="px-3 py-1.5 max-w-[160px] truncate" :class="!f.auxiliares_asignados ? 'text-red-500' : ''">{{ f.auxiliares_asignados || '— sin asignar —' }}</td>
              <td class="px-3 py-1.5 font-mono text-muted">{{ f.semana.slice(5) }}</td>
              <td v-for="(d, di) in f.dias" :key="di" class="px-1 py-1 text-center">
                <span v-if="d === null" class="text-slate-300">—</span>
                <span v-else-if="d" class="inline-block w-6 rounded bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300 font-bold">SI</span>
                <span v-else class="inline-block w-6 rounded bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300 font-bold">NO</span>
              </td>
              <td class="px-2 py-1.5 text-center font-mono">{{ f.si }}/{{ f.total }}</td>
              <td class="px-2 py-1.5 text-center font-mono font-bold" :class="pctColor(f.pct)">{{ f.pct }}%</td>
            </tr>
          </tbody>
        </table>

        <!-- VISTA DINÁMICA (por fecha) -->
        <table v-else class="w-full text-xs border-separate border-spacing-0">
          <thead class="sticky top-0 z-10">
            <tr class="text-muted uppercase tracking-tight">
              <th class="px-3 py-2 text-left font-bold bg-elevated/80 backdrop-blur border-b border-default sticky left-0 z-20">Grupo</th>
              <th class="px-3 py-2 text-left font-bold bg-elevated/80 backdrop-blur border-b border-default">Auxiliar</th>
              <th v-for="f in fechas" :key="f" class="px-1.5 py-2 text-center font-bold bg-elevated/80 backdrop-blur border-b border-default whitespace-nowrap">{{ fechaCorta(f) }}</th>
              <th class="px-2 py-2 text-center font-bold bg-elevated/80 backdrop-blur border-b border-default">Tom.</th>
              <th class="px-2 py-2 text-center font-bold bg-elevated/80 backdrop-blur border-b border-default">Falt.</th>
              <th class="px-2 py-2 text-center font-bold bg-elevated/80 backdrop-blur border-b border-default">%</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!filasDinFiltradas.length"><td :colspan="fechas.length + 5" class="text-center py-10 text-muted">Sin resultados.</td></tr>
            <tr v-for="(f, i) in filasDinFiltradas" v-else :key="i" class="border-b border-default hover:bg-elevated/40 group">
              <td class="px-3 py-1.5 font-medium sticky left-0 bg-default group-hover:bg-elevated/40 z-10 whitespace-nowrap">{{ f.grupo }}</td>
              <td class="px-3 py-1.5 max-w-[140px] truncate" :class="!f.auxiliares_asignados ? 'text-red-500' : ''">{{ f.auxiliares_asignados || '— sin asignar —' }}</td>
              <td v-for="(c, ci) in f.celdas" :key="ci" class="px-1 py-1 text-center">
                <span v-if="c" class="inline-block w-6 rounded bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300 font-bold">SI</span>
                <span v-else class="inline-block w-6 rounded bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300 font-bold">NO</span>
              </td>
              <td class="px-2 py-1.5 text-center font-mono">{{ f.tomados }}</td>
              <td class="px-2 py-1.5 text-center font-mono">{{ f.faltantes }}</td>
              <td class="px-2 py-1.5 text-center font-mono font-bold" :class="pctColor(f.pct)">{{ f.pct }}%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <!-- Generando -->
    <AcademicLoader v-if="loading" title="Generando cobertura" subtitle="Pivoteando la asistencia por grupo y día." icon="i-lucide-grid-3x3" />

    <div v-else-if="!generado" class="text-center py-16 text-muted">
      <UIcon name="i-lucide-sliders-horizontal" class="size-10 mx-auto mb-3 opacity-50" />
      <p class="text-sm">Ajusta los filtros y pulsa <b>Generar</b>.</p>
    </div>
  </div>
</template>
