<script setup lang="ts">
import { fmtNumero } from '~/utils/format'

interface AreaR { area_id: number; area: string; total_inscritos: number; capacidad: number; vacantes_disponibles: number }
interface TurnoR { turno_id: number; turno: string; areas: AreaR[] }
interface SedeR { sede_id: number; sede: string; es_virtual: boolean; turnos: TurnoR[] }

const { api } = useApi()
const reporte = ref<SedeR[]>([])
const loading = ref(true)

async function cargar() {
  loading.value = true
  try {
    const d = await api<{ reporte: SedeR[] }>('/api/stats-inscripciones/reporte-sedes')
    reporte.value = d.reporte || []
  } finally {
    loading.value = false
  }
}

// Totales por sede (header de cada tab).
function totalesSede(s: SedeR) {
  let inscritos = 0, capacidad = 0
  for (const t of s.turnos) for (const a of t.areas) {
    inscritos += a.total_inscritos
    capacidad += a.capacidad
  }
  return { inscritos, capacidad, libres: Math.max(0, capacidad - inscritos) }
}

function ocupacion(a: AreaR) {
  if (a.capacidad <= 0) return null
  return Math.round(100 * a.total_inscritos / a.capacidad)
}
function estadoArea(a: AreaR): { color: string; bar: string; texto?: string } {
  const pct = ocupacion(a)
  if (pct === null) return { color: 'text-muted', bar: '#94a3b8' }
  if (a.vacantes_disponibles <= 0) return { color: 'text-red-600', bar: '#ef4444', texto: '¡AGOTADO!' }
  if (pct >= 90) return { color: 'text-amber-600', bar: '#f97316', texto: 'Pocas vacantes' }
  return { color: 'text-cepreuna-600', bar: '#0381d9' }
}

// Items de tabs (UTabs).
const tabItems = computed(() => reporte.value.map((s, i) => ({
  label: s.sede,
  value: String(i),
  badge: fmtNumero(totalesSede(s).inscritos)
})))
const tab = ref('0')

onMounted(cargar)
</script>

<template>
  <div class="p-4 lg:p-6 space-y-4">
    <div v-if="loading" class="text-center py-16 text-muted">Cargando reporte…</div>

    <template v-else-if="reporte.length">
      <UTabs v-model="tab" :items="tabItems" class="w-full" />

      <template v-for="(s, i) in reporte" :key="s.sede_id">
        <div v-show="tab === String(i)" class="space-y-4">
          <!-- Header de sede -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiCard label="Sede" :value="s.sede" />
            <KpiCard label="Inscritos" :value="fmtNumero(totalesSede(s).inscritos)" color="primary" />
            <KpiCard label="Capacidad" :value="s.es_virtual ? '—' : fmtNumero(totalesSede(s).capacidad)" />
            <KpiCard label="Libres" :value="s.es_virtual ? '—' : fmtNumero(totalesSede(s).libres)" color="success" />
          </div>

          <!-- Turnos -->
          <div class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            <UCard v-for="t in s.turnos" :key="t.turno_id">
              <template #header>
                <div class="flex items-center justify-between">
                  <h3 class="font-bold text-sm">{{ t.turno }}</h3>
                  <span class="text-xs text-muted">{{ fmtNumero(t.areas.reduce((acc, a) => acc + a.total_inscritos, 0)) }} inscritos</span>
                </div>
              </template>
              <div class="space-y-3">
                <div v-for="a in t.areas" :key="a.area_id" class="space-y-1">
                  <div class="flex items-center justify-between text-xs">
                    <span class="font-medium">{{ a.area }}</span>
                    <span class="font-mono" :class="estadoArea(a).color">
                      <template v-if="s.es_virtual || a.capacidad <= 0">{{ fmtNumero(a.total_inscritos) }}</template>
                      <template v-else>{{ fmtNumero(a.total_inscritos) }}/{{ fmtNumero(a.capacidad) }} · {{ ocupacion(a) }}%</template>
                    </span>
                  </div>
                  <div v-if="!s.es_virtual && a.capacidad > 0" class="h-2 rounded-full bg-elevated overflow-hidden">
                    <div class="h-full rounded-full transition-all duration-500" :style="{ width: Math.min(100, ocupacion(a) || 0) + '%', backgroundColor: estadoArea(a).bar }" />
                  </div>
                  <p v-if="estadoArea(a).texto" class="text-[10px] font-bold" :class="estadoArea(a).color">{{ estadoArea(a).texto }} · {{ fmtNumero(a.vacantes_disponibles) }} vacantes</p>
                </div>
                <p v-if="!t.areas.length" class="text-xs text-muted text-center py-2">Sin áreas.</p>
              </div>
            </UCard>
          </div>
        </div>
      </template>
    </template>

    <div v-else class="text-center py-16 text-muted">Sin datos de sedes.</div>
  </div>
</template>
