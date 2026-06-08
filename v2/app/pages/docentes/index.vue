<script setup lang="ts">
import { fmtNumero } from '~/utils/format'

interface CatSimple { id: number; denominacion: string }
interface RankItem { etiqueta: string; promedio: number; participantes: number; docentes: number; score?: number; participacion?: number | null; robustez?: string }
interface DocItem { id: number; docente: string; promedio_crudo: number; score: number; participantes: number; robustez: string }

const { api, descargar } = useApi()
const toast = useToast()
const exportando = ref(false)

async function exportarPadron() {
  exportando.value = true
  try {
    await descargar('/api/stats/docentes-stats/export/padron.xlsx', 'padron-docentes.xlsx')
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo generar el padrón.', color: 'error' })
  } finally {
    exportando.value = false
  }
}

const loading = ref(true)
const error = ref(false)
const data = ref<any>(null)

// Catálogos para filtros
const cSedes = ref<CatSimple[]>([]); const cAreas = ref<CatSimple[]>([]); const cTurnos = ref<CatSimple[]>([])
const TODOS = 'todos'
const fSede = ref(TODOS); const fArea = ref(TODOS); const fTurno = ref(TODOS)
const soloValidas = ref(false)
const umbral = ref('50')

const umbralOpts = [
  { label: '≥ 50 participantes', value: '50' },
  { label: '≥ 80 participantes', value: '80' },
  { label: '≥ 100 participantes', value: '100' }
]
const optSede = computed(() => [{ label: 'Todas las sedes', value: TODOS }, ...cSedes.value.map(s => ({ label: s.denominacion, value: String(s.id) }))])
const optArea = computed(() => [{ label: 'Todas las áreas', value: TODOS }, ...cAreas.value.map(s => ({ label: s.denominacion, value: String(s.id) }))])
const optTurno = computed(() => [{ label: 'Todos los turnos', value: TODOS }, ...cTurnos.value.map(s => ({ label: s.denominacion, value: String(s.id) }))])

function query() {
  const p = new URLSearchParams()
  if (fSede.value !== TODOS) p.set('sede', fSede.value)
  if (fArea.value !== TODOS) p.set('area', fArea.value)
  if (fTurno.value !== TODOS) p.set('turno', fTurno.value)
  if (soloValidas.value) p.set('solo_validas', '1')
  p.set('umbral', umbral.value)
  const s = p.toString()
  return s ? '?' + s : ''
}

async function cargarCatalogos() {
  try {
    const [s, a, t] = await Promise.all([
      api<CatSimple[]>('/api/stats/catalogos/sedes'),
      api<CatSimple[]>('/api/stats/catalogos/areas'),
      api<CatSimple[]>('/api/stats/catalogos/turnos')
    ])
    cSedes.value = s; cAreas.value = a; cTurnos.value = t
  } catch { /* no crítico */ }
}

async function cargar() {
  loading.value = true; error.value = false
  try {
    data.value = await api('/api/stats/docentes-stats/dashboard' + query())
  } catch {
    error.value = true
    toast.add({ title: 'Error', description: 'No se pudo cargar el panel de docentes.', color: 'error' })
  } finally {
    loading.value = false
  }
}

const mediaC = computed(() => data.value?.bayes?.C != null ? Number(data.value.bayes.C) : null)
const kpis = computed(() => data.value?.kpis || {})
const pc = computed(() => data.value?.participacion_ciclo || null)
const rob = computed(() => data.value?.robustez_conteo || null)

async function exportarCurso() {
  if (!cursoSel.value) return
  try {
    await descargar('/api/stats/docentes-stats/export/curso.xlsx?curso=' + encodeURIComponent(cursoSel.value), `ranking-${cursoSel.value}.xlsx`)
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo generar el Excel.', color: 'error' })
  }
}

const rankItems = (rows: RankItem[] = [], useScore = false) =>
  (rows || []).map(r => ({
    label: r.etiqueta,
    value: Number(useScore && r.score != null ? r.score : r.promedio),
    sub: `${fmtNumero(r.participantes)} cal · ${fmtNumero(r.docentes)} doc`
  }))
const docItems = (rows: DocItem[] = []) =>
  (rows || []).map(r => ({ label: r.docente, value: Number(r.score), sub: `${fmtNumero(r.participantes)} · ${r.robustez}`, to: `/docentes/${r.id}` }))

