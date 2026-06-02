<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  hint?: string
  icon?: string
  color?: 'primary' | 'success' | 'warning' | 'error' | 'neutral'
}>()

const colorClasses: Record<string, string> = {
  primary: 'text-cepreuna-700 dark:text-cepreuna-300',
  success: 'text-green-600 dark:text-green-400',
  warning: 'text-amber-500 dark:text-amber-400',
  error: 'text-red-500 dark:text-red-400',
  neutral: 'text-slate-800 dark:text-white'
}
</script>

<template>
  <UCard :ui="{ body: 'p-4 sm:p-4' }">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <p class="text-[10px] font-bold uppercase tracking-widest text-muted mb-1">{{ label }}</p>
        <p class="text-2xl font-black" :class="colorClasses[color || 'neutral']">{{ value }}</p>
        <p v-if="hint" class="text-[10px] text-muted mt-1">{{ hint }}</p>
      </div>
      <UIcon v-if="icon" :name="icon" class="size-5 text-muted shrink-0" />
    </div>
  </UCard>
</template>
