'use strict';

/**
 * Reintento ante conexiones de MySQL caídas.
 *
 * El pool guarda conexiones abiertas, pero el enlace hacia la red interna puede
 * cortarlas sin avisar (un parpadeo de la VPN, el `wait_timeout` del servidor).
 * La conexión queda muerta y el pool la entrega igualmente: la primera consulta
 * que la use falla con ECONNRESET aunque la base esté perfectamente.
 *
 * Reintentar una vez basta: al pedir otra conexión el pool descarta la rota y
 * abre una nueva. Solo se reintenta en fallos de transporte, nunca en errores
 * de SQL o de permisos, que volverían a fallar igual.
 */

const TRANSITORIOS = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST',
  'ECONNREFUSED',
  'EHOSTUNREACH'
]);

const esTransitorio = (e) => TRANSITORIOS.has(e?.code) || TRANSITORIOS.has(e?.cause?.code);

async function conReintento(fn, intentos = 2) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimo = e;
      if (!esTransitorio(e) || i === intentos - 1) throw e;
      console.warn(`Conexión perdida (${e.code || e.cause?.code}); reintentando…`);
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw ultimo;
}

module.exports = { conReintento, esTransitorio };
