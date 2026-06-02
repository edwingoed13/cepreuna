<script setup lang="ts">
import { fmtNumero, fmtHora, fmtPct } from '~/utils/format'

interface Totales { total_inscritos: number; total_virtual: number; total_presencial: number; total_pagos_25feb: number; total_hoy: number }
interface AreaRow { area_id: number; area: string; total_inscritos: number; virtual: number; presencial: number }
interface SedeRow { sede_id: number; sede: string; total_inscritos: number; virtual: number; presencial: number }
interface DiaRow { fecha: string; total_inscritos: number }

const { api } = useApi()

const totales = ref<Totales | null>(null)
const areas = ref<AreaRow[]>([])
const sedes = ref<SedeRow[]>([])
const dias = ref<DiaRow[]>([])
const loading = ref(true)
const error = ref(false)
const ultima = ref<Date | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

async function cargar() {
  error.value = false
  try {
    const [t, a, s, d] = await Promise.all([
      api<Totales>('/api/stats-inscripciones/totales'),
      api<{ areas: AreaRow[] }>('/api/stats-inscripciones/por-area'),
      api<{ sedes: SedeRow[] }>('/api/stats-inscripciones/por-sede'),
      api<{ dias: DiaRow[] }>('/api/stats-inscripciones/por-dia')
    ])
    totales.value = t
    areas.value = (a.areas || []).slice().sort((x, y) => y.total_inscritos - x.total_inscritos)
    sedes.value = (s.sedes || []).slice().sort((x, y) => y.total_inscritos - x.total_inscritos)
    dias.value = d.dias || []
    ultima.value = new Date()
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

const pendientes = computed(() => {
  if (!totales.value) return 0
  return Math.max(0, (totales.value.total_inscritos || 0) - (totales.value.total_pagos_25feb || 0))
})
const totalSedes = computed(() => sedes.value.reduce((a, s) => a + s.total_inscritos, 0))
const maxSede = computed(() => Math.max(1, ...sedes.value.map(s => s.total_inscritos)))

const barrasAreas = computed(() => areas.value.map(a => ({
  label: a.area,
  value: a.total_inscritos,
  sub: `· V ${fmtNumero(a.virtual)} / P ${fmtNumero(a.presencial)}`
})))

const trendData = computed(() => dias.value.map(d => ({ fecha: d.fecha, valor: d.total_inscritos })))

onMounted(() => {
  cargar()
  timer = setInterval(cargar, 60000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="p-4 lg:p-6 space-y-4">
    <div class="flex items-center justify-between">
      <p class="text-xs text-muted flex items-center gap-1.5">
        <span v-if="error" class="text-red-500 flex items-center gap-1"><UIcon name="i-lucide-wifi-off" class="size-3.5" />Sin conexión con la API</span>
        <span v-else-if="ultima"><UIcon name="i-lucide-clock" class="size-3 inline" /> Actualizado {{ fmtHora(ultima) }} · auto 60s</span>
        <span v-else>Cargando…</span>
      </p>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="sm" :loading="loading" label="Refrescar" @click="cargar" />
    </div>

    <!-- KPIs -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <template v-if="loading">
        <UCard v-for="n in 4" :key="n" :ui="{ body: 'p-4' }"><div class="h-12 rounded bg-elevated animate-pulse" /></UCard>
      </template>
      <template v-else>
        <KpiCard label="Total inscritos" :value="fmtNumero(totales?.total_inscritos)" color="primary" icon="i-lucide-users" />
        <KpiCard label="Pagos verificados" :value="fmtNumero(totales?.total_pagos_25feb)" :hint="fmtPct(totales?.total_pagos_25feb || 0, totales?.total_inscritos || 0) + ' de inscritos'" color="success" icon="i-lucide-badge-check" />
        <KpiCard label="Inscripciones hoy" :value="fmtNumero(totales?.total_hoy)" icon="i-lucide-calendar-plus" />
        <KpiCard label="Pagos pendientes" :value="fmtNumero(pendientes)" color="warning" icon="i-lucide-clock" />
      </template>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- Distribución por área -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-bar-chart-3" class="size-4 text-cepreuna-600" />
            <h3 class="font-bold text-sm">Distribución por área</h3>
          </div>
        </template>
        <div v-if="loading" class="space-y-3 py-2">
          <div v-for="n in 4" :key="n" class="h-5 rounded bg-elevated animate-pulse" />
        </div>
        <BarsChart v-else :items="barrasAreas" />
      </UCard>

      <!-- Top sedes -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-map-pin" class="size-4 text-cepreuna-600" />
            <h3 class="font-bold text-sm">Inscritos por sede</h3>
          </div>
        </template>
        <div v-if="loading" class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div v-for="n in 6" :key="n" class="h-16 rounded-lg bg-elevated animate-pulse" />
        </div>
        <div v-else class="space-y-1.5">
          <div v-for="s in sedes" :key="s.sede_id" class="flex items-center gap-3">
            <span class="text-xs font-medium w-28 truncate shrink-0">{{ s.sede }}</span>
            <div class="flex-1 h-5 rounded bg-elevated overflow-hidden relative">
              <div class="h-full rounded bg-cepreuna-500/80 transition-all duration-500" :style="{ width: (100 * s.total_inscritos / maxSede) + '%' }" />
            </div>
            <span class="text-xs font-mono font-bold w-20 text-right shrink-0">
              {{ fmtNumero(s.total_inscritos) }}
              <span class="text-muted font-normal">{{ fmtPct(s.total_inscritos, totalSedes, 0) }}</span>
            </span>
          </div>
          <p v-if="!sedes.length" class="text-sm text-muted text-center py-4">Sin datos.</p>
        </div>
      </UCard>
    </div>

    <!-- Tendencia -->
    <UCard>
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-trending-up" class="size-4 text-cepreuna-600" />
          <h3 class="font-bold text-sm">Tendencia de inscripciones por día</h3>
        </div>
      </template>
      <div v-if="loading" class="h-[220px] rounded bg-elevated animate-pulse" />
      <ClientOnly v-else>
        <TrendChart v-if="trendData.length" :data="trendData" />
        <p v-else class="text-sm text-muted py-8 text-center">Sin datos.</p>
        <template #fallback>
          <div class="h-[220px] flex items-center justify-center text-muted text-sm">Cargando gráfico…</div>
        </template>
      </ClientOnly>
    </UCard>
  </div>
</template>
