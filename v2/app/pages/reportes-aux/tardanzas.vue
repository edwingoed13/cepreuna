<script setup lang="ts">
import { fmtNumero } from '~/utils/format'

interface CatSimple { id: number; denominacion: string }
interface Fila {
  docente_id: number; dni: string; docente: string
  sesiones_totales: number; presentes: number; tardanzas_total: number; faltas: number
  tardanzas_presencial: number; tardanzas_virtual: number
  hrs_desc_presencial: number; hrs_desc_virtual: number; horas_descuento_total: number
  horas_pago_presencial: number; horas_pago_virtual: number
}
interface Detalle {
  fecha: string; semana: number; sede: string; modalidad: string; area: string; turno: string
  grupo: string; curso: string; estado: string; horario: string; horas_pago: number
  coordinador: string | null; auxiliar: string | null; observacion: string | null
}

const { api, descargar } = useApi()
const toast = useToast()

const cSedes = ref<CatSimple[]>([]); const cTurnos = ref<CatSimple[]>([]); const cAreas = ref<CatSimple[]>([])
const selSedes = ref<number[]>([]); const selTurnos = ref<number[]>([]); const selAreas = ref<number[]>([])

function ymd(d: Date) { return d.toISOString().slice(0, 10) }
const hoy = new Date()
const desde = ref(ymd(new Date(hoy.getFullYear(), hoy.getMonth(), 1)))
const hasta = ref(ymd(hoy))

const filas = ref<Fila[]>([])
const semanaLabel = ref('')
const loading = ref(false)
const generado = ref(false)

// Orden de la tabla
const sortBy = ref<keyof Fila>('tardanzas_total')
const sortDir = ref<'asc' | 'desc'>('desc')
function ordenar(col: keyof Fila) {
  if (sortBy.value === col) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortBy.value = col; sortDir.value = 'desc' }
}
const filasOrdenadas = computed(() => {
  const arr = [...filas.value]
  const col = sortBy.value
  arr.sort((a, b) => {
    const va = a[col], vb = b[col]
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'es')
    return sortDir.value === 'asc' ? cmp : -cmp
  })
  return arr
})

// Modal de detalle
const modalOpen = ref(false)
const docenteSel = ref<Fila | null>(null)
const detalle = ref<Detalle[]>([])
const loadingDetalle = ref(false)

const itemsSedes = computed(() => cSedes.value.map(s => ({ label: s.denominacion, value: s.id })))
const itemsTurnos = computed(() => cTurnos.value.map(t => ({ label: t.denominacion, value: t.id })))
const itemsAreas = computed(() => cAreas.value.map(a => ({ label: a.denominacion, value: a.id })))

async function cargarCatalogos() {
  try {
    const [s, t, a] = await Promise.all([
      api<CatSimple[]>('/api/stats/catalogos/sedes'),
      api<CatSimple[]>('/api/stats/catalogos/turnos'),
      api<CatSimple[]>('/api/stats/catalogos/areas')
    ])
    cSedes.value = s; cTurnos.value = t; cAreas.value = a
  } catch { /* no crítico */ }
}

function queryString() {
  const p = new URLSearchParams()
  p.set('desde', desde.value); p.set('hasta', hasta.value)
  const csv = (arr: number[]) => arr.join(',')
  if (selSedes.value.length) p.set('sedes', csv(selSedes.value))
  if (selTurnos.value.length) p.set('turnos', csv(selTurnos.value))
  if (selAreas.value.length) p.set('areas', csv(selAreas.value))
  return '?' + p.toString()
}

async function generar() {
  if (!desde.value || !hasta.value) { toast.add({ title: 'Fechas requeridas', color: 'warning' }); return }
  loading.value = true
  try {
    const d = await api<{ filas: Fila[]; semana_label?: string }>('/api/stats/reportes-aux/tardanzas' + queryString())
    filas.value = d.filas || []
    semanaLabel.value = d.semana_label || ''
    generado.value = true
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo generar el reporte.', color: 'error' })
  } finally {
    loading.value = false
  }
}

