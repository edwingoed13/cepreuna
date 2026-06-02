<script setup lang="ts">
// Multi-select con búsqueda que devuelve un array de values (ids).
// Reemplaza el "msInit" casero de la v1 con USelectMenu nativo.
interface Item { label: string; value: string | number }

const props = defineProps<{
  modelValue: (string | number)[]
  items: Item[]
  placeholder?: string
  icon?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [v: (string | number)[]] }>()

const seleccion = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const etiqueta = computed(() => {
  const n = props.modelValue.length
  if (n === 0) return props.placeholder || 'Todos'
  if (n === 1) {
    const it = props.items.find(i => i.value === props.modelValue[0])
    return it?.label ?? '1 seleccionado'
  }
  return `${n} seleccionados`
})
</script>

<template>
  <USelectMenu
    v-model="seleccion"
    :items="items"
    value-key="value"
    multiple
    :icon="icon"
    :search-input="{ placeholder: 'Buscar…' }"
    class="w-full sm:w-52"
  >
    <template #default>
      <span class="truncate">{{ etiqueta }}</span>
    </template>
  </USelectMenu>
</template>
