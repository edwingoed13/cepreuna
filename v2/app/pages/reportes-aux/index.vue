<script setup lang="ts">
// Reportes auxiliares — landing con 2 tarjetas. Se construye en el paso 4.
const cards = [
  {
    title: 'Horas pago por docentes',
    description: 'Horas a pagar por coordinador, auxiliar, sede, turno, área y grupo.',
    icon: 'i-lucide-banknote',
    to: '/reportes-aux/horas-docentes'
  },
  {
    title: 'Cobertura de asistencia',
    description: 'Matriz SI/NO por grupo y día con % de cumplimiento.',
    icon: 'i-lucide-grid-3x3',
    to: '/reportes-aux/cobertura-grupos'
  }
]
</script>

<template>
  <div class="p-4 lg:p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
    <UPageCard
      v-for="c in cards"
      :key="c.to"
      :title="c.title"
      :description="c.description"
      :icon="c.icon"
      :to="c.to"
      spotlight
    />
  </div>
</template>
