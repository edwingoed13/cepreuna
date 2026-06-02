<script setup lang="ts">
import type { GrupoDerivado } from '~/composables/useTablaAlumnos'

defineProps<{
  grupos: GrupoDerivado[]
  seleccionados: Set<string>
}>()
const emit = defineEmits<{
  toggle: [id: number | string]
  limpiar: []
  'update:busqueda': [v: string]
}>()

const busqueda = ref('')
watch(busqueda, v => emit('update:busqueda', v))
</script>

<template>
  <UCard :ui="{ body: 'p-3 sm:p-3' }">
    <div class="flex items-center justify-between gap-2 mb-2">
      <p class="text-[10px] font-bold uppercase tracking-widest text-muted">
        Grupos asignados
        <span v-if="seleccionados.size" class="text-cepreuna-600">· {{ seleccionados.size }} sel.</span>
      </p>
      <div class="flex items-center gap-2">
        <UInput
          v-model="busqueda"
          size="xs"
          placeholder="Buscar grupo…"
          icon="i-lucide-search"
          class="w-40"
        />
        <UButton
          v-if="seleccionados.size"
          size="xs"
          color="neutral"
          variant="ghost"
          label="Limpiar"
          @click="emit('limpiar')"
        />
      </div>
    </div>
    <div class="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
      <UButton
        v-for="g in grupos"
        :key="g.id"
        size="xs"
        :color="seleccionados.has(String(g.id)) ? 'primary' : 'neutral'"
        :variant="seleccionados.has(String(g.id)) ? 'solid' : 'outline'"
        @click="emit('toggle', g.id)"
      >
        <span class="truncate max-w-[180px]">{{ g.label }}</span>
        <span class="opacity-70">· {{ g.sede }} ({{ g.count }})</span>
      </UButton>
      <p v-if="!grupos.length" class="text-xs text-muted py-2">Sin grupos.</p>
    </div>
  </UCard>
</template>
