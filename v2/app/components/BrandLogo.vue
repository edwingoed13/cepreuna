<script setup lang="ts">
// Logo institucional CEPREUNA servido localmente (public/logo.png).
// `:src` dinámico (no estático) para evitar que el compilador de Vue lo
// transforme en un import de módulo — en dev, Vite no resuelve "/logo.png"
// como import. Como URL pública en runtime sí funciona (dev y producción).
withDefaults(defineProps<{ alt?: string }>(), {
  alt: 'Logo CEPREUNA'
})
const logoSrc = '/logo.png'
</script>

<template>
  <img
    :src="logoSrc"
    :alt="alt"
    width="496"
    height="354"
    decoding="async"
  >
</template>
