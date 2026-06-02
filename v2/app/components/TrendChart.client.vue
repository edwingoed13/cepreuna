<script setup lang="ts">
import { VisXYContainer, VisLine, VisArea, VisAxis, VisCrosshair, VisTooltip } from '@unovis/vue'
import { fmtNumero } from '~/utils/format'

interface Punto { fecha: string; valor: number }

const props = defineProps<{
  data: Punto[]
  color?: string
  height?: number
}>()

const x = (_d: Punto, i: number) => i
const y = (d: Punto) => d.valor
const lineColor = computed(() => props.color || '#003366')

function tickFmt(i: number) {
  const p = props.data[Math.round(i)]
  if (!p) return ''
  // dd/mm corto
  const d = new Date(p.fecha)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

function tooltip(d: Punto) {
  const f = new Date(d.fecha).toLocaleDateString('es-PE', { day: '2-digit', month: 'short' })
  return `<div style="font-size:12px"><b>${f}</b><br>${fmtNumero(d.valor)}</div>`
}
</script>

<template>
  <VisXYContainer :data="data" :height="height || 220" :margin="{ left: 10, right: 10, top: 10, bottom: 10 }">
    <VisArea :x="x" :y="y" :color="lineColor" :opacity="0.12" />
    <VisLine :x="x" :y="y" :color="lineColor" :line-width="2" />
    <VisAxis type="x" :tick-format="tickFmt" :grid-line="false" :num-ticks="6" />
    <VisAxis type="y" :tick-format="(v: number) => fmtNumero(v)" :num-ticks="4" />
    <VisCrosshair :color="lineColor" :template="tooltip" />
    <VisTooltip />
  </VisXYContainer>
</template>
