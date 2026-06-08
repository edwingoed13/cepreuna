<script setup lang="ts">
import { fmtNumero } from '~/utils/format'

const { api } = useApi()
const toast = useToast()

const search = ref('')
const resultados = ref<any[]>([])
const buscando = ref(false)
const abierto = ref(false)
const comparados = ref<any[]>([])   // fichas (/docente/:id)
const cargandoId = ref<number | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null

watch(search, (v) => {
  if (timer) clearTimeout(timer)
  abierto.value = true
  if (v.trim().length < 2) { resultados.value = []; return }
  timer = setTimeout(async () => {
    buscando.value = true
    try {
      const d = await api<{ resultados: any[] }>('/api/stats/docentes-stats/buscar?q=' + encodeURIComponent(v.trim()))
      resultados.value = d.resultados || []
    } catch { /* nada */ } finally { buscando.value = false }
  }, 300)
})

async function agregar(r: any) {
  abierto.value = false; search.value = ''; resultados.value = []
  if (comparados.value.find(c => c.docente.id === r.id)) return
  if (comparados.value.length >= 4) { toast.add({ title: 'Máximo 4 docentes', color: 'warning' }); return }
  cargandoId.value = r.id
  try {
    const f = await api(`/api/stats/docentes-stats/docente/${r.id}`)
    comparados.value.push(f)
  } catch {
    toast.add({ title: 'Error', description: 'No se pudo cargar el docente.', color: 'error' })
  } finally { cargandoId.value = null }
}
function quitar(id: number) { comparados.value = comparados.value.filter(c => c.docente.id !== id) }

function scoreColor(v: number | null) {
  if (v == null) return 'text-muted'
  if (v >= 4.5) return 'text-green-600 dark:text-green-400'
  if (v >= 4.0) return 'text-lime-600 dark:text-lime-400'
  if (v >= 3.5) return 'text-amber-500'
  return 'text-red-500'
}
// Mejor valor por métrica (para resaltar). dir: 'max' o 'min'.
function mejor(getter: (c: any) => number, dir: 'max' | 'min' = 'max') {
  const vals = comparados.value.map(getter).filter(v => Number.isFinite(v))
  if (!vals.length) return null
  return dir === 'max' ? Math.max(...vals) : Math.min(...vals)
}
</script>

