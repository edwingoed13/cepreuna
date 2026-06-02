<script setup lang="ts">
import { fmtNumero, fmtHora } from '~/utils/format'

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
const ultima = ref<Date | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

async function cargar() {
  try {
    const [t, a, s, d] = await Promise.all([
      api<{ } & Totales>('/api/stats-inscripciones/totales'),
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
    // useApi ya maneja 401/403
  } finally {
    loading.value = false
  }
}

const pendientes = computed(() => {
  if (!totales.value) return 0
  return Math.max(0, (totales.value.total_inscritos || 0) - (totales.value.total_pagos_25feb || 0))
})

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
      <p class="text-xs text-muted">
        <span v-if="ultima">Actualizado: {{ fmtHora(ultima) }} · auto-refresco 60s</span>
        <span v-else>Cargando…</span>
      </p>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" :loading="loading" label="Refrescar" @click="cargar" />
    </div>

    <!-- KPIs -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard label="Total inscritos" :value="fmtNumero(totales?.total_inscritos)" color="primary" icon="i-lucide-users" />
      <KpiCard label="Pagos verificados" :value="fmtNumero(totales?.total_pagos_25feb)" color="success" icon="i-lucide-badge-check" />
      <KpiCard label="Inscripciones hoy" :value="fmtNumero(totales?.total_hoy)" icon="i-lucide-calendar-plus" />
      <KpiCard label="Pagos pendientes" :value="fmtNumero(pendientes)" color="warning" icon="i-lucide-clock" />
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
        <BarsChart :items="barrasAreas" />
      </UCard>

      <!-- Top sedes -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-map-pin" class="size-4 text-cepreuna-600" />
            <h3 class="font-bold text-sm">Inscritos por sede</h3>
          </div>
        </template>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div
            v-for="s in sedes"
            :key="s.sede_id"
            class="rounded-lg border border-default p-3"
          >
            <p class="text-[11px] text-muted truncate">{{ s.sede }}</p>
            <p class="text-xl font-black text-cepreuna-700 dark:text-cepreuna-300">{{ fmtNumero(s.total_inscritos) }}</p>
            <p class="text-[10px] text-muted">V {{ fmtNumero(s.virtual) }} · P {{ fmtNumero(s.presencial) }}</p>
          </div>
          <p v-if="!sedes.length" class="text-sm text-muted col-span-full text-center py-4">Sin datos.</p>
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
      <ClientOnly>
        <TrendChart v-if="trendData.length" :data="trendData" />
        <p v-else class="text-sm text-muted py-8 text-center">Sin datos.</p>
        <template #fallback>
          <div class="h-[220px] flex items-center justify-center text-muted text-sm">Cargando gráfico…</div>
        </template>
      </ClientOnly>
    </UCard>
  </div>
</template>
