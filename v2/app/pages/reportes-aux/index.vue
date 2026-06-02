<script setup lang="ts">
const cards = [
  {
    title: 'Horas pago por docentes',
    description: 'Horas a pagar desglosadas por coordinador, auxiliar, sede, turno, área y grupo, con totales y export a Excel.',
    icon: 'i-lucide-banknote',
    to: '/reportes-aux/horas-docentes',
    accent: 'from-cepreuna-600 to-cepreuna-800'
  },
  {
    title: 'Cobertura de asistencia',
    description: 'Matriz SI/NO por grupo y día con % de cumplimiento. Detecta grupos sin auxiliar o con faltas.',
    icon: 'i-lucide-grid-3x3',
    to: '/reportes-aux/cobertura-grupos',
    accent: 'from-emerald-600 to-emerald-800'
  }
]
</script>

<template>
  <div class="p-4 lg:p-6">
    <div class="mb-4">
      <h2 class="text-lg font-bold">Reportes auxiliares</h2>
      <p class="text-sm text-muted">Pago de horas docentes y control de asistencia por grupo.</p>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl">
      <NuxtLink
        v-for="c in cards"
        :key="c.to"
        :to="c.to"
        class="group relative overflow-hidden rounded-xl border border-default bg-default hover:shadow-lg hover:-translate-y-0.5 transition-all"
      >
        <div class="absolute inset-x-0 top-0 h-1 bg-gradient-to-r" :class="c.accent" />
        <div class="p-5">
          <div class="flex items-start gap-4">
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br text-white flex items-center justify-center shrink-0" :class="c.accent">
              <UIcon :name="c.icon" class="size-6" />
            </div>
            <div class="min-w-0">
              <h3 class="font-bold text-sm group-hover:text-cepreuna-600 transition-colors">{{ c.title }}</h3>
              <p class="text-xs text-muted mt-1 leading-relaxed">{{ c.description }}</p>
            </div>
          </div>
          <div class="flex items-center gap-1 text-xs font-semibold text-cepreuna-600 mt-4">
            Abrir reporte
            <UIcon name="i-lucide-arrow-right" class="size-3.5 group-hover:translate-x-0.5 transition-transform" />
          </div>
        </div>
      </NuxtLink>
    </div>
  </div>
</template>
