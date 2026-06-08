<script setup lang="ts">
import type { GrupoDerivado } from '~/composables/useTablaAlumnos'

const props = defineProps<{
  grupos: GrupoDerivado[]
  seleccionados: Set<string>
}>()
const emit = defineEmits<{
  toggle: [id: number | string]
  limpiar: []
  'update:busqueda': [v: string]
}>()

const abierto = ref(false)
const busqueda = ref('')
watch(busqueda, v => emit('update:busqueda', v))

const resumen = computed(() => {
  const n = props.grupos.length
  const s = props.seleccionados.size
  if (s) return `${s} de ${n} grupos seleccionados`
  return `${n} grupos`
})
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <!-- Cabecera (toggle) -->
    <button
      class="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-elevated/40 transition-colors"
      @click="abierto = !abierto"
    >
      <div class="flex items-center gap-2 min-w-0">
        <UIcon name="i-lucide-layers" class="size-4 text-sky-600 dark:text-sky-400 shrink-0" />
        <span class="text-[10px] font-bold uppercase tracking-widest text-muted">Grupos asignados</span>
        <span
          v-if="seleccionados.size"
          class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-cepreuna-100 text-cepreuna-700 dark:bg-cepreuna-500/20 dark:text-cepreuna-300"
        >{{ seleccionados.size }} filtrando</span>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <span class="text-[11px] text-muted hidden sm:inline">{{ resumen }}</span>
        <UButton
          v-if="seleccionados.size"
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          label="Limpiar"
          @click.stop="emit('limpiar')"
        />
        <UIcon :name="abierto ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-4 text-muted" />
      </div>
    </button>

    <!-- Contenido colapsable -->
    <div v-if="abierto" class="px-3 pb-3 border-t border-default pt-3 space-y-2">
      <UInput
        v-model="busqueda"
        size="sm"
        placeholder="Buscar grupo o sede…"
        icon="i-lucide-search"
        class="w-full sm:w-64"
      />
      <div class="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
        <UButton
          v-for="g in grupos"
          :key="g.id"
          size="xs"
          :color="seleccionados.has(String(g.id)) ? 'primary' : 'neutral'"
          :variant="seleccionados.has(String(g.id)) ? 'solid' : 'outline'"
          @click="emit('toggle', g.id)"
        >
          <span class="truncate max-w-[160px]">{{ g.label }}</span>
          <span class="opacity-70 text-[10px]">· {{ g.sede }} ({{ g.count }})</span>
        </UButton>
        <p v-if="!grupos.length" class="text-xs text-muted py-2">Sin grupos.</p>
      </div>
    </div>
  </UCard>
</template>
