// Estados de cuota de pago y de calificación: color + glifo (accesible para daltonismo).

export type EstadoTipo = 'completo' | 'parcial' | 'sin' | 'nada'

export interface EstadoVisual {
  color: 'success' | 'warning' | 'error' | 'neutral'
  icon: string
  hex: string
}

// Cuota de pago: pagada / parcial / sin pagar.
export function estadoPago(pagado: number, monto: number): EstadoVisual {
  if (monto <= 0) return { color: 'neutral', icon: 'i-lucide-minus', hex: '#94a3b8' }
  if (pagado >= monto) return { color: 'success', icon: 'i-lucide-check', hex: '#16a34a' }
  if (pagado > 0) return { color: 'warning', icon: 'i-lucide-circle-dashed', hex: '#d97706' }
  return { color: 'error', icon: 'i-lucide-x', hex: '#dc2626' }
}

// Calificación docente: completa / parcial / sin calificar / sin docentes.
export function estadoCalificacion(x: number, y: number): { tipo: EstadoTipo } & EstadoVisual {
  if (y <= 0) return { tipo: 'nada', color: 'neutral', icon: 'i-lucide-minus', hex: '#94a3b8' }
  if (x <= 0) return { tipo: 'sin', color: 'error', icon: 'i-lucide-x', hex: '#dc2626' }
  if (x < y) return { tipo: 'parcial', color: 'warning', icon: 'i-lucide-circle-dashed', hex: '#d97706' }
  return { tipo: 'completo', color: 'success', icon: 'i-lucide-check', hex: '#16a34a' }
}
