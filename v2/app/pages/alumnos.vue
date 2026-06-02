<script setup lang="ts">
import { fmtNumero, fmtMoneda } from '~/utils/format'

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

// Filtros server-side
const dni = ref('')
const cuota1 = ref(''); const cuota2 = ref(''); const cuota3 = ref(''); const cuota4 = ref('')

const cuotaOpts = [
  { label: 'Todas', value: '' },
  { label: 'Pagada', value: '0' },
  { label: 'No pagada', value: '1' }
]

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
  try {
    const d = await api<{ registros: RegistroPago[] }>('/api/stats/reporte-pagos' + queryString())
    registros.value = d.registros || []
  } catch {
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
  const p = new URLSearchParams(queryString().replace(/^\?/, ''))
  if (tabla.gruposSel.value.size) p.set('grupos', [...tabla.gruposSel.value].join(','))
  const s = p.toString()
  try {
    await descargar('/api/stats/reporte-pagos/excel' + (s ? '?' + s : ''), 'reporte-pagos.xlsx')
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo generar el Excel.', color: 'error' })
  }
}

// Tabla compartida (grupos, orden, paginación). Orden por nombre completo y columnas.
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
  return { total: tabla.filtrados.value.length, pag, parc, sin }
})

function celda(estado: string, monto?: number, marca?: number) {
  const tipo = estado === 'PAGADA' ? 'completo' : estado === 'PARCIAL' ? 'parcial' : 'sin'
  const texto = monto != null && monto > 0 ? fmtMoneda(monto) : (estado === 'SIN_PAGAR' ? '—' : '')
  return { tipo: tipo as 'completo' | 'parcial' | 'sin', texto, marca: marca === 1 }
}

const cols = [
  { key: 'nro_documento', label: 'DNI' },
  { key: 'nombre', label: 'Apellidos y Nombres' },
  { key: 'sede', label: 'Sede' },
  { key: 'area', label: 'Área' },
  { key: 'turno', label: 'Turno' },
  { key: 'grupo', label: 'Grupo' },
  { key: 'tipo_colegio', label: 'Tipo Col.' }
]

onMounted(cargar)
</script>

