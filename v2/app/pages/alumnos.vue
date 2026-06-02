<script setup lang="ts">
import { fmtNumero, fmtMoneda, fmtPct } from '~/utils/format'

interface RegistroPago {
  nro_documento: string
  paterno: string; materno: string; nombres: string
  sede: string; sede_aula?: string; area: string; turno: string; grupo: string
  grupo_aulas_id: number | string | null
  tipo_colegio: string
  estado_cuota1: string; estado_cuota2: string; estado_cuota3: string; estado_cuota4: string
  primera_mensualidad?: number; segunda_mensualidad?: number; tercera_mensualidad?: number; cuarta_mensualidad?: number
  cambio_mod_1?: number; cambio_mod_2?: number; cambio_mod_3?: number; cambio_mod_4?: number
}

const { api, descargar } = useApi()
const toast = useToast()

const registros = ref<RegistroPago[]>([])
const loading = ref(false)
const error = ref(false)
const exportando = ref(false)

// Filtros server-side
const dni = ref('')
const cuota1 = ref(''); const cuota2 = ref(''); const cuota3 = ref(''); const cuota4 = ref('')

const cuotaOpts = [
  { label: 'Todas', value: '' },
  { label: '✓ Pagada', value: '0' },
  { label: '✗ No pagada', value: '1' }
]

const filtrosActivos = computed(() =>
  [dni.value.trim(), cuota1.value, cuota2.value, cuota3.value, cuota4.value].filter(Boolean).length)

function queryString() {
  const p = new URLSearchParams()
  if (dni.value.trim()) p.set('q', dni.value.trim())
  if (cuota1.value) p.set('cuota1', cuota1.value)
  if (cuota2.value) p.set('cuota2', cuota2.value)
  if (cuota3.value) p.set('cuota3', cuota3.value)
  if (cuota4.value) p.set('cuota4', cuota4.value)
  const s = p.toString()
  return s ? '?' + s : ''
}

async function cargar() {
  loading.value = true
  error.value = false
  try {
    const d = await api<{ registros: RegistroPago[] }>('/api/stats/reporte-pagos' + queryString())
    registros.value = d.registros || []
  } catch {
    error.value = true
    toast.add({ title: 'Error', description: 'No se pudo cargar el reporte de pagos.', color: 'error' })
  } finally {
    loading.value = false
  }
}

function limpiar() {
  dni.value = ''; cuota1.value = ''; cuota2.value = ''; cuota3.value = ''; cuota4.value = ''
  cargar()
}

async function exportar() {
  exportando.value = true
  const p = new URLSearchParams(queryString().replace(/^\?/, ''))
  if (tabla.gruposSel.value.size) p.set('grupos', [...tabla.gruposSel.value].join(','))
  const s = p.toString()
  try {
    await descargar('/api/stats/reporte-pagos/excel' + (s ? '?' + s : ''), 'reporte-pagos.xlsx')
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo generar el Excel.', color: 'error' })
  } finally {
    exportando.value = false
  }
}

const nombre = (r: RegistroPago) => `${r.paterno} ${r.materno} ${r.nombres}`
const tabla = useTablaAlumnos<RegistroPago>(registros, {
  sortAccessors: {
    nro_documento: r => r.nro_documento,
    nombre, sede: r => r.sede, area: r => r.area, turno: r => r.turno,
    grupo: r => r.grupo, tipo_colegio: r => r.tipo_colegio,
    c1: r => r.estado_cuota1, c2: r => r.estado_cuota2, c3: r => r.estado_cuota3, c4: r => r.estado_cuota4
  }
})

// KPIs: cuentan celdas de cuota por estado sobre los registros filtrados.
const kpis = computed(() => {
  let pag = 0, parc = 0, sin = 0
  for (const r of tabla.filtrados.value) {
    for (const e of [r.estado_cuota1, r.estado_cuota2, r.estado_cuota3, r.estado_cuota4]) {
      if (e === 'PAGADA') pag++
      else if (e === 'PARCIAL') parc++
      else if (e === 'SIN_PAGAR') sin++
    }
  }
  const totalCuotas = pag + parc + sin
  return { total: tabla.filtrados.value.length, pag, parc, sin, totalCuotas }
})

function celda(estado: string, monto?: number, marca?: number) {
  const tipo = estado === 'PAGADA' ? 'completo' : estado === 'PARCIAL' ? 'parcial' : 'sin'
  const texto = monto != null && monto > 0 ? fmtMoneda(monto) : (estado === 'SIN_PAGAR' ? '—' : '')
  return { tipo: tipo as 'completo' | 'parcial' | 'sin', texto, marca: marca === 1 }
}

