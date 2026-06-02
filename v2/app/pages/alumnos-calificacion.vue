<script setup lang="ts">
import { fmtNumero } from '~/utils/format'
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

// DNI: server-side. Estado: client-side.
const dni = ref('')
const estado = ref<'' | 'completo' | 'parcial' | 'sin'>('')

const estadoOpts = [
  { label: 'Todos', value: '' },
  { label: 'Completa', value: 'completo' },
  { label: 'Parcial', value: 'parcial' },
  { label: 'Sin calificar', value: 'sin' }
]

async function cargar() {
  loading.value = true
  try {
    const qs = dni.value.trim() ? '?q=' + encodeURIComponent(dni.value.trim()) : ''
    const d = await api<{ registros: RegistroCalif[] }>('/api/stats/calificaciones' + qs)
    registros.value = d.registros || []
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo cargar las calificaciones.', color: 'error' })
  } finally {
    loading.value = false
  }
}

function limpiar() {
  dni.value = ''; estado.value = ''
  cargar()
}

function clasif(r: RegistroCalif) {
  return estadoCalificacion(Number(r.docentes_calificados) || 0, Number(r.total_docentes) || 0)
}

// Tabla compartida con filtro de estado client-side y orden (incl. por ratio en calificación).
const tabla = useTablaAlumnos<RegistroCalif>(registros, {
  extraFilter: (r) => {
    if (!estado.value) return true
    return clasif(r).tipo === estado.value
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

// Reset de página cuando cambia el filtro de estado.
watch(estado, () => { tabla.page.value = 1 })

// KPIs (excluye 'nada' de "sin calificar").
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
  const tooltip = c.tipo === 'parcial' && r.cursos_faltantes
    ? 'Le falta calificar: ' + r.cursos_faltantes
    : undefined
  return { tipo: c.tipo, texto, tooltip }
}

const cols = [
  { key: 'nro_documento', label: 'DNI' },
  { key: 'nombre', label: 'Apellidos y Nombres' },
  { key: 'sede', label: 'Sede' },
  { key: 'area', label: 'Área' },
  { key: 'turno', label: 'Turno' },
  { key: 'grupo', label: 'Grupo' }
]

onMounted(cargar)
</script>

<template>
  <div class="p-4 lg:p-6 space-y-4">
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard label="Total alumnos" :value="fmtNumero(kpis.total)" icon="i-lucide-users" />
      <KpiCard label="Calificación completa" :value="fmtNumero(kpis.comp)" color="success" icon="i-lucide-check" />
      <KpiCard label="Calificación parcial" :value="fmtNumero(kpis.parc)" color="warning" icon="i-lucide-circle-dashed" />
      <KpiCard label="Sin calificar" :value="fmtNumero(kpis.sin)" color="error" icon="i-lucide-x" />
    </div>

    <UCard :ui="{ body: 'p-3 sm:p-4' }">
      <div class="flex flex-wrap items-end gap-3">
        <UFormField label="DNI" class="flex-1 min-w-[160px]">
          <UInput v-model="dni" placeholder="Buscar por DNI…" icon="i-lucide-search" class="w-full" @keydown.enter="cargar" />
        </UFormField>
        <UFormField label="Estado">
          <USelectMenu v-model="estado" :items="estadoOpts" value-key="value" class="w-40" />
        </UFormField>
        <UButton label="Aplicar" icon="i-lucide-filter" :loading="loading" @click="cargar" />
        <UButton label="Limpiar" color="neutral" variant="outline" @click="limpiar" />
      </div>
    </UCard>

    <GruposFilter
      :grupos="tabla.gruposFiltradosPanel.value"
      :seleccionados="tabla.gruposSel.value"
      @toggle="tabla.toggleGrupo"
      @limpiar="tabla.limpiarGrupos"
      @update:busqueda="(v: string) => tabla.busquedaGrupo.value = v"
    />

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
            <th class="px-3 py-2 text-center font-bold cursor-pointer select-none" @click="tabla.ordenar('calif')">
              <span class="inline-flex items-center gap-1">Calificación<UIcon :name="tabla.sortIcon('calif')" class="size-3" /></span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-if="loading">
            <td colspan="8" class="text-center py-10 text-muted">Cargando…</td>
          </tr>
          <tr v-else-if="!tabla.visibles.value.length">
            <td colspan="8" class="text-center py-10 text-muted">Sin resultados.</td>
          </tr>
          <tr v-for="(r, idx) in tabla.visibles.value" v-else :key="idx" class="hover:bg-elevated/40">
            <td class="px-3 py-1.5 text-right font-mono text-muted">{{ tabla.offset.value + idx + 1 }}</td>
            <td class="px-3 py-1.5 font-mono">{{ r.nro_documento }}</td>
            <td class="px-3 py-1.5 font-medium whitespace-nowrap">{{ r.paterno }} {{ r.materno }} {{ r.nombres }}</td>
            <td class="px-3 py-1.5">{{ r.sede }}</td>
            <td class="px-3 py-1.5">{{ r.area }}</td>
            <td class="px-3 py-1.5">{{ r.turno }}</td>
            <td class="px-3 py-1.5">{{ r.grupo }}</td>
            <td class="px-2 py-1 w-32"><EstadoCelda v-bind="celdaCalif(r)" /></td>
          </tr>
        </tbody>
      </table>
    </UCard>

    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-xs text-muted">{{ fmtNumero(tabla.totalFiltrado.value) }} registros</p>
      <div class="flex items-center gap-3">
        <USelectMenu v-model="tabla.pageSize.value" :items="[25, 50, 100, 250]" class="w-24" />
        <UPagination v-model:page="tabla.page.value" :total="tabla.totalFiltrado.value" :items-per-page="tabla.pageSize.value" />
      </div>
    </div>
  </div>
</template>
