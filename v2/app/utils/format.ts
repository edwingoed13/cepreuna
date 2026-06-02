// Formateadores es-PE compartidos.

export function fmtNumero(n: number | string | null | undefined): string {
  return Number(n ?? 0).toLocaleString('es-PE')
}

export function fmtMoneda(n: number | string | null | undefined): string {
  return new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(Number(n ?? 0))
}

export function fmtPct(parte: number, total: number, dec = 1): string {
  if (!total) return '—'
  return (100 * parte / total).toFixed(dec) + '%'
}

export function fmtFecha(v: string | Date | null | undefined): string {
  if (!v) return '—'
  const d = typeof v === 'string' ? new Date(v) : v
  return d.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function fmtHora(v: string | Date | null | undefined): string {
  if (!v) return '—'
  const d = typeof v === 'string' ? new Date(v) : v
  return d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
}