const cols = [
  { key: 'nro_documento', label: 'DNI', sticky: true },
  { key: 'nombre', label: 'Apellidos y Nombres', sticky: true },
  { key: 'sede', label: 'Sede' },
  { key: 'area', label: 'Área' },
  { key: 'turno', label: 'Turno' },
  { key: 'grupo', label: 'Grupo' },
  { key: 'tipo_colegio', label: 'Tipo Col.' }
]

const sortActive = (key: string) => tabla.sortBy.value === key

onMounted(cargar)
</script>

<template>
  <div class="p-4 lg:p-6 space-y-4">
    <!-- KPIs -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard label="Alumnos" :value="fmtNumero(kpis.total)" icon="i-lucide-users" />
      <KpiCard label="Cuotas pagadas" :value="fmtNumero(kpis.pag)" :hint="fmtPct(kpis.pag, kpis.totalCuotas) + ' de cuotas'" color="success" icon="i-lucide-check" />
      <KpiCard label="Cuotas parciales" :value="fmtNumero(kpis.parc)" :hint="fmtPct(kpis.parc, kpis.totalCuotas) + ' de cuotas'" color="warning" icon="i-lucide-circle-dashed" />
      <KpiCard label="Cuotas sin pagar" :value="fmtNumero(kpis.sin)" :hint="fmtPct(kpis.sin, kpis.totalCuotas) + ' de cuotas'" color="error" icon="i-lucide-x" />
    </div>

    <!-- Filtros -->
    <UCard :ui="{ body: 'p-3 sm:p-4' }">
      <div class="flex flex-wrap items-end gap-3">
        <UFormField label="Buscar DNI" class="flex-1 min-w-[180px]">
          <UInput v-model="dni" placeholder="DNI + Enter…" icon="i-lucide-search" class="w-full" @keydown.enter="cargar" />
        </UFormField>
        <UFormField label="1ª cuota"><USelectMenu v-model="cuota1" :items="cuotaOpts" value-key="value" class="w-32" /></UFormField>
        <UFormField label="2ª cuota"><USelectMenu v-model="cuota2" :items="cuotaOpts" value-key="value" class="w-32" /></UFormField>
        <UFormField label="3ª cuota"><USelectMenu v-model="cuota3" :items="cuotaOpts" value-key="value" class="w-32" /></UFormField>
        <UFormField label="4ª cuota"><USelectMenu v-model="cuota4" :items="cuotaOpts" value-key="value" class="w-32" /></UFormField>
        <UButton label="Aplicar" icon="i-lucide-filter" :loading="loading" @click="cargar" />
        <UButton v-if="filtrosActivos" label="Limpiar" color="neutral" variant="ghost" icon="i-lucide-x" @click="limpiar" />
      </div>
      <p v-if="filtrosActivos" class="text-[11px] text-amber-600 dark:text-amber-400 mt-2 flex items-center gap-1">
        <UIcon name="i-lucide-filter" class="size-3" />{{ filtrosActivos }} filtro{{ filtrosActivos === 1 ? '' : 's' }} activo{{ filtrosActivos === 1 ? '' : 's' }}
      </p>
    </UCard>

    <!-- Panel de grupos (colapsable) -->
    <GruposFilter
      :grupos="tabla.gruposFiltradosPanel.value"
      :seleccionados="tabla.gruposSel.value"
      @toggle="tabla.toggleGrupo"
      @limpiar="tabla.limpiarGrupos"
      @update:busqueda="(v: string) => tabla.busquedaGrupo.value = v"
    />

    <!-- Tabla -->
    <UCard :ui="{ header: 'p-3 sm:px-4', body: 'p-0' }">
      <template #header>
        <div class="flex items-center justify-between gap-2">
          <h3 class="font-bold text-sm flex items-center gap-2">
            <UIcon name="i-lucide-table" class="size-4 text-cepreuna-600" />
            Reporte de pagos
            <span class="text-muted font-normal">· {{ fmtNumero(tabla.totalFiltrado.value) }}</span>
          </h3>
          <UButton label="Excel" icon="i-lucide-download" color="success" variant="soft" size="sm" :loading="exportando" @click="exportar" />
        </div>
      </template>

      <div class="overflow-x-auto max-h-[70vh] overflow-y-auto">
        <table class="w-full text-xs border-separate border-spacing-0">
          <thead class="sticky top-0 z-10 bg-default">
            <tr class="text-muted uppercase tracking-tight">
              <th class="px-3 py-2 text-right font-bold w-12 bg-elevated/80 backdrop-blur border-b border-default sticky left-0 z-20">N°</th>
              <th
                v-for="(c, ci) in cols"
                :key="c.key"
                class="px-3 py-2 text-left font-bold cursor-pointer select-none whitespace-nowrap bg-elevated/80 backdrop-blur border-b border-default"
                :class="[c.sticky ? 'sticky z-20' : '', c.sticky && ci === 0 ? 'left-12' : '', sortActive(c.key) ? 'text-cepreuna-600' : '']"
                :style="c.sticky && ci === 1 ? 'left: 7.5rem' : ''"
                @click="tabla.ordenar(c.key)"
              >
                <span class="inline-flex items-center gap-1">{{ c.label }}<UIcon :name="tabla.sortIcon(c.key)" class="size-3" /></span>
              </th>
              <th
                v-for="(lbl, i) in ['1ra', '2da', '3ra', '4ta']"
                :key="i"
                class="px-2 py-2 text-center font-bold cursor-pointer select-none bg-elevated/80 backdrop-blur border-b border-default"
                :class="sortActive(`c${i + 1}`) ? 'text-cepreuna-600' : ''"
                @click="tabla.ordenar(`c${i + 1}`)"
              >
                <span class="inline-flex items-center gap-1">{{ lbl }}<UIcon :name="tabla.sortIcon(`c${i + 1}`)" class="size-3" /></span>
              </th>
            </tr>
          </thead>
          <tbody>
            <!-- Skeleton -->
            <template v-if="loading">
              <tr v-for="n in 8" :key="'sk' + n" class="border-b border-default">
                <td v-for="c in 12" :key="c" class="px-3 py-2"><div class="h-3 rounded bg-elevated animate-pulse" /></td>
              </tr>
            </template>
            <!-- Error -->
            <tr v-else-if="error">
              <td colspan="12" class="text-center py-12">
                <UIcon name="i-lucide-wifi-off" class="size-8 text-muted mx-auto mb-2" />
                <p class="text-sm text-muted mb-3">No se pudo cargar el reporte.</p>
                <UButton label="Reintentar" icon="i-lucide-refresh-cw" size="sm" @click="cargar" />
              </td>
            </tr>
            <!-- Vacío -->
            <tr v-else-if="!tabla.visibles.value.length">
              <td colspan="12" class="text-center py-12 text-muted">
                <UIcon name="i-lucide-search-x" class="size-8 mx-auto mb-2 opacity-50" />
                <p class="text-sm">Sin resultados.</p>
              </td>
            </tr>
            <!-- Filas -->
            <tr v-for="(r, idx) in tabla.visibles.value" v-else :key="idx" class="border-b border-default hover:bg-elevated/40 group">
              <td class="px-3 py-1.5 text-right font-mono text-muted sticky left-0 bg-default group-hover:bg-elevated/40 z-10">{{ tabla.offset.value + idx + 1 }}</td>
              <td class="px-3 py-1.5 font-mono sticky left-12 bg-default group-hover:bg-elevated/40 z-10">{{ r.nro_documento }}</td>
              <td class="px-3 py-1.5 font-medium whitespace-nowrap sticky bg-default group-hover:bg-elevated/40 z-10" style="left: 7.5rem">{{ r.paterno }} {{ r.materno }} {{ r.nombres }}</td>
              <td class="px-3 py-1.5">{{ r.sede }}</td>
              <td class="px-3 py-1.5">{{ r.area }}</td>
              <td class="px-3 py-1.5">{{ r.turno }}</td>
              <td class="px-3 py-1.5">{{ r.grupo }}</td>
              <td class="px-3 py-1.5">{{ r.tipo_colegio }}</td>
              <td class="px-1.5 py-1"><EstadoCelda v-bind="celda(r.estado_cuota1, r.primera_mensualidad, r.cambio_mod_1)" /></td>
              <td class="px-1.5 py-1"><EstadoCelda v-bind="celda(r.estado_cuota2, r.segunda_mensualidad, r.cambio_mod_2)" /></td>
              <td class="px-1.5 py-1"><EstadoCelda v-bind="celda(r.estado_cuota3, r.tercera_mensualidad, r.cambio_mod_3)" /></td>
              <td class="px-1.5 py-1"><EstadoCelda v-bind="celda(r.estado_cuota4, r.cuarta_mensualidad, r.cambio_mod_4)" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <!-- Paginación -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2 text-xs text-muted">
        <span>{{ fmtNumero(tabla.totalFiltrado.value) }} registros</span>
        <USelectMenu v-model="tabla.pageSize.value" :items="[25, 50, 100, 250]" size="xs" class="w-20" />
        <span>por página</span>
      </div>
      <UPagination
        v-model:page="tabla.page.value"
        :total="tabla.totalFiltrado.value"
        :items-per-page="tabla.pageSize.value"
        :sibling-count="1"
      />
    </div>
  </div>
</template>
