<script setup lang="ts">
import { fmtNumero } from '~/utils/format'

interface Totales { total_inscritos: number; total_habilitados: number; total_sincronizados: number }
interface SedeRow { sede: string; total_inscritos: number; total_habilitados: number; total_sincronizados: number }
interface AreaRow { area: string; total_estudiantes: number; total_sincronizados: number; porcentaje_sincronizados: number }
interface Deuda { dni: string; apellidos_nombres: string; sede: string; area: string; turno: string; grupo: string; deuda_total: number }
interface Pend { sede: string; area: string; turno: string; grupo: string; total_no_habilitados_sin_deuda: number }
interface Detalle { dni: string; apellidos_nombres: string; total_tarifa: number; total_pagado: number; deuda_total: number }
interface Habilitacion { evento: 'habilitado' | 'deshabilitado'; por: string; fecha: string }
interface Buscado { matricula_id: number; dni: string; apellidos_nombres: string; habilitado: boolean; sincronizado: boolean; sede: string; area: string; turno: string; grupo: string; deuda_total: number; habilitacion: Habilitacion | null; historial: Habilitacion[] }

const { api } = useApi()
const toast = useToast()

const loading = ref(true)
const error = ref(false)
const totales = ref<Totales | null>(null)
const sedes = ref<SedeRow[]>([])
const areas = ref<AreaRow[]>([])
const conDeuda = ref<Deuda[]>([])
const pendientes = ref<Pend[]>([])
const pendTotal = ref(0)

async function cargar() {
  loading.value = true; error.value = false
  try {
    const [res, d, p] = await Promise.all([
      api<{ totales: Totales; sedes: SedeRow[]; areas: AreaRow[] }>('/api/stats/habilitados/resumen'),
      api<{ estudiantes: Deuda[] }>('/api/stats/habilitados/con-deuda'),
      api<{ data: Pend[]; total_general: number }>('/api/stats/habilitados/pendientes')
    ])
    totales.value = res.totales
    sedes.value = res.sedes || []
    areas.value = res.areas || []
    conDeuda.value = d.estudiantes || []
    pendientes.value = p.data || []
    pendTotal.value = p.total_general || 0
  } catch {
    error.value = true
    toast.add({ title: 'Error', description: 'No se pudo cargar habilitados.', color: 'error' })
  } finally {
    loading.value = false
  }
}

