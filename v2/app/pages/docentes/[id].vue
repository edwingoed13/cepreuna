<script setup lang="ts">
import { fmtNumero } from '~/utils/format'

const route = useRoute()
const { api, descargar } = useApi()
const toast = useToast()
const id = computed(() => route.params.id)

const loading = ref(true)
const error = ref(false)
const data = ref<any>(null)
const soloValidas = ref(false)
const exportando = ref(false)

async function exportarFicha() {
  exportando.value = true
  try {
    await descargar(`/api/stats/docentes-stats/export/ficha/${id.value}.xlsx`, `ficha-${doc.value?.dni || id.value}.xlsx`)
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo generar la ficha Excel.', color: 'error' })
  } finally {
    exportando.value = false
  }
}

async function cargar() {
  loading.value = true; error.value = false
  try {
    const qs = soloValidas.value ? '?solo_validas=1' : ''
    data.value = await api(`/api/stats/docentes-stats/docente/${id.value}${qs}`)
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

const doc = computed(() => data.value?.docente || {})
const res = computed(() => data.value?.resumen || {})
const pol = computed(() => data.value?.polarizacion || {})
const cons = computed(() => data.value?.consistencia || {})
const asis = computed(() => data.value?.asistencia || {})

function scoreColor(v: number | null) {
  if (v == null) return 'text-muted'
  if (v >= 4.5) return 'text-green-600 dark:text-green-400'
  if (v >= 4.0) return 'text-lime-600 dark:text-lime-400'
  if (v >= 3.5) return 'text-amber-500'
  if (v >= 3.0) return 'text-orange-500'
  return 'text-red-500'
}
const robustezColor: Record<string, string> = {
  robusta: 'bg-green-500/10 text-green-600 dark:text-green-400',
  referencial: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  insuficiente: 'bg-red-500/10 text-red-600 dark:text-red-400',
  sin_datos: 'bg-slate-500/10 text-slate-500'
}

const cargaColor = (v: number) => v >= 4.5 ? '#10b981' : v >= 4 ? '#84cc16' : v >= 3.5 ? '#f59e0b' : v >= 3 ? '#f97316' : '#ef4444'

onMounted(cargar)
watch(soloValidas, cargar)
</script>

<template>
  <div class="p-4 lg:p-6 space-y-4">
    <UButton to="/docentes" icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="sm" label="Volver al panel" />

    <AcademicLoader v-if="loading" title="Cargando ficha del docente" icon="i-lucide-user-round" />

    <div v-else-if="error" class="text-center py-16">
      <UIcon name="i-lucide-wifi-off" class="size-10 text-muted mx-auto mb-3" />
      <p class="text-sm text-muted mb-4">No se pudo cargar la ficha.</p>
      <UButton label="Reintentar" icon="i-lucide-refresh-cw" @click="cargar" />
    </div>

    <template v-else-if="data">
      <!-- Identidad -->
      <UCard>
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="flex items-start gap-4 min-w-0">
            <UAvatar :text="(doc.nombre || '?').charAt(0)" size="lg" :ui="{ root: 'bg-cepreuna-700 text-white' }" />
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h2 class="text-lg font-black">{{ doc.nombre }}</h2>
                <span class="text-[10px] font-bold px-2 py-0.5 rounded-full capitalize" :class="robustezColor[res.robustez] || ''">{{ res.robustez }}</span>
              </div>
              <p class="text-xs text-muted mt-0.5">
                DNI {{ doc.dni }} · {{ doc.vinculo }}<template v-if="doc.codigo_unap"> · UNAP {{ doc.codigo_unap }}</template>
              </p>
              <p class="text-xs text-muted">{{ doc.profesion || '—' }}<template v-if="doc.email"> · {{ doc.email }}</template></p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <UFormField label="Solo asistencia ≥80%">
              <USwitch v-model="soloValidas" />
            </UFormField>
            <UButton label="Ficha Excel" icon="i-lucide-download" color="success" variant="soft" size="sm" :loading="exportando" @click="exportarFicha" />
          </div>
        </div>
      </UCard>

      <!-- KPIs -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <UCard class="card-hover" :ui="{ body: 'p-4' }">
          <p class="text-[10px] font-bold uppercase tracking-widest text-muted mb-1">Puntaje corregido</p>
          <p class="text-3xl font-black" :class="scoreColor(res.score)">{{ res.score ?? '—' }}</p>
          <p class="text-[10px] text-muted mt-1">de 5 · media inst. {{ res.media_institucional }}</p>
        </UCard>
        <UCard class="card-hover" :ui="{ body: 'p-4' }">
          <p class="text-[10px] font-bold uppercase tracking-widest text-muted mb-1">Promedio crudo</p>
          <p class="text-3xl font-black">{{ res.promedio_crudo ?? '—' }}</p>
          <p class="text-[10px] text-muted mt-1">sin ajustar por muestra</p>
        </UCard>
        <KpiCard label="Calificaciones" :value="fmtNumero(res.participantes)" :hint="`${fmtNumero(res.cursos_distintos)} cursos · ${fmtNumero(res.grupos_distintos)} grupos`" color="primary" icon="i-lucide-users" />
        <UCard class="card-hover" :ui="{ body: 'p-4' }">
          <p class="text-[10px] font-bold uppercase tracking-widest text-muted mb-1">Posición ranking</p>
          <p class="text-3xl font-black text-cepreuna-700 dark:text-cepreuna-300">{{ res.posicion ? '#' + res.posicion : '—' }}</p>
          <p class="text-[10px] text-muted mt-1"><template v-if="res.total_ranking">de {{ fmtNumero(res.total_ranking) }} docentes</template><template v-else>n insuficiente</template></p>
        </UCard>
      </div>

      <!-- Cargas + Polarización -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <UCard class="card-hover" :ui="{ body: 'p-0' }">
          <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-layers" class="size-4 text-sky-600 dark:text-sky-400" />Cursos y grupos que enseña</h3></template>
          <div class="overflow-x-auto max-h-80 overflow-y-auto">
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-elevated/80 backdrop-blur text-muted uppercase tracking-tight">
                <tr><th class="px-3 py-2 text-left font-bold">Curso</th><th class="px-3 py-2 text-left font-bold">Grupo</th><th class="px-3 py-2 text-left font-bold">Sede</th><th class="px-3 py-2 text-right font-bold">Alumnos</th><th class="px-3 py-2 text-right font-bold">Prom.</th></tr>
              </thead>
              <tbody>
                <tr v-for="c in data.cargas" :key="c.id" class="border-b border-default hover:bg-elevated/40">
                  <td class="px-3 py-1.5 font-medium">{{ c.curso }}</td>
                  <td class="px-3 py-1.5">{{ c.grupo }}</td>
                  <td class="px-3 py-1.5">{{ c.sede }}</td>
                  <td class="px-3 py-1.5 text-right font-mono">{{ fmtNumero(c.participantes) }}</td>
                  <td class="px-3 py-1.5 text-right font-mono font-bold" :style="{ color: cargaColor(Number(c.promedio)) }">{{ Number(c.promedio).toFixed(2) }}</td>
                </tr>
                <tr v-if="!data.cargas?.length"><td colspan="5" class="text-center py-6 text-muted">Sin cargas.</td></tr>
              </tbody>
            </table>
          </div>
        </UCard>

        <UCard class="card-hover">
          <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-pie-chart" class="size-4 text-sky-600 dark:text-sky-400" />Polarización de respuestas</h3></template>
          <div class="space-y-3">
            <div class="grid grid-cols-4 gap-2 text-center">
              <div class="rounded-lg bg-green-500/10 p-2"><p class="text-lg font-black text-green-600 dark:text-green-400">{{ pol.pct_top ?? 0 }}%</p><p class="text-[9px] uppercase font-bold text-muted">Top (5)</p></div>
              <div class="rounded-lg bg-lime-500/10 p-2"><p class="text-lg font-black text-lime-600 dark:text-lime-400">{{ pol.pct_buena ?? 0 }}%</p><p class="text-[9px] uppercase font-bold text-muted">Buena (4)</p></div>
              <div class="rounded-lg bg-amber-500/10 p-2"><p class="text-lg font-black text-amber-600 dark:text-amber-400">{{ pol.pct_regular ?? 0 }}%</p><p class="text-[9px] uppercase font-bold text-muted">Regular (3)</p></div>
              <div class="rounded-lg bg-red-500/10 p-2"><p class="text-lg font-black text-red-600 dark:text-red-400">{{ pol.pct_critica ?? 0 }}%</p><p class="text-[9px] uppercase font-bold text-muted">Crítica (1-2)</p></div>
            </div>
            <p v-if="Number(pol.pct_critica) >= 5" class="text-[11px] text-amber-600 dark:text-amber-400 border-l-2 border-amber-400 pl-2">
              <b>{{ pol.pct_critica }}%</b> de respuestas críticas — hay polarización a revisar.
            </p>
            <div class="border-t border-default pt-3 mt-1">
              <p class="text-[10px] font-bold uppercase tracking-widest text-muted mb-1">Consistencia entre grupos</p>
              <p class="text-sm">σ = <b>{{ cons.desviacion ?? '—' }}</b> · rango {{ cons.min_grupo }}–{{ cons.max_grupo }} ({{ cons.n_grupos }} grupos)</p>
            </div>
          </div>
        </UCard>
      </div>

      <!-- Por pregunta -->
      <UCard class="card-hover">
        <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-list-checks" class="size-4 text-sky-600 dark:text-sky-400" />Desempeño por pregunta (vs media institucional)</h3></template>
        <div class="space-y-2">
          <div v-for="p in data.por_pregunta" :key="p.id" class="text-xs">
            <div class="flex items-center justify-between gap-2 mb-0.5">
              <span class="truncate" :title="p.pregunta">{{ p.pregunta }}</span>
              <span class="font-mono font-bold shrink-0" :style="{ color: cargaColor(Number(p.promedio_docente)) }">
                {{ Number(p.promedio_docente).toFixed(2) }}
                <span class="text-muted font-normal">vs {{ Number(p.promedio_global).toFixed(2) }}</span>
              </span>
            </div>
            <div class="h-2 rounded bg-elevated overflow-hidden">
              <div class="h-full rounded" :style="{ width: ((Number(p.promedio_docente) - 1) / 4 * 100) + '%', backgroundColor: cargaColor(Number(p.promedio_docente)) }" />
            </div>
          </div>
          <p v-if="!data.por_pregunta?.length" class="text-xs text-muted text-center py-3">Sin datos.</p>
        </div>
      </UCard>

      <!-- Asistencia + Modalidad -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <UCard class="card-hover">
          <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-calendar-check" class="size-4 text-sky-600 dark:text-sky-400" />Puntualidad y asistencia</h3></template>
          <div class="grid grid-cols-3 gap-2 text-center mb-3">
            <div class="rounded-lg bg-green-500/10 p-2"><p class="text-lg font-black text-green-600 dark:text-green-400">{{ asis.pct_presente ?? 0 }}%</p><p class="text-[9px] uppercase font-bold text-muted">Presente</p></div>
            <div class="rounded-lg bg-amber-500/10 p-2"><p class="text-lg font-black text-amber-600 dark:text-amber-400">{{ asis.pct_tarde ?? 0 }}%</p><p class="text-[9px] uppercase font-bold text-muted">Tarde</p></div>
            <div class="rounded-lg bg-red-500/10 p-2"><p class="text-lg font-black text-red-600 dark:text-red-400">{{ asis.pct_falta ?? 0 }}%</p><p class="text-[9px] uppercase font-bold text-muted">Falta</p></div>
          </div>
          <p class="text-[11px] text-muted">{{ fmtNumero(asis.total_sesiones) }} sesiones · {{ fmtNumero(asis.horas_dictadas) }} horas dictadas</p>
        </UCard>

        <UCard class="card-hover">
          <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-monitor" class="size-4 text-sky-600 dark:text-sky-400" />Por modalidad</h3></template>
          <div v-if="data.por_modalidad?.length" class="grid grid-cols-2 gap-3">
            <div v-for="m in data.por_modalidad" :key="m.modalidad" class="border border-default rounded-xl p-4">
              <div class="flex items-center justify-between mb-1">
                <span class="text-[10px] font-bold uppercase tracking-widest text-muted flex items-center gap-1">
                  <UIcon :name="m.modalidad === 'Virtual' ? 'i-lucide-video' : 'i-lucide-school'" class="size-3.5" />{{ m.modalidad }}
                </span>
                <span class="text-2xl font-black" :style="{ color: cargaColor(Number(m.promedio)) }">{{ Number(m.promedio).toFixed(2) }}</span>
              </div>
              <p class="text-[11px] text-muted">{{ fmtNumero(m.cargas) }} cargas · {{ fmtNumero(m.calificaciones) }} cal.</p>
            </div>
          </div>
          <p v-else class="text-sm text-muted text-center py-4">Sin datos de modalidad.</p>
        </UCard>
      </div>

      <!-- Observaciones -->
      <UCard class="card-hover" :ui="{ body: 'p-0' }">
        <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-message-square-text" class="size-4 text-sky-600 dark:text-sky-400" />Observaciones del auxiliar</h3></template>
        <div class="max-h-72 overflow-y-auto divide-y divide-default">
          <div v-for="o in data.observaciones" :key="o.id" class="px-4 py-2.5 text-xs">
            <p class="text-muted text-[10px] mb-0.5">{{ o.fecha }} · {{ o.curso }} · {{ o.grupo }}</p>
            <p>{{ o.texto }}</p>
          </div>
          <p v-if="!data.observaciones?.length" class="text-xs text-muted text-center py-6">Sin observaciones registradas.</p>
        </div>
      </UCard>
    </template>
  </div>
</template>