async function exportar() {
  try {
    await descargar('/api/stats/reportes-aux/tardanzas/excel' + queryString(), `tardanzas_${desde.value}_a_${hasta.value}.xlsx`)
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo generar el Excel.', color: 'error' })
  }
}

async function abrirDetalle(f: Fila) {
  docenteSel.value = f
  modalOpen.value = true
  loadingDetalle.value = true
  detalle.value = []
  try {
    const p = new URLSearchParams({ docente_id: String(f.docente_id), desde: desde.value, hasta: hasta.value })
    const d = await api<{ filas: Detalle[] }>('/api/stats/reportes-aux/tardanzas/detalle?' + p.toString())
    detalle.value = d.filas || []
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo cargar el detalle.', color: 'error' })
  } finally {
    loadingDetalle.value = false
  }
}

function rango(tipo: 'semana' | 'mes' | 'ciclo') {
  if (tipo === 'semana') {
    const l = new Date(hoy); l.setDate(l.getDate() - ((l.getDay() + 6) % 7))
    desde.value = ymd(l); hasta.value = ymd(hoy)
  } else if (tipo === 'mes') {
    desde.value = ymd(new Date(hoy.getFullYear(), hoy.getMonth(), 1)); hasta.value = ymd(hoy)
  } else {
    api<{ min_fecha: string; max_fecha: string }>('/api/stats/reportes-aux/rango-fechas').then(r => {
      if (r.min_fecha) desde.value = r.min_fecha
      if (r.max_fecha) hasta.value = r.max_fecha
      generar()
    }).catch(() => {})
    return
  }
  generar()
}

const kpis = computed(() => {
  const f = filas.value
  return {
    docentes: f.length,
    tardanzas: f.reduce((a, r) => a + Number(r.tardanzas_total), 0),
    faltas: f.reduce((a, r) => a + Number(r.faltas), 0),
    horasDesc: f.reduce((a, r) => a + Number(r.horas_descuento_total), 0)
  }
})

const cols: { key: keyof Fila; label: string; num?: boolean }[] = [
  { key: 'dni', label: 'DNI' },
  { key: 'docente', label: 'Docente' },
  { key: 'tardanzas_total', label: 'Tardanzas', num: true },
  { key: 'tardanzas_presencial', label: 'Presencial', num: true },
  { key: 'tardanzas_virtual', label: 'Virtual', num: true },
  { key: 'faltas', label: 'Faltas', num: true },
  { key: 'horas_descuento_total', label: 'Hrs desc.', num: true }
]
const sortIcon = (k: keyof Fila) => sortBy.value !== k ? 'i-lucide-chevrons-up-down' : sortDir.value === 'asc' ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'

onMounted(cargarCatalogos)
</script>