<template>
  <div class="p-4 lg:p-6 space-y-4">
    <!-- KPIs -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard label="Total alumnos" :value="fmtNumero(kpis.total)" icon="i-lucide-users" />
      <KpiCard label="Cuotas pagadas" :value="fmtNumero(kpis.pag)" color="success" icon="i-lucide-check" />
      <KpiCard label="Cuotas parciales" :value="fmtNumero(kpis.parc)" color="warning" icon="i-lucide-circle-dashed" />
      <KpiCard label="Cuotas sin pagar" :value="fmtNumero(kpis.sin)" color="error" icon="i-lucide-x" />
    </div>

    <!-- Filtros -->
    <UCard :ui="{ body: 'p-3 sm:p-4' }">
      <div class="flex flex-wrap items-end gap-3">
        <UFormField label="DNI" class="flex-1 min-w-[160px]">
          <UInput v-model="dni" placeholder="Buscar por DNI…" icon="i-lucide-search" class="w-full" @keydown.enter="cargar" />
        </UFormField>
        <UFormField label="1ª">
          <USelectMenu v-model="cuota1" :items="cuotaOpts" value-key="value" class="w-28" />
        </UFormField>
        <UFormField label="2ª">
          <USelectMenu v-model="cuota2" :items="cuotaOpts" value-key="value" class="w-28" />
        </UFormField>
        <UFormField label="3ª">
          <USelectMenu v-model="cuota3" :items="cuotaOpts" value-key="value" class="w-28" />
        </UFormField>
        <UFormField label="4ª">
          <USelectMenu v-model="cuota4" :items="cuotaOpts" value-key="value" class="w-28" />
        </UFormField>
        <UButton label="Aplicar" icon="i-lucide-filter" :loading="loading" @click="cargar" />
        <UButton label="Limpiar" color="neutral" variant="outline" @click="limpiar" />
        <UButton label="Excel" icon="i-lucide-download" color="success" variant="outline" @click="exportar" />
      </div>
    </UCard>

    <!-- Panel de grupos -->
    <GruposFilter
      :grupos="tabla.gruposFiltradosPanel.value"
      :seleccionados="tabla.gruposSel.value"
      @toggle="tabla.toggleGrupo"
      @limpiar="tabla.limpiarGrupos"
      @update:busqueda="(v: string) => tabla.busquedaGrupo.value = v"
    />

    <!-- Tabla -->
    <UCard :ui="{ body: 'p-0 overflow-x-auto' }">
      <table class="w-full text-xs">
        <thead class="bg-elevated/50 text-muted uppercase tracking-tight">
          <tr>
            <th class="px-3 py-2 text-right font-bold w-12">N°</th>
            <th
              v-for="c in cols"
              :key="c.key"
              class="px-3 py-2 text-left font-bold cursor-pointer select-none whitespace-nowrap"
              @click="tabla.ordenar(c.key)"
            >
              <span class="inline-flex items-center gap-1">{{ c.label }}<UIcon :name="tabla.sortIcon(c.key)" class="size-3" /></span>
            </th>
            <th
              v-for="(lbl, i) in ['1ra', '2da', '3ra', '4ta']"
              :key="i"
              class="px-2 py-2 text-center font-bold cursor-pointer select-none"
              @click="tabla.ordenar(`c${i + 1}`)"
            >
              <span class="inline-flex items-center gap-1">{{ lbl }}<UIcon :name="tabla.sortIcon(`c${i + 1}`)" class="size-3" /></span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-if="loading">
            <td colspan="12" class="text-center py-10 text-muted">Cargando…</td>
          </tr>
          <tr v-else-if="!tabla.visibles.value.length">
            <td colspan="12" class="text-center py-10 text-muted">Sin resultados.</td>
          </tr>
          <tr v-for="(r, idx) in tabla.visibles.value" v-else :key="idx" class="hover:bg-elevated/40">
            <td class="px-3 py-1.5 text-right font-mono text-muted">{{ tabla.offset.value + idx + 1 }}</td>
            <td class="px-3 py-1.5 font-mono">{{ r.nro_documento }}</td>
            <td class="px-3 py-1.5 font-medium whitespace-nowrap">{{ r.paterno }} {{ r.materno }} {{ r.nombres }}</td>
            <td class="px-3 py-1.5">{{ r.sede }}</td>
            <td class="px-3 py-1.5">{{ r.area }}</td>
            <td class="px-3 py-1.5">{{ r.turno }}</td>
            <td class="px-3 py-1.5">{{ r.grupo }}</td>
            <td class="px-3 py-1.5">{{ r.tipo_colegio }}</td>
            <td class="px-1 py-1"><EstadoCelda v-bind="celda(r.estado_cuota1, r.primera_mensualidad, r.cambio_mod_1)" /></td>
            <td class="px-1 py-1"><EstadoCelda v-bind="celda(r.estado_cuota2, r.segunda_mensualidad, r.cambio_mod_2)" /></td>
            <td class="px-1 py-1"><EstadoCelda v-bind="celda(r.estado_cuota3, r.tercera_mensualidad, r.cambio_mod_3)" /></td>
            <td class="px-1 py-1"><EstadoCelda v-bind="celda(r.estado_cuota4, r.cuarta_mensualidad, r.cambio_mod_4)" /></td>
          </tr>
        </tbody>
      </table>
    </UCard>

    <!-- Paginación -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-xs text-muted">{{ fmtNumero(tabla.totalFiltrado.value) }} registros</p>
      <div class="flex items-center gap-3">
        <USelectMenu
          v-model="tabla.pageSize.value"
          :items="[25, 50, 100, 250]"
          class="w-24"
        />
        <UPagination
          v-model:page="tabla.page.value"
          :total="tabla.totalFiltrado.value"
          :items-per-page="tabla.pageSize.value"
        />
      </div>
    </div>
  </div>
</template>