const pct = (a: number, b: number) => b > 0 ? Math.round(100 * a / b) + '%' : '—'
const money = (n: number) => 'S/ ' + Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
function fmtFecha(iso: string) {
  try {
    const dt = new Date(iso)
    return dt.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + dt.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

function descargarCSV(filas: (string | number)[][], nombre: string) {
  const csv = filas.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = nombre
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href)
}
function exportarCSV() {
  const head = ['DNI', 'Apellidos y Nombres', 'Sede', 'Área', 'Turno', 'Grupo', 'Deuda']
  const rows = conDeuda.value.map(e => [e.dni, e.apellidos_nombres, e.sede, e.area, e.turno, e.grupo, Number(e.deuda_total).toFixed(2)])
  descargarCSV([head, ...rows], 'habilitados-con-deuda.csv')
}

// ===== Buscador por DNI + constancia =====
const dni = ref('')
const buscando = ref(false)
const buscado = ref<Buscado | null>(null)
const buscarMsg = ref('')
const generando = ref(false)

async function buscarDni() {
  buscado.value = null; buscarMsg.value = ''
  if (!/^\d{6,12}$/.test(dni.value.trim())) { buscarMsg.value = 'Ingresa un DNI válido.'; return }
  buscando.value = true
  try {
    buscado.value = await api<Buscado>(`/api/stats/habilitados/buscar/${encodeURIComponent(dni.value.trim())}`)
  } catch (e: any) {
    const s = e?.response?.status ?? e?.status
    buscarMsg.value = s === 404 ? 'No se encontró estudiante con ese DNI.' : s === 403 ? 'Sin acceso a este alumno (otro grupo).' : 'Error al buscar.'
  } finally { buscando.value = false }
}
async function descargarConstancia() {
  if (!buscado.value) return
  generando.value = true
  try {
    const d = await api<{ pdf_url: string }>(`/api/stats/habilitados/constancia/${buscado.value.matricula_id}`)
    window.open(d.pdf_url, '_blank')
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo generar la constancia.', color: 'error' })
  } finally { generando.value = false }
}

// ===== Modal: detalle "pagaron completo" =====
const modalOpen = ref(false)
const grupoSel = ref<Pend | null>(null)
const detalle = ref<Detalle[]>([])
const cargandoDetalle = ref(false)

async function abrirDetalle(p: Pend) {
  grupoSel.value = p; modalOpen.value = true; detalle.value = []; cargandoDetalle.value = true
  try {
    const qs = new URLSearchParams({ sede: p.sede, area: p.area, turno: p.turno, grupo: p.grupo })
    const d = await api<{ estudiantes: Detalle[] }>(`/api/stats/habilitados/pendientes/detalle?${qs.toString()}`)
    detalle.value = d.estudiantes || []
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo cargar el detalle.', color: 'error' })
  } finally { cargandoDetalle.value = false }
}
function exportarDetalle() {
  if (!grupoSel.value) return
  const g = grupoSel.value
  const head = ['DNI', 'Apellidos y Nombres', 'Sede', 'Área', 'Turno', 'Grupo', 'Tarifa', 'Pagado']
  const rows = detalle.value.map(e => [e.dni, e.apellidos_nombres, g.sede, g.area, g.turno, g.grupo, Number(e.total_tarifa).toFixed(2), Number(e.total_pagado).toFixed(2)])
  descargarCSV([head, ...rows], `pagaron-completo_${g.grupo}.csv`)
}

onMounted(cargar)
</script>

<template>
  <div class="p-4 lg:p-6 space-y-4">
    <div class="flex items-center gap-3">
      <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <UIcon name="i-lucide-user-check" class="size-5" />
      </span>
      <div class="flex-1">
        <h2 class="text-lg font-black">Habilitados · Matrículas</h2>
        <p class="text-sm text-muted">Habilitado = matrícula con <code>habilitado='1'</code> · sincronizado = además <code>habilitado_estado='1'</code>.</p>
      </div>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" :loading="loading" aria-label="Recargar" @click="cargar" />
    </div>

    <!-- Buscador por DNI -->
    <UCard class="card-hover">
      <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-search" class="size-4 text-sky-600 dark:text-sky-400" />Buscar estudiante por DNI</h3></template>
      <div class="flex flex-wrap gap-2">
        <UInput v-model="dni" placeholder="DNI…" inputmode="numeric" class="flex-1 min-w-[180px]" @keydown.enter="buscarDni" />
        <UButton label="Buscar" icon="i-lucide-user-search" :loading="buscando" @click="buscarDni" />
      </div>
      <p v-if="buscarMsg" class="text-xs text-amber-600 dark:text-amber-400 mt-3">{{ buscarMsg }}</p>
      <div v-if="buscado" class="mt-4 rounded-xl border border-default p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="font-bold">{{ buscado.apellidos_nombres }}</p>
          <p class="text-xs text-muted">DNI {{ buscado.dni }} · {{ buscado.sede }} · {{ buscado.area }} · {{ buscado.turno }} · {{ buscado.grupo }}</p>
          <div class="flex items-center gap-2 mt-2 flex-wrap">
            <UBadge :color="buscado.habilitado ? 'success' : 'neutral'" variant="subtle" size="sm">{{ buscado.habilitado ? '✓ Habilitado' : '✗ No habilitado' }}</UBadge>
            <UBadge :color="buscado.sincronizado ? 'success' : 'neutral'" variant="subtle" size="sm">{{ buscado.sincronizado ? '✓ Sincronizado' : '✗ Sin sincronizar' }}</UBadge>
            <span class="text-xs" :class="buscado.deuda_total > 0 ? 'text-amber-600 dark:text-amber-400 font-bold' : 'text-emerald-600 dark:text-emerald-400'">{{ buscado.deuda_total > 0 ? 'Deuda ' + money(buscado.deuda_total) : 'Sin deuda' }}</span>
          </div>
          <p v-if="buscado.habilitacion" class="text-xs mt-1.5 flex items-center gap-1" :class="buscado.habilitacion.evento === 'habilitado' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'">
            <UIcon :name="buscado.habilitacion.evento === 'habilitado' ? 'i-lucide-check-circle' : 'i-lucide-x-circle'" class="size-3.5" />
            {{ buscado.habilitacion.evento === 'habilitado' ? 'Habilitado' : 'Deshabilitado' }} por <b>{{ buscado.habilitacion.por }}</b> · {{ fmtFecha(buscado.habilitacion.fecha) }}
          </p>
          <p v-else class="text-xs mt-1.5 text-muted flex items-center gap-1">
            <UIcon name="i-lucide-clock" class="size-3.5" />Pendiente de habilitación
          </p>
        </div>
        <div v-if="buscado.habilitado && buscado.sincronizado">
          <UButton label="Descargar constancia" icon="i-lucide-file-text" :loading="generando" @click="descargarConstancia" />
        </div>
        <div v-else class="text-right">
          <UButton label="Constancia no disponible" icon="i-lucide-lock" color="neutral" variant="subtle" disabled />
          <p class="text-[10px] text-amber-600 dark:text-amber-400 mt-1">Debe estar habilitado y sincronizado.</p>
        </div>
      </div>
      <div v-if="buscado && buscado.historial && buscado.historial.length > 1" class="mt-3 rounded-xl border border-default p-4">
        <h4 class="text-[11px] font-bold uppercase tracking-widest text-muted mb-2 flex items-center gap-1.5"><UIcon name="i-lucide-history" class="size-3.5" />Historial de habilitación ({{ buscado.historial.length }})</h4>
        <ul class="space-y-2 border-l-2 border-default pl-3">
          <li v-for="(e, i) in buscado.historial" :key="i" class="flex items-start gap-2">
            <span class="mt-1.5 size-2 shrink-0 rounded-full" :class="e.evento === 'habilitado' ? 'bg-emerald-500' : 'bg-red-500'" />
            <span class="text-xs"><b :class="e.evento === 'habilitado' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'">{{ e.evento === 'habilitado' ? 'Habilitado' : 'Deshabilitado' }}</b> por {{ e.por }} · <span class="text-muted">{{ fmtFecha(e.fecha) }}</span></span>
          </li>
        </ul>
      </div>
    </UCard>

    <AcademicLoader v-if="loading" title="Cargando habilitados" icon="i-lucide-user-check" />

    <div v-else-if="error" class="text-center py-16">
      <UIcon name="i-lucide-wifi-off" class="size-10 text-muted mx-auto mb-3" />
      <p class="text-sm text-muted mb-4">No se pudo cargar.</p>
      <UButton label="Reintentar" icon="i-lucide-refresh-cw" @click="cargar" />
    </div>

    <template v-else>
      <!-- KPIs -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard label="Matriculados" :value="fmtNumero(totales?.total_inscritos)" icon="i-lucide-users" />
        <KpiCard label="Habilitados" :value="fmtNumero(totales?.total_habilitados)" :hint="pct(totales?.total_habilitados || 0, totales?.total_inscritos || 0) + ' de matriculados'" color="success" icon="i-lucide-user-check" />
        <KpiCard label="Sincronizados" :value="fmtNumero(totales?.total_sincronizados)" :hint="pct(totales?.total_sincronizados || 0, totales?.total_habilitados || 0) + ' de habilitados'" color="primary" icon="i-lucide-refresh-ccw-dot" />
      </div>

      <!-- Por sede + Por área -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <UCard class="card-hover" :ui="{ body: 'p-0' }">
          <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-map-pin" class="size-4 text-sky-600 dark:text-sky-400" />Por sede</h3></template>
          <div class="overflow-x-auto max-h-80 overflow-y-auto">
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-elevated/80 backdrop-blur text-muted uppercase tracking-tight">
                <tr><th class="px-3 py-2 text-left font-bold">Sede</th><th class="px-3 py-2 text-right font-bold">Matric.</th><th class="px-3 py-2 text-right font-bold">Habil.</th><th class="px-3 py-2 text-right font-bold">Sincr.</th><th class="px-3 py-2 text-right font-bold">% Sinc.</th></tr>
              </thead>
              <tbody>
                <tr v-for="s in sedes" :key="s.sede" class="border-b border-default hover:bg-elevated/40">
                  <td class="px-3 py-1.5 font-medium">{{ s.sede }}</td>
                  <td class="px-3 py-1.5 text-right font-mono">{{ fmtNumero(s.total_inscritos) }}</td>
                  <td class="px-3 py-1.5 text-right font-mono font-bold text-emerald-600 dark:text-emerald-400">{{ fmtNumero(s.total_habilitados) }}</td>
                  <td class="px-3 py-1.5 text-right font-mono">{{ fmtNumero(s.total_sincronizados) }}</td>
                  <td class="px-3 py-1.5 text-right font-mono font-bold">{{ pct(s.total_sincronizados, s.total_inscritos) }}</td>
                </tr>
                <tr v-if="!sedes.length"><td colspan="5" class="text-center py-6 text-muted">Sin datos.</td></tr>
              </tbody>
            </table>
          </div>
        </UCard>

        <UCard class="card-hover" :ui="{ body: 'p-0' }">
          <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-shapes" class="size-4 text-sky-600 dark:text-sky-400" />Por área</h3></template>
          <div class="overflow-x-auto max-h-80 overflow-y-auto">
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-elevated/80 backdrop-blur text-muted uppercase tracking-tight">
                <tr><th class="px-3 py-2 text-left font-bold">Área</th><th class="px-3 py-2 text-right font-bold">Estud.</th><th class="px-3 py-2 text-right font-bold">Sincr.</th><th class="px-3 py-2 text-right font-bold">% Sinc.</th></tr>
              </thead>
              <tbody>
                <tr v-for="a in areas" :key="a.area" class="border-b border-default hover:bg-elevated/40">
                  <td class="px-3 py-1.5 font-medium">{{ a.area }}</td>
                  <td class="px-3 py-1.5 text-right font-mono">{{ fmtNumero(a.total_estudiantes) }}</td>
                  <td class="px-3 py-1.5 text-right font-mono font-bold text-emerald-600 dark:text-emerald-400">{{ fmtNumero(a.total_sincronizados) }}</td>
                  <td class="px-3 py-1.5 text-right font-mono font-bold">{{ a.porcentaje_sincronizados != null ? a.porcentaje_sincronizados + '%' : pct(a.total_sincronizados, a.total_estudiantes) }}</td>
                </tr>
                <tr v-if="!areas.length"><td colspan="4" class="text-center py-6 text-muted">Sin datos.</td></tr>
              </tbody>
            </table>
          </div>
        </UCard>
      </div>

      <!-- Habilitados con deuda -->
      <UCard class="card-hover" :ui="{ body: 'p-0' }">
        <template #header>
          <div class="flex items-center justify-between gap-2">
            <h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-wallet" class="size-4 text-amber-500" />Habilitados con deuda <span class="text-muted font-normal">({{ fmtNumero(conDeuda.length) }})</span></h3>
            <UButton v-if="conDeuda.length" label="CSV" icon="i-lucide-download" color="success" variant="ghost" size="xs" @click="exportarCSV" />
          </div>
        </template>
        <div class="overflow-x-auto max-h-[50vh] overflow-y-auto">
          <table class="w-full text-xs">
            <thead class="sticky top-0 bg-elevated/80 backdrop-blur text-muted uppercase tracking-tight">
              <tr><th class="px-3 py-2 text-left font-bold">DNI</th><th class="px-3 py-2 text-left font-bold">Apellidos y Nombres</th><th class="px-3 py-2 text-left font-bold">Sede</th><th class="px-3 py-2 text-left font-bold">Área</th><th class="px-3 py-2 text-left font-bold">Grupo</th><th class="px-3 py-2 text-right font-bold">Deuda</th></tr>
            </thead>
            <tbody>
              <tr v-for="(e, i) in conDeuda" :key="i" class="border-b border-default hover:bg-elevated/40">
                <td class="px-3 py-1.5 font-mono">{{ e.dni }}</td>
                <td class="px-3 py-1.5 font-medium whitespace-nowrap">{{ e.apellidos_nombres }}</td>
                <td class="px-3 py-1.5">{{ e.sede }}</td>
                <td class="px-3 py-1.5">{{ e.area }}</td>
                <td class="px-3 py-1.5">{{ e.grupo }}</td>
                <td class="px-3 py-1.5 text-right font-mono font-bold text-amber-600 dark:text-amber-400">{{ money(e.deuda_total) }}</td>
              </tr>
              <tr v-if="!conDeuda.length"><td colspan="6" class="text-center py-8 text-muted">No hay habilitados con deuda.</td></tr>
            </tbody>
          </table>
        </div>
      </UCard>

      <!-- Pendientes sin deuda (clic → detalle) -->
      <UCard class="card-hover" :ui="{ body: 'p-0' }">
        <template #header><h3 class="font-bold text-sm flex items-center gap-2"><UIcon name="i-lucide-clock" class="size-4 text-sky-600 dark:text-sky-400" />Pendientes sin deuda · pagaron completo <span class="text-muted font-normal">({{ fmtNumero(pendTotal) }} alumnos)</span></h3></template>
        <div class="overflow-x-auto max-h-[50vh] overflow-y-auto">
          <table class="w-full text-xs">
            <thead class="sticky top-0 bg-elevated/80 backdrop-blur text-muted uppercase tracking-tight">
              <tr><th class="px-3 py-2 text-left font-bold">Sede</th><th class="px-3 py-2 text-left font-bold">Área</th><th class="px-3 py-2 text-left font-bold">Turno</th><th class="px-3 py-2 text-left font-bold">Grupo</th><th class="px-3 py-2 text-right font-bold">Listos</th></tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in pendientes" :key="i" class="border-b border-default hover:bg-primary/5 cursor-pointer group" @click="abrirDetalle(p)">
                <td class="px-3 py-1.5">{{ p.sede }}</td><td class="px-3 py-1.5">{{ p.area }}</td>
                <td class="px-3 py-1.5">{{ p.turno }}</td>
                <td class="px-3 py-1.5 font-medium">{{ p.grupo }} <UIcon name="i-lucide-chevron-right" class="size-3.5 text-muted group-hover:text-primary align-middle" /></td>
                <td class="px-3 py-1.5 text-right font-mono font-bold text-sky-600 dark:text-sky-400">{{ fmtNumero(p.total_no_habilitados_sin_deuda) }}</td>
              </tr>
              <tr v-if="!pendientes.length"><td colspan="5" class="text-center py-8 text-muted">No hay pendientes sin deuda.</td></tr>
            </tbody>
          </table>
        </div>
      </UCard>
    </template>

    <!-- Modal detalle pagaron completo -->
    <UModal v-model:open="modalOpen" :title="grupoSel ? `${grupoSel.sede} · ${grupoSel.area} · ${grupoSel.turno} · ${grupoSel.grupo}` : ''" description="Pagaron completo · listos para habilitar" :ui="{ content: 'max-w-3xl' }">
      <template #body>
        <div class="flex justify-end mb-2">
          <UButton v-if="detalle.length" label="CSV" icon="i-lucide-download" color="success" variant="ghost" size="xs" @click="exportarDetalle" />
        </div>
        <AcademicLoader v-if="cargandoDetalle" title="Cargando detalle" icon="i-lucide-users" />
        <div v-else class="overflow-x-auto max-h-[60vh] overflow-y-auto rounded-lg border border-default">
          <table class="w-full text-xs">
            <thead class="sticky top-0 bg-elevated/80 backdrop-blur text-muted uppercase tracking-tight">
              <tr><th class="px-3 py-2 text-left font-bold">#</th><th class="px-3 py-2 text-left font-bold">DNI</th><th class="px-3 py-2 text-left font-bold">Apellidos y Nombres</th><th class="px-3 py-2 text-right font-bold">Tarifa</th><th class="px-3 py-2 text-right font-bold">Pagado</th></tr>
            </thead>
            <tbody>
              <tr v-for="(e, i) in detalle" :key="i" class="border-t border-default">
                <td class="px-3 py-1.5 text-muted font-mono">{{ i + 1 }}</td>
                <td class="px-3 py-1.5 font-mono">{{ e.dni }}</td>
                <td class="px-3 py-1.5 font-medium whitespace-nowrap">{{ e.apellidos_nombres }}</td>
                <td class="px-3 py-1.5 text-right font-mono">{{ money(e.total_tarifa) }}</td>
                <td class="px-3 py-1.5 text-right font-mono font-bold text-emerald-600 dark:text-emerald-400">{{ money(e.total_pagado) }}</td>
              </tr>
              <tr v-if="!detalle.length"><td colspan="5" class="text-center py-6 text-muted">Sin registros.</td></tr>
            </tbody>
          </table>
        </div>
      </template>
    </UModal>
  </div>
</template>