const preguntaItems = computed(() => (data.value?.por_pregunta || []).map((r: any) => ({
  label: r.pregunta.length > 60 ? r.pregunta.slice(0, 58) + '…' : r.pregunta,
  value: Number(r.promedio),
  sub: `${fmtNumero(r.respuestas)} resp`
})))

const evolucion = computed(() => (data.value?.evolucion || []).map((d: any) => ({ fecha: d.dia, valor: Number(d.calificaciones) })))

async function exportarIntervenciones() {
  try {
    await descargar('/api/stats/docentes-stats/export/intervenciones.xlsx' + query(), 'intervenciones.xlsx')
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo generar el Excel.', color: 'error' })
  }
}

// Ranking de docentes por curso + heatmap (carga bajo demanda).
const cursoSel = ref('')
const cursoData = ref<any>(null)
const heatmapData = ref<any>(null)
const loadingCurso = ref(false)
const cursoOpts = computed(() => (data.value?.ranking_por_curso || []).map((r: any) => ({ label: r.etiqueta, value: r.etiqueta })).sort((a: any, b: any) => a.label.localeCompare(b.label, 'es')))
async function cargarCurso() {
  if (!cursoSel.value) { cursoData.value = null; heatmapData.value = null; return }
  loadingCurso.value = true
  try {
    const [c, h] = await Promise.all([
      api('/api/stats/docentes-stats/curso?curso=' + encodeURIComponent(cursoSel.value)),
      api('/api/stats/docentes-stats/heatmap?curso=' + encodeURIComponent(cursoSel.value))
    ])
    cursoData.value = c; heatmapData.value = h
  } catch {
    cursoData.value = null; heatmapData.value = null
  } finally { loadingCurso.value = false }
}
function heatColor(v: number | null) {
  if (v == null) return 'transparent'
  if (v >= 4.5) return '#10b981'
  if (v >= 4.0) return '#84cc16'
  if (v >= 3.5) return '#f59e0b'
  if (v >= 3.0) return '#f97316'
  return '#ef4444'
}
const cursoDocentes = computed(() => (cursoData.value?.docentes || []).map((d: any) => ({
  label: d.docente, value: Number(d.score), sub: `${fmtNumero(d.participantes)} · ${d.robustez}`, to: `/docentes/${d.id}`
})))

const distCumplimiento = computed(() => (data.value?.distribucion_cumplimiento || []).map((r: any) => ({ label: r.rango, value: Number(r.alumnos) })))
const distPromedios = computed(() => (data.value?.distribucion_promedios || []).map((r: any) => ({ label: r.rango, value: Number(r.docentes) })))

const pctBase = computed(() => Number(kpis.value.total_alumnos || 0))
const fmtPctLocal = (n: number, d: number) => d ? Math.round(100 * n / d) + '%' : '—'

// Pestañas para organizar el análisis (el resumen queda siempre visible arriba).
const tab = ref('docentes')
const tabItems = [
  { label: 'Ranking docentes', value: 'docentes', icon: 'i-lucide-trophy' },
  { label: 'Por dimensión', value: 'dimension', icon: 'i-lucide-shapes' },
  { label: 'Cobertura y participación', value: 'cobertura', icon: 'i-lucide-percent' },
  { label: 'Explorar por curso', value: 'curso', icon: 'i-lucide-book-open' }
]

onMounted(async () => { await cargarCatalogos(); await cargar() })
</script>