<template>
  <div class="p-4 lg:p-6 space-y-4">
    <UButton to="/docentes" icon="i-lucide-arrow-left" color="neutral" variant="ghost" size="sm" label="Volver al panel" />

    <div class="flex items-center gap-3">
      <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-400">
        <UIcon name="i-lucide-git-compare" class="size-5" />
      </span>
      <div>
        <h2 class="text-lg font-black">Comparar docentes</h2>
        <p class="text-sm text-muted">Busca y compara hasta 4 docentes lado a lado.</p>
      </div>
    </div>

    <!-- Buscador -->
    <UCard :ui="{ body: 'p-3 sm:p-4' }">
      <div class="relative max-w-md">
        <UInput
          v-model="search"
          placeholder="Buscar por nombre, DNI o código UNAP…"
          icon="i-lucide-search"
          class="w-full"
          :loading="buscando"
          @focus="abierto = true"
        />
        <div
          v-if="abierto && resultados.length"
          class="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-default bg-default shadow-lg"
        >
          <button
            v-for="r in resultados"
            :key="r.id"
            class="w-full text-left px-3 py-2 hover:bg-elevated/60 transition-colors border-b border-default last:border-0"
            @click="agregar(r)"
          >
            <p class="text-sm font-medium">{{ r.nombre }}</p>
            <p class="text-[11px] text-muted">DNI {{ r.dni }} · {{ r.vinculo }}<template v-if="r.profesion"> · {{ r.profesion }}</template></p>
          </button>
        </div>
      </div>
      <p class="text-[11px] text-muted mt-2">{{ comparados.length }}/4 docentes en comparación.</p>
    </UCard>

    <!-- Vacío -->
    <div v-if="!comparados.length && cargandoId == null" class="text-center py-16 text-muted">
      <UIcon name="i-lucide-git-compare" class="size-10 mx-auto mb-3 opacity-50" />
      <p class="text-sm">Busca docentes arriba para empezar a comparar.</p>
    </div>

    <AcademicLoader v-if="cargandoId != null && !comparados.length" title="Cargando docente" icon="i-lucide-user-round" />

    <!-- Comparación -->
    <div v-if="comparados.length" class="grid gap-3" :style="{ gridTemplateColumns: `repeat(${comparados.length}, minmax(220px, 1fr))` }">
      <UCard v-for="c in comparados" :key="c.docente.id" class="relative" :ui="{ body: 'p-4' }">
        <UButton
          icon="i-lucide-x" color="neutral" variant="ghost" size="xs"
          class="absolute top-2 right-2" aria-label="Quitar" @click="quitar(c.docente.id)"
        />
        <p class="font-bold text-sm leading-tight pr-6 truncate" :title="c.docente.nombre">{{ c.docente.nombre }}</p>
        <p class="text-[10px] text-muted mb-3">{{ c.docente.vinculo }} · DNI {{ c.docente.dni }}</p>

        <p class="text-4xl font-black" :class="scoreColor(c.resumen.score)">{{ c.resumen.score ?? '—' }}</p>
        <p class="text-[10px] text-muted mb-3">score corregido</p>

        <dl class="space-y-1.5 text-xs">
          <div class="flex justify-between"><dt class="text-muted">Promedio crudo</dt><dd class="font-mono font-bold" :class="c.resumen.promedio_crudo === mejor(x => x.resumen.promedio_crudo) ? 'text-sky-600 dark:text-sky-400' : ''">{{ c.resumen.promedio_crudo ?? '—' }}</dd></div>
          <div class="flex justify-between"><dt class="text-muted">Calificaciones</dt><dd class="font-mono font-bold" :class="c.resumen.participantes === mejor(x => x.resumen.participantes) ? 'text-sky-600 dark:text-sky-400' : ''">{{ fmtNumero(c.resumen.participantes) }}</dd></div>
          <div class="flex justify-between"><dt class="text-muted">Posición</dt><dd class="font-mono font-bold" :class="c.resumen.posicion && c.resumen.posicion === mejor(x => x.resumen.posicion || 99999, 'min') ? 'text-sky-600 dark:text-sky-400' : ''">{{ c.resumen.posicion ? '#' + c.resumen.posicion : '—' }}</dd></div>
          <div class="flex justify-between"><dt class="text-muted">% Top (5)</dt><dd class="font-mono font-bold text-green-600 dark:text-green-400">{{ c.polarizacion?.pct_top ?? 0 }}%</dd></div>
          <div class="flex justify-between"><dt class="text-muted">% Crítica</dt><dd class="font-mono font-bold text-red-500">{{ c.polarizacion?.pct_critica ?? 0 }}%</dd></div>
          <div class="flex justify-between"><dt class="text-muted">Asist. presente</dt><dd class="font-mono font-bold">{{ c.asistencia?.pct_presente ?? 0 }}%</dd></div>
          <div class="flex justify-between"><dt class="text-muted">Robustez</dt><dd class="font-semibold capitalize">{{ c.resumen.robustez }}</dd></div>
          <div class="flex justify-between"><dt class="text-muted">Cursos · grupos</dt><dd class="font-mono">{{ c.resumen.cursos_distintos }} · {{ c.resumen.grupos_distintos }}</dd></div>
        </dl>

        <UButton :to="`/docentes/${c.docente.id}`" label="Ver ficha" icon="i-lucide-arrow-right" trailing size="xs" variant="soft" class="mt-3 w-full justify-center" />
      </UCard>
    </div>
  </div>
</template>
