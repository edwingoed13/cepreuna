'use strict';

/**
 * API interna de solo lectura — CEPREUNA
 * =====================================
 *
 * Se despliega DENTRO de la red institucional, donde sí se alcanza la base
 * multiciclo (10.1.30.44). Publica únicamente los reportes que el sitio
 * necesita, de modo que MySQL nunca queda expuesto a internet.
 *
 * nginx la publica en un subdominio y cepreuna.info la consume por HTTPS.
 * Ver README.md de esta carpeta para el despliegue.
 *
 * Solo lectura: la cuenta de base de datos usada (cepre_viewer) tiene
 * únicamente SELECT, así que aunque alguien superara la autenticación no
 * podría modificar nada.
 */

const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');

// El .env se toma SIEMPRE del directorio de este servicio, no del directorio de
// trabajo: así el proceso no hereda por accidente el .env del proyecto principal
// (que trae JWT_SECRET, claves de Supabase y otros secretos que aquí no pintan nada),
// y da igual con qué cwd lo arranque pm2.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { obtenerReporteCicloActual } = require('./lib/reporte-ciclo');

const app = express();
const PORT = process.env.API_PORT || 3001;
const TOKEN = process.env.API_INTERNA_TOKEN || '';

if (!TOKEN) {
  console.error('Falta API_INTERNA_TOKEN: la API no arranca sin token (quedaría abierta).');
  process.exit(1);
}

// Detrás de nginx, para que req.ip refleje al cliente real y no al proxy.
app.set('trust proxy', 1);
app.disable('x-powered-by');

const pool = mysql.createPool({
  host: process.env.DB2_HOST,
  user: process.env.DB2_USER,
  password: process.env.DB2_PASSWORD,
  database: process.env.DB2_NAME,
  port: process.env.DB2_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  connectTimeout: 20000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

// Comparación en tiempo constante: evita distinguir tokens por el tiempo de respuesta.
const crypto = require('crypto');
function tokenValido(recibido) {
  const a = Buffer.from(String(recibido || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requiereToken(req, res, next) {
  const cabecera = req.get('authorization') || '';
  const enviado = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : '';
  if (!tokenValido(enviado)) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// Comprueba la base reintentando: la primera conexión del pool puede agotar el
// tiempo mientras se establece la ruta hacia la red interna, y un 503 en ese
// momento haría parecer que el despliegue falló cuando en realidad está bien.
async function baseAccesible(intentos = 3) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      const conn = await pool.getConnection();
      try { await conn.query('SELECT 1'); } finally { conn.release(); }
      return { ok: true };
    } catch (e) {
      ultimo = e;
      if (i < intentos - 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { ok: false, codigo: ultimo?.code, mensaje: ultimo?.message };
}

// Salud: sin token, para que nginx y los monitores puedan sondearla.
app.get('/salud', async (_req, res) => {
  const r = await baseAccesible();
  if (r.ok) return res.json({ estado: 'ok', base: 'accesible' });
  res.status(503).json({ estado: 'degradado', base: 'inaccesible', codigo: r.codigo });
});

// Reporte de inscripciones del ciclo vigente, por sede/turno/área.
app.get('/ciclo-actual/reporte-sedes', requiereToken, async (_req, res) => {
  try {
    res.json(await obtenerReporteCicloActual(pool));
  } catch (e) {
    if (e.codigo === 'SIN_PERIODO') return res.status(404).json({ error: e.message });
    console.error('Error en reporte-sedes:', e.code || e.message);
    res.status(500).json({ error: 'No se pudo generar el reporte' });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.listen(PORT, '127.0.0.1', async () => {
  // Escucha solo en loopback: el acceso desde fuera entra por nginx, nunca directo.
  console.log(`API interna escuchando en http://127.0.0.1:${PORT}`);
  console.log(`Base multiciclo: ${process.env.DB2_HOST}/${process.env.DB2_NAME}`);

  // Se abre la primera conexión al arrancar para que /salud y la primera petición
  // real no paguen el arranque en frío del pool.
  const r = await baseAccesible();
  console.log(r.ok
    ? 'Conexión a la base verificada.'
    : `AVISO: no se pudo conectar a la base (${r.codigo}). Revisa el grant de ${process.env.DB2_USER} para la IP de este servidor.`);
});