<template>
  <div class="p-4 lg:p-6 space-y-4">
    <!-- Header -->
    <div class="flex items-center gap-3">
      <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-400">
        <UIcon name="i-lucide-award" class="size-5" />
      </span>
      <div class="flex-1">
        <h2 class="text-lg font-black">Evaluación docente</h2>
        <p class="text-sm text-muted">Calidad docente percibida · score bayesiano anti-sesgo.</p>
      </div>
      <UButton to="/docentes/comparar" label="Comparar" icon="i-lucide-git-compare" color="neutral" variant="soft" size="sm" />
      <UButton label="Padrón Excel" icon="i-lucide-download" color="success" variant="soft" size="sm" :loading="exportando" @click="exportarPadron" />
    </div>

    <!-- Filtros -->
    <UCard :ui="{ body: 'p-3 sm:p-4' }">
      <div class="flex flex-wrap items-end gap-3">
        <UFormField label="Sede"><USelect v-model="fSede" :items="optSede" value-key="value" class="w-44" @change="cargar" /></UFormField>
        <UFormField label="Área"><USelect v-model="fArea" :items="optArea" value-key="value" class="w-40" @change="cargar" /></UFormField>
        <UFormField label="Turno"><USelect v-model="fTurno" :items="optTurno" value-key="value" class="w-36" @change="cargar" /></UFormField>
        <UFormField label="Confianza (robusta)"><USelect v-model="umbral" :items="umbralOpts" value-key="value" class="w-48" @change="cargar" /></UFormField>
        <UFormField label="Solo asistencia ≥80%">
          <USwitch v-model="soloValidas" @update:model-value="cargar" />
        </UFormField>
        <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" :loading="loading" aria-label="Recargar" @click="cargar" />
      </div>
      <div v-if="rob" class="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-default text-[11px]">
        <span class="font-bold text-muted">Confianza (umbral {{ umbral }}):</span>
        <span class="px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 font-bold">{{ fmtNumero(rob.robustos) }} robustas</span>
        <span class="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold">{{ fmtNumero(rob.referenciales) }} referenciales</span>
        <span class="px-2 py-0.5 rounded-full bg-red-500/10 text-red-600 dark:text-red-400 font-bold">{{ fmtNumero(rob.insuficientes) }} insuficientes</span>
        <span class="text-muted">de {{ fmtNumero(rob.total) }} docentes</span>
      </div>
    </UCard>

    <!-- Loading / Error -->
    <AcademicLoader v-if="loading" title="Cargando evaluación docente" subtitle="Calculando scores bayesianos y rankings." icon="i-lucide-award" />

    <div v-else-if="error" class="text-center py-16">
      <UIcon name="i-lucide-wifi-off" class="size-10 text-muted mx-auto mb-3" />
      <p class="text-sm text-muted mb-4">No se pudo cargar el panel.</p>
      <UButton label="Reintentar" icon="i-lucide-refresh-cw" @click="cargar" />
    </div>

    <template v-else-if="data">
      <!-- ===== RESUMEN (siempre visible) ===== -->
      <UCard v-if="pc" class="card-hover" :ui="{ body: 'p-4' }">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-users" class="size-5 text-sky-600 dark:text-sky-400" />
            <div>
              <p class="text-[10px] font-bold uppercase tracking-widest text-muted">Estudiantes que calificaron</p>
              <p class="text-2xl font-black">{{ fmtNumero(pc.calificaron) }} <span class="text-sm text-muted font-semibold">/ {{ fmtNumero(pc.total_inscritos) }} inscritos</span></p>
            </div>
          </div>
          <div class="text-right">
            <p class="text-[10px] font-bold uppercase tracking-widest text-red-500">No calificaron</p>
            <p class="text-xl font-black text-red-500">{{ fmtNumero(pc.no_calificaron) }} <span class="text-xs text-muted">({{ fmtPctLocal(pc.no_calificaron, pc.total_inscritos) }})</span></p>
          </div>
        </div>
        <div class="mt-3 h-2 w-full rounded-full bg-elevated overflow-hidden">
          <div class="h-full bg-sky-500 transition-all duration-700" :style="{ width: fmtPctLocal(pc.calificaron, pc.total_inscritos) }" />
        </div>
      </UCard>

      <div class="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard label="Alumnos que calificaron" :value="fmtNumero(kpis.total_alumnos)" icon="i-lucide-user-check" />
        <KpiCard label="Calificaron a todos" :value="fmtNumero(kpis.completos)" :hint="fmtPctLocal(kpis.completos, pctBase)" color="success" icon="i-lucide-check-check" />
        <KpiCard label="Calificaron a algunos" :value="fmtNumero(kpis.parciales)" :hint="fmtPctLocal(kpis.parciales, pctBase)" color="warning" icon="i-lucide-circle-dashed" />
        <KpiCard label="Docentes evaluados" :value="fmtNumero(kpis.docentes_evaluados)" color="primary" icon="i-lucide-graduation-cap" />
        <KpiCard label="Cobertura promedio" :value="(kpis.cobertura_global_pct || 0) + '%'" icon="i-lucide-gauge" />
      </div>

      <!-- ===== PESTAÑAS ===== -->
      <UTabs v-model="tab" :items="tabItems" class="w-full" :ui="{ list: 'overflow-x-auto' }" />

      <!-- TAB: Ranking docentes -->
      <div v-show="tab === 'docentes'" class="space-y-4">
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <UCard class="card-hover">
            <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-trophy" class="size-4 text-sky-600 dark:text-sky-400" />Mejores docentes (score corregido)</h3></template>
            <RankBars :items="docItems(data.top_docentes)" :media="mediaC" :min="3" />
            <p class="text-[10px] text-muted mt-3">Score bayesiano = (n·prom + m·C)/(n+m). Línea = media institucional ({{ mediaC?.toFixed(2) }}).</p>
          </UCard>
          <UCard class="card-hover">
            <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-triangle-alert" class="size-4 text-amber-500" />Docentes con menor puntaje</h3></template>
            <RankBars :items="docItems(data.bottom_docentes)" :media="mediaC" :min="3" />
            <p class="text-[10px] text-muted mt-3">Candidatos a acompañamiento pedagógico.</p>
          </UCard>
        </div>

        <UCard class="card-hover" :ui="{ body: 'p-0' }">
          <template #header>
            <div class="flex items-center justify-between gap-2">
              <h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-siren" class="size-4 text-red-500" />Intervenciones prioritarias</h3>
              <UButton label="Excel" icon="i-lucide-download" color="success" variant="ghost" size="xs" @click="exportarIntervenciones" />
            </div>
          </template>
          <p class="text-[10px] text-muted px-4 pt-3">Impacto = (media − score) × alumnos. Los más urgentes: bajo desempeño y muchos alumnos. Clic en una fila para ver la ficha.</p>
          <div class="overflow-x-auto max-h-96 overflow-y-auto mt-1">
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-elevated/80 backdrop-blur text-muted uppercase tracking-tight">
                <tr><th class="px-3 py-2 text-left font-bold">Docente</th><th class="px-3 py-2 text-right font-bold">Score</th><th class="px-3 py-2 text-right font-bold">Alumnos</th><th class="px-3 py-2 text-right font-bold">Impacto</th></tr>
              </thead>
              <tbody>
                <tr v-for="d in data.intervenciones" :key="d.id" class="border-b border-default hover:bg-elevated/40 cursor-pointer" @click="navigateTo(`/docentes/${d.id}`)">
                  <td class="px-3 py-1.5 font-medium truncate max-w-[220px]">{{ d.docente }}</td>
                  <td class="px-3 py-1.5 text-right font-mono font-bold text-red-500">{{ Number(d.score).toFixed(2) }}</td>
                  <td class="px-3 py-1.5 text-right font-mono">{{ fmtNumero(d.participantes) }}</td>
                  <td class="px-3 py-1.5 text-right font-mono font-bold text-amber-600 dark:text-amber-400">{{ fmtNumero(d.impacto) }}</td>
                </tr>
                <tr v-if="!data.intervenciones?.length"><td colspan="4" class="text-center py-6 text-muted">Sin intervenciones (todos sobre la media).</td></tr>
              </tbody>
            </table>
          </div>
        </UCard>
      </div>

      <!-- TAB: Por dimensión -->
      <div v-show="tab === 'dimension'" class="space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <UCard class="card-hover">
            <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-book-open" class="size-4 text-sky-600 dark:text-sky-400" />Promedio por curso</h3></template>
            <RankBars :items="rankItems(data.ranking_por_curso)" :media="mediaC" />
          </UCard>
          <UCard class="card-hover">
            <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-shapes" class="size-4 text-sky-600 dark:text-sky-400" />Promedio por área</h3></template>
            <RankBars :items="rankItems(data.ranking_por_area)" :media="mediaC" />
          </UCard>
          <UCard class="card-hover">
            <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-clock" class="size-4 text-sky-600 dark:text-sky-400" />Promedio por turno</h3></template>
            <RankBars :items="rankItems(data.ranking_por_turno)" :media="mediaC" />
          </UCard>
          <UCard class="card-hover">
            <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-map-pin" class="size-4 text-sky-600 dark:text-sky-400" />Promedio por sede (score ajustado)</h3></template>
            <RankBars :items="rankItems(data.ranking_por_sede, true)" :media="mediaC" />
            <p class="text-[10px] text-muted mt-3">Score ajustado por tamaño de muestra; participación marca representatividad.</p>
          </UCard>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <UCard class="card-hover">
            <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-list-checks" class="size-4 text-sky-600 dark:text-sky-400" />Promedio por pregunta</h3></template>
            <RankBars :items="preguntaItems" />
          </UCard>
          <UCard class="card-hover">
            <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-monitor" class="size-4 text-sky-600 dark:text-sky-400" />Por modalidad</h3></template>
            <div class="grid grid-cols-2 gap-3">
              <div v-for="m in data.por_modalidad" :key="m.modalidad" class="border border-default rounded-xl p-4">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-[10px] font-bold uppercase tracking-widest text-muted flex items-center gap-1">
                    <UIcon :name="m.modalidad === 'Virtual' ? 'i-lucide-video' : 'i-lucide-school'" class="size-3.5" />{{ m.modalidad }}
                  </span>
                  <span class="text-2xl font-black text-sky-600 dark:text-sky-400">{{ Number(m.promedio).toFixed(2) }}</span>
                </div>
                <p class="text-[11px] text-muted">{{ fmtNumero(m.docentes) }} docentes · {{ fmtNumero(m.calificaciones) }} cal.</p>
              </div>
            </div>
          </UCard>
        </div>

        <UCard class="card-hover" :ui="{ body: 'p-0' }">
          <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-git-fork" class="size-4 text-sky-600 dark:text-sky-400" />Varianza por curso (estandarización)</h3></template>
          <p class="text-[10px] text-muted px-4 pt-3">Cursos donde más varía la calidad entre docentes — candidatos a estandarizar.</p>
          <div class="overflow-x-auto max-h-80 overflow-y-auto mt-1">
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-elevated/80 backdrop-blur text-muted uppercase tracking-tight">
                <tr><th class="px-3 py-2 text-left font-bold">Curso</th><th class="px-3 py-2 text-right font-bold">Docentes</th><th class="px-3 py-2 text-right font-bold">Promedio</th><th class="px-3 py-2 text-right font-bold">σ</th><th class="px-3 py-2 text-right font-bold">Rango</th></tr>
              </thead>
              <tbody>
                <tr v-for="(c, i) in data.varianza_cursos" :key="i" class="border-b border-default hover:bg-elevated/40">
                  <td class="px-3 py-1.5 font-medium">{{ c.curso }}</td>
                  <td class="px-3 py-1.5 text-right font-mono">{{ fmtNumero(c.docentes) }}</td>
                  <td class="px-3 py-1.5 text-right font-mono">{{ c.promedio }}</td>
                  <td class="px-3 py-1.5 text-right font-mono font-bold">{{ c.desviacion }}</td>
                  <td class="px-3 py-1.5 text-right font-mono text-muted">{{ c.minimo }}–{{ c.maximo }}</td>
                </tr>
                <tr v-if="!data.varianza_cursos?.length"><td colspan="5" class="text-center py-6 text-muted">Sin datos.</td></tr>
              </tbody>
            </table>
          </div>
        </UCard>
      </div>

      <!-- TAB: Cobertura y participación -->
      <div v-show="tab === 'cobertura'" class="space-y-4">
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <UCard class="card-hover">
            <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-bar-chart-3" class="size-4 text-sky-600 dark:text-sky-400" />Distribución de cumplimiento (alumnos)</h3></template>
            <BarsChart :items="distCumplimiento" />
          </UCard>
          <UCard class="card-hover">
            <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-chart-column" class="size-4 text-sky-600 dark:text-sky-400" />Distribución de scores (docentes)</h3></template>
            <BarsChart :items="distPromedios" />
          </UCard>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <UCard class="card-hover">
            <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-percent" class="size-4 text-sky-600 dark:text-sky-400" />¿En qué sede calificaron más?</h3></template>
            <div class="space-y-1.5">
              <div v-for="s in data.cobertura_por_sede" :key="s.sede" class="flex items-center gap-3 text-xs">
                <span class="w-28 truncate shrink-0">{{ s.sede }}</span>
                <div class="flex-1 h-4 rounded bg-elevated overflow-hidden">
                  <div class="h-full rounded bg-gradient-to-r from-sky-500 to-sky-400" :style="{ width: (s.pct || 0) + '%' }" />
                </div>
                <span class="w-16 text-right font-mono font-bold shrink-0">{{ s.pct }}%</span>
              </div>
            </div>
          </UCard>

          <UCard class="card-hover" :ui="{ body: 'p-0' }">
            <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-octagon-alert" class="size-4 text-red-500" />Grupos en riesgo (menor cobertura)</h3></template>
            <div class="overflow-x-auto max-h-72 overflow-y-auto">
              <table class="w-full text-xs">
                <thead class="sticky top-0 bg-elevated/80 backdrop-blur">
                  <tr class="text-muted uppercase tracking-tight">
                    <th class="px-3 py-2 text-left font-bold">Grupo</th>
                    <th class="px-3 py-2 text-left font-bold">Área</th>
                    <th class="px-3 py-2 text-left font-bold">Sede</th>
                    <th class="px-3 py-2 text-right font-bold">Alumnos</th>
                    <th class="px-3 py-2 text-right font-bold">Cobertura</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(g, i) in data.grupos_riesgo" :key="i" class="border-b border-default hover:bg-elevated/40">
                    <td class="px-3 py-1.5 font-medium">{{ g.grupo }}</td>
                    <td class="px-3 py-1.5">{{ g.area }}</td>
                    <td class="px-3 py-1.5">{{ g.sede }}</td>
                    <td class="px-3 py-1.5 text-right font-mono">{{ fmtNumero(g.alumnos) }}</td>
                    <td class="px-3 py-1.5 text-right font-mono font-bold" :class="g.cobertura_pct < 50 ? 'text-red-500' : 'text-amber-500'">{{ g.cobertura_pct }}%</td>
                  </tr>
                  <tr v-if="!data.grupos_riesgo?.length"><td colspan="5" class="text-center py-6 text-muted">Sin grupos en riesgo.</td></tr>
                </tbody>
              </table>
            </div>
          </UCard>
        </div>

        <UCard class="card-hover">
          <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-trending-up" class="size-4 text-sky-600 dark:text-sky-400" />Calificaciones por día</h3></template>
          <ClientOnly>
            <TrendChart v-if="evolucion.length" :data="evolucion" />
            <p v-else class="text-sm text-muted py-8 text-center">Sin datos.</p>
            <template #fallback><div class="h-[220px]" /></template>
          </ClientOnly>
        </UCard>
      </div>

      <!-- TAB: Explorar por curso -->
      <div v-show="tab === 'curso'" class="space-y-4">
        <UCard class="card-hover">
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-list-ordered" class="size-4 text-sky-600 dark:text-sky-400" />Ranking de docentes por curso</h3>
              <div class="flex items-center gap-2">
                <USelectMenu
                  v-model="cursoSel"
                  :items="cursoOpts"
                  value-key="value"
                  placeholder="Selecciona un curso…"
                  class="w-64"
                  :search-input="{ placeholder: 'Buscar curso…' }"
                  @update:model-value="cargarCurso"
                />
                <UButton v-if="cursoSel" label="Excel" icon="i-lucide-download" color="success" variant="ghost" size="xs" @click="exportarCurso" />
              </div>
            </div>
          </template>
          <p class="text-[10px] text-muted mb-3">Score local al curso (se comparan contra la media del propio curso, no la institucional).</p>
          <AcademicLoader v-if="loadingCurso" title="Cargando ranking del curso" icon="i-lucide-list-ordered" />
          <template v-else-if="cursoDocentes.length">
            <RankBars :items="cursoDocentes" :min="3" />

            <!-- Heatmap docente × pregunta -->
            <div v-if="heatmapData?.docentes?.length" class="mt-5 pt-4 border-t border-default">
              <p class="text-[10px] font-bold uppercase tracking-widest text-muted mb-2">Heatmap docente × pregunta</p>
              <div class="overflow-x-auto">
                <table class="text-[10px] border-separate border-spacing-0.5">
                  <thead>
                    <tr>
                      <th class="text-left px-2 py-1 sticky left-0 bg-default z-10">Docente</th>
                      <th v-for="(p, pi) in heatmapData.preguntas" :key="p.id" class="px-1 py-1 text-center font-bold text-muted" :title="p.denominacion">P{{ pi + 1 }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="d in heatmapData.docentes" :key="d.id" class="hover:bg-elevated/30">
                      <td class="px-2 py-0.5 whitespace-nowrap max-w-[160px] truncate sticky left-0 bg-default z-10 cursor-pointer hover:text-sky-600" :title="d.nombre" @click="navigateTo(`/docentes/${d.id}`)">{{ d.nombre }}</td>
                      <td v-for="(v, vi) in d.valores" :key="vi" class="text-center font-mono font-bold text-white/90 rounded" :style="{ backgroundColor: heatColor(v), minWidth: '2rem' }" :title="v != null ? v.toFixed(2) : 'Sin datos'">{{ v != null ? v.toFixed(1) : '·' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="text-[10px] text-muted mt-2">P1–P{{ heatmapData.preguntas.length }} = criterios. Verde alto · rojo bajo. Clic en un docente para su ficha.</p>
            </div>
          </template>
          <p v-else class="text-sm text-muted text-center py-6">Selecciona un curso para ver el ranking de sus docentes.</p>
        </UCard>
      </div>
    </template>
  </div>
</template>