<template>
  <div class="p-4 lg:p-6 space-y-4">
    <div class="flex items-center gap-3">
      <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <UIcon name="i-lucide-alarm-clock" class="size-5" />
      </span>
      <div>
        <h2 class="text-lg font-black">Tardanzas y faltas docentes</h2>
        <p class="text-sm text-muted">Resumen por docente con descuento por modalidad. Clic en una fila para el detalle por fecha.</p>
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
        <UButton label="Generar" icon="i-lucide-play" :loading="loading" @click="generar" />
        <UButton v-if="generado && filas.length" label="Excel" icon="i-lucide-download" color="success" variant="soft" size="sm" class="ml-auto" @click="exportar" />
      </div>
    </UCard>

    <AcademicLoader v-if="loading" title="Generando reporte de tardanzas" icon="i-lucide-alarm-clock" />

    <template v-else-if="generado">
      <!-- Semana del ciclo -->
      <div v-if="semanaLabel" class="flex flex-wrap items-center gap-2 text-sm">
        <UIcon name="i-lucide-calendar-range" class="size-4 text-amber-600 dark:text-amber-400" />
        <span class="font-bold">{{ semanaLabel }}</span>
        <span class="text-xs text-muted">{{ desde }} a {{ hasta }} · ciclo 23/03 – 10/07/2026 (16 semanas)</span>
      </div>

      <!-- KPIs -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Docentes con tardanzas" :value="fmtNumero(kpis.docentes)" color="warning" icon="i-lucide-users" />
        <KpiCard label="Tardanzas totales" :value="fmtNumero(kpis.tardanzas)" color="warning" icon="i-lucide-timer" />
        <KpiCard label="Faltas totales" :value="fmtNumero(kpis.faltas)" color="error" icon="i-lucide-calendar-x" />
        <KpiCard label="Horas de descuento" :value="fmtNumero(kpis.horasDesc)" color="primary" icon="i-lucide-minus-circle" />
      </div>

      <!-- Tabla resumen -->
      <UCard :ui="{ body: 'p-0' }">
        <div class="overflow-x-auto max-h-[65vh] overflow-y-auto">
          <table class="w-full text-xs">
            <thead class="sticky top-0 z-10">
              <tr class="text-muted uppercase tracking-tight">
                <th v-for="c in cols" :key="c.key"
                    class="px-3 py-2 font-bold cursor-pointer select-none whitespace-nowrap bg-elevated/80 backdrop-blur border-b border-default"
                    :class="[c.num ? 'text-right' : 'text-left', sortBy === c.key ? 'text-sky-600 dark:text-sky-400' : '']"
                    @click="ordenar(c.key)">
                  <span class="inline-flex items-center gap-1">{{ c.label }}<UIcon :name="sortIcon(c.key)" class="size-3" /></span>
                </th>
                <th class="px-3 py-2 bg-elevated/80 backdrop-blur border-b border-default" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in filasOrdenadas" :key="f.docente_id"
                  class="border-b border-default hover:bg-elevated/40 cursor-pointer group"
                  @click="abrirDetalle(f)">
                <td class="px-3 py-1.5 font-mono">{{ f.dni }}</td>
                <td class="px-3 py-1.5 font-medium whitespace-nowrap">{{ f.docente }}</td>
                <td class="px-3 py-1.5 text-right font-mono font-bold text-amber-600 dark:text-amber-400">{{ fmtNumero(f.tardanzas_total) }}</td>
                <td class="px-3 py-1.5 text-right font-mono">{{ fmtNumero(f.tardanzas_presencial) }}</td>
                <td class="px-3 py-1.5 text-right font-mono">{{ fmtNumero(f.tardanzas_virtual) }}</td>
                <td class="px-3 py-1.5 text-right font-mono" :class="f.faltas > 0 ? 'text-red-500 font-bold' : ''">{{ fmtNumero(f.faltas) }}</td>
                <td class="px-3 py-1.5 text-right font-mono font-bold">{{ fmtNumero(f.horas_descuento_total) }}</td>
                <td class="px-3 py-1.5 text-right"><UIcon name="i-lucide-chevron-right" class="size-4 text-dimmed group-hover:text-sky-600" /></td>
              </tr>
              <tr v-if="!filas.length"><td colspan="8" class="text-center py-10 text-muted">Sin tardanzas ni faltas en el rango.</td></tr>
            </tbody>
          </table>
        </div>
      </UCard>
    </template>

    <div v-else class="text-center py-16 text-muted">
      <UIcon name="i-lucide-sliders-horizontal" class="size-10 mx-auto mb-3 opacity-50" />
      <p class="text-sm">Ajusta el rango y pulsa <b>Generar</b>.</p>
    </div>

    <!-- ===== MODAL DETALLE ===== -->
    <UModal v-model:open="modalOpen" :ui="{ content: 'max-w-4xl' }">
      <template #content>
        <div class="p-5 space-y-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h3 class="font-bold text-lg leading-tight">{{ docenteSel?.docente }}</h3>
              <p class="text-xs text-muted">DNI {{ docenteSel?.dni }} · {{ desde }} a {{ hasta }}</p>
            </div>
            <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" @click="modalOpen = false" />
          </div>

          <!-- Resumen del docente -->
          <div v-if="docenteSel" class="grid grid-cols-3 sm:grid-cols-5 gap-2 text-center">
            <div class="rounded-lg bg-amber-500/10 p-2"><p class="text-lg font-black text-amber-600 dark:text-amber-400">{{ docenteSel.tardanzas_total }}</p><p class="text-[9px] uppercase font-bold text-muted">Tardanzas</p></div>
            <div class="rounded-lg bg-slate-500/10 p-2"><p class="text-lg font-black">{{ docenteSel.tardanzas_presencial }}</p><p class="text-[9px] uppercase font-bold text-muted">Presencial</p></div>
            <div class="rounded-lg bg-slate-500/10 p-2"><p class="text-lg font-black">{{ docenteSel.tardanzas_virtual }}</p><p class="text-[9px] uppercase font-bold text-muted">Virtual</p></div>
            <div class="rounded-lg bg-red-500/10 p-2"><p class="text-lg font-black text-red-500">{{ docenteSel.faltas }}</p><p class="text-[9px] uppercase font-bold text-muted">Faltas</p></div>
            <div class="rounded-lg bg-sky-500/10 p-2"><p class="text-lg font-black text-sky-600 dark:text-sky-400">{{ docenteSel.horas_descuento_total }}</p><p class="text-[9px] uppercase font-bold text-muted">Hrs desc.</p></div>
          </div>

          <AcademicLoader v-if="loadingDetalle" title="Cargando detalle" icon="i-lucide-alarm-clock" />

          <div v-else class="overflow-x-auto max-h-[55vh] overflow-y-auto rounded-lg border border-default">
            <table class="w-full text-[11px]">
              <thead class="sticky top-0 bg-elevated/90 backdrop-blur text-muted uppercase tracking-tight">
                <tr>
                  <th class="px-2 py-2 text-left font-bold">Fecha</th>
                  <th class="px-2 py-2 text-left font-bold">Sem.</th>
                  <th class="px-2 py-2 text-left font-bold">Estado</th>
                  <th class="px-2 py-2 text-left font-bold">Modalidad</th>
                  <th class="px-2 py-2 text-left font-bold">Curso · Grupo</th>
                  <th class="px-2 py-2 text-left font-bold">Sede · Turno</th>
                  <th class="px-2 py-2 text-left font-bold">Horario</th>
                  <th class="px-2 py-2 text-left font-bold">Coordinador / Auxiliar</th>
                  <th class="px-2 py-2 text-left font-bold">Observación</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in detalle" :key="i" class="border-b border-default hover:bg-elevated/40">
                  <td class="px-2 py-1.5 font-mono whitespace-nowrap">{{ r.fecha }}</td>
                  <td class="px-2 py-1.5 font-mono text-muted">S{{ r.semana }}</td>
                  <td class="px-2 py-1.5">
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-bold" :class="r.estado === 'falta' ? 'bg-red-500/15 text-red-600 dark:text-red-400' : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'">{{ r.estado }}</span>
                  </td>
                  <td class="px-2 py-1.5 capitalize">{{ r.modalidad }}</td>
                  <td class="px-2 py-1.5">{{ r.curso }} · <span class="text-muted">{{ r.grupo }}</span></td>
                  <td class="px-2 py-1.5">{{ r.sede }} · <span class="text-muted">{{ r.turno }}</span></td>
                  <td class="px-2 py-1.5 font-mono whitespace-nowrap">{{ r.horario }}</td>
                  <td class="px-2 py-1.5 max-w-[180px]">
                    <p class="truncate" :title="r.coordinador || ''">{{ r.coordinador || '—' }}</p>
                    <p class="truncate text-muted" :title="r.auxiliar || ''">{{ r.auxiliar || '—' }}</p>
                  </td>
                  <td class="px-2 py-1.5 max-w-[160px] truncate" :title="r.observacion || ''">{{ r.observacion || '—' }}</td>
                </tr>
                <tr v-if="!detalle.length"><td colspan="9" class="text-center py-6 text-muted">Sin registros.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
