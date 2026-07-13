// server.js - Backend API para Railway/Render
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// JWT secret para firmar tokens del panel /stats.
// Debe definirse JWT_SECRET en el entorno. Si falta:
//   - producción: generamos un secreto EFÍMERO aleatorio (seguro: no es público),
//     pero las sesiones serán inestables entre instancias/cold-starts hasta que
//     se defina JWT_SECRET. NO usamos process.exit porque en serverless (Vercel)
//     mata la función al importar el módulo → FUNCTION_INVOCATION_FAILED.
//   - desarrollo: fallback fijo para estabilidad entre reinicios.
let JWT_SECRET = process.env.JWT_SECRET;
let JWT_SECRET_MISSING = false; // se expone en /health para detectar la mala config
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    JWT_SECRET_MISSING = true;
    JWT_SECRET = require('crypto').randomBytes(48).toString('hex');
    // No hacemos process.exit: en serverless (Vercel) matar el módulo al importar
    // provoca FUNCTION_INVOCATION_FAILED. En su lugar avisamos de forma MUY visible
    // y lo exponemos en /health para que el fallo de despliegue sea evidente.
    console.error('\n' + '='.repeat(72));
    console.error('❌ JWT_SECRET NO DEFINIDO EN PRODUCCIÓN — secreto EFÍMERO por instancia.');
    console.error('   Las sesiones del panel /stats se cerrarán al navegar (401 intermitente).');
    console.error('   SOLUCIÓN: define JWT_SECRET en las variables de entorno y redeploy.');
    console.error('='.repeat(72) + '\n');
  } else {
    JWT_SECRET = 'cepreuna-stats-dev-secret-change-me';
    console.warn('⚠️  JWT_SECRET no definido — usando fallback de DESARROLLO. NO usar en producción.');
  }
}
const JWT_EXPIRES_IN = '1d';

// Middleware: exige Authorization: Bearer <jwt> y agrega req.user = { sub, role, grupos }
function requireStatsAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return res.status(401).json({ error: 'Token requerido', code: 'NO_TOKEN' });
  }
  try {
    req.user = jwt.verify(m[1], JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido o expirado', code: 'BAD_TOKEN' });
  }
}

// Roles con acceso administrativo global al panel /stats.
// Debe coincidir con la rama admin de calcularGruposPermitidos() y con el
// frontend (ADMIN_ROLES en cada vista). 'Oficina de Administración' se incluye
// porque calcularGruposPermitidos le otorga acceso global a datos (grupos=null).
const ADMIN_ROLES = ['Administrador', 'Super Admin', 'Oficina de Administración'];

// Helper: el rol corresponde a un administrador con acceso global
function esAdmin(role) {
  return ADMIN_ROLES.includes(role);
}

// Middleware: encadena requireStatsAuth y luego exige rol admin
function requireAdmin(req, res, next) {
  requireStatsAuth(req, res, (err) => {
    if (err) return; // requireStatsAuth ya respondió
    if (!esAdmin(req.user?.role)) {
      return res.status(403).json({ error: 'Acceso restringido a administradores', code: 'FORBIDDEN' });
    }
    next();
  });
}

// Calcula los grupo_aulas_ids permitidos según rol del usuario.
// Devuelve null si tiene acceso total (admin), [] si no tiene grupos asignados,
// o un array de ids si está restringido.
async function calcularGruposPermitidos(connection, userId, roleName) {
  if (!roleName) return [];
  // Roles con acceso global (ven todos los grupos en el reporte de pagos).
  if (esAdmin(roleName)) return null;

  if (roleName.startsWith('Auxiliar')) {
    const [rows] = await connection.query(`
      SELECT ag.grupo_aulas_id
      FROM auxiliares a
      JOIN auxiliar_grupos ag ON ag.auxiliares_id = a.id
      WHERE a.users_id = ?
    `, [userId]);
    return rows.map(r => Number(r.grupo_aulas_id));
  }

  if (roleName === 'Coordinador Auxiliar') {
    // OJO: en la BD la tabla `coordinador_grupos` tiene nombres engañosos:
    //   - coordinador_id → users.id  (NO auxiliares.id)
    //   - grupos_id      → grupo_aulas.id  (NO grupos.id)
    // Este es el control fino: un coordinador puede supervisar solo un subset
    // de los grupos de un auxiliar; la cadena auxiliar_coordinadores → auxiliar_grupos
    // sobre-incluye grupos.
    const [rows] = await connection.query(`
      SELECT DISTINCT cg.grupos_id AS grupo_aulas_id
      FROM coordinador_grupos cg
      WHERE cg.coordinador_id = ?
    `, [userId]);
    return rows.map(r => Number(r.grupo_aulas_id));
  }

  return [];
}

const app = express();
const PORT = process.env.PORT || 3000;

// Detrás del proxy de Vercel/Railway: confiar en 1 hop para leer la IP real
// (X-Forwarded-For). Necesario para que express-rate-limit cuente por IP
// correctamente y no emita errores de validación de trust proxy.
app.set('trust proxy', 1);

// ============ CACHE LAYER ============
// Cache en memoria con TTL para reducir Fast Origin Transfer
const cache = new Map();

function cacheMiddleware(ttlSeconds = 300) {
  return (req, res, next) => {
    // Solo cachear GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // La clave incluye un discriminador por usuario/rol/grupos cuando la ruta
    // está autenticada. Evita que una respuesta restringida por grupos (rol
    // auxiliar/coordinador) se sirva a otro usuario si algún día se cachea un
    // endpoint con datos por-grupo. En rutas públicas req.user es undefined.
    const userKey = req.user
      ? `u:${req.user.sub}:${req.user.role}:${Array.isArray(req.user.grupos) ? req.user.grupos.join('.') : 'all'}|`
      : '';
    const key = userKey + (req.originalUrl || req.url);
    const cached = cache.get(key);

    if (cached && Date.now() < cached.expiry) {
      console.log(`✅ CACHE HIT: ${key}`);
      // Agregar header para debugging
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-TTL', Math.floor((cached.expiry - Date.now()) / 1000));
      return res.json(cached.data);
    }

    console.log(`❌ CACHE MISS: ${key}`);
    res.setHeader('X-Cache', 'MISS');

    // Interceptar res.json para guardar en caché.
    // NO cachear respuestas de error (status >= 400): cachear un 500 transitorio
    // lo serviría como "200 OK" durante todo el TTL.
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      if (res.statusCode < 400) {
        cache.set(key, {
          data: data,
          expiry: Date.now() + (ttlSeconds * 1000)
        });
      }
      return originalJson(data);
    };

    next();
  };
}

// Limpiar caché expirado cada 5 minutos
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, value] of cache.entries()) {
    if (now >= value.expiry) {
      cache.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 Cache cleanup: ${cleaned} entradas eliminadas`);
  }
}, 5 * 60 * 1000);

// ============ SEGURIDAD ============
// helmet: cabeceras de seguridad (X-Frame-Options anti-clickjacking, noSniff, etc.).
// CSP se deja desactivado porque las páginas usan scripts inline + CDNs (tailwind,
// google fonts); activar un CSP estricto requeriría refactor del frontend.
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS restringido a orígenes conocidos. Las peticiones same-origin (el propio
// sitio) y las server-to-server no se ven afectadas; solo se bloquea que otros
// sitios web llamen la API desde el navegador de un usuario.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ||
  'https://cepreuna.info,https://www.cepreuna.info,http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Sin Origin (apps móviles, curl, server-to-server) → permitir.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false); // origen no permitido: sin cabeceras CORS (no lanza 500)
  }
}));

// Rate limiting
const rateLimit = require('express-rate-limit');
// Global: protege contra scraping/abuso de toda la API.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 200,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas peticiones, intenta de nuevo en un momento.' },
});
app.use('/api/', apiLimiter);

// Logging temporal para descubrir quién consume /api/matriculas/* (datos
// sensibles que aún están sin autenticación). Revisar en los logs de Vercel
// (Functions → Logs, buscar "MATRICULAS_ACCESS") para identificar el consumidor
// y luego asegurar estos endpoints. Quitar este middleware cuando ya no se necesite.
app.use('/api/matriculas', (req, res, next) => {
  console.log('MATRICULAS_ACCESS ' + JSON.stringify({
    ts: new Date().toISOString(),
    path: req.originalUrl,
    ip: req.ip,
    xff: req.headers['x-forwarded-for'] || null,
    ua: req.headers['user-agent'] || null,
    origin: req.headers['origin'] || null,
    referer: req.headers['referer'] || null,
  }));
  next();
});

// Login: estricto, contra fuerza bruta de contraseñas.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Espera 15 minutos.' },
});

// Límite elevado para aceptar fotos en Base64 del forms-admin (~2.7MB cuando la original es 2MB).
app.use(express.json({ limit: '6mb' }));

// Compression middleware para reducir payload size
const compression = require('compression');
app.use(compression({
  level: 6, // Balance entre velocidad y ratio de compresión
  threshold: 1024, // Solo comprimir responses > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    // Comprimir solo JSON y texto
    return compression.filter(req, res);
  }
}));

// Bloquear acceso estático a /data (contiene datos personales de docentes).
// Debe ir ANTES de express.static para interceptar la descarga directa del JSON.
app.use('/data', (req, res) => res.status(404).send('Not found'));

// Bloquear la carpeta con el Excel de origen del simulacro: contiene los datos
// crudos de TODOS los estudiantes (respuestas, códigos, etc.). La consulta pública
// solo devuelve un registro por DNI vía /api/simulacro/resultado/:dni.
app.use('/simulacro-resultados', (req, res) => res.status(404).send('Not found'));

// Servir archivos estáticos (HTML, CSS, JS).
// Los .html se sirven con `no-cache` para que el navegador siempre revalide
// y no muestre versiones viejas tras un deploy/cambio.
app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// Rutas amigables para Stats
app.get('/stats/login', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'login.html'));
});

app.get('/stats', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'index.html'));
});

app.get('/stats/reportes', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'reportes', 'index.html'));
});

app.get('/stats/alumnos', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'alumnos', 'index.html'));
});

app.get('/stats/docentes-stats', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'docentes-stats', 'index.html'));
});
app.get('/stats/docentes-stats/docente', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'docentes-stats', 'docente', 'index.html'));
});
app.get('/stats/docentes-stats/comparar', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'docentes-stats', 'comparar', 'index.html'));
});

app.get('/stats/alumnos-calificacion', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'alumnos-calificacion', 'index.html'));
});

app.get('/stats/reportes-aux', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'reportes-aux', 'index.html'));
});
app.get('/stats/reportes-aux/horas-docentes', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'reportes-aux', 'horas-docentes', 'index.html'));
});
app.get('/stats/reportes-aux/cobertura-grupos', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'reportes-aux', 'cobertura-grupos', 'index.html'));
});
app.get('/stats/reportes-aux/tardanzas', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'reportes-aux', 'tardanzas', 'index.html'));
});
app.get('/stats/habilitados', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'habilitados', 'index.html'));
});

app.get('/stats/habilitados-stats', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'habilitados-stats', 'index.html'));
});

// SQL base del reporte de pagos (cargado una vez al iniciar; sin ORDER BY ni `;` final
// para poder envolverlo en un SELECT * FROM (...) y aplicar filtros dinámicos.)
const REPORTE_PAGOS_SQL_BASE = require('fs')
  .readFileSync(require('path').join(__dirname, 'reporte-pagos.sql'), 'utf8')
  .replace(/ORDER\s+BY[\s\S]*$/i, '')
  .replace(/;\s*$/, '')
  .trim();

// Configuración de la base de datos
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 30000, // 30 segundos para establecer conexión
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
};

// Pool de conexiones
const pool = mysql.createPool(dbConfig);

// Verificar conexión al iniciar
pool.getConnection()
  .then(connection => {
    console.log('✅ Conexión a base de datos establecida correctamente');
    connection.release();
  })
  .catch(err => {
    console.error('❌ Error al conectar a la base de datos:', err.message);
    console.error('Verifica las credenciales y que el servidor MySQL sea accesible');
  });

// ============ ENDPOINTS SIMULACRO ============

// Endpoint para estadísticas del simulacro
app.get('/api/stats', async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [inscritosResult] = await connection.query(
      'SELECT COUNT(*) as total FROM inscripcion_simulacros'
    );

    const [pagadosResult] = await connection.query(
      `SELECT COUNT(*) as total 
       FROM banco_pagos
       WHERE fch_pag BETWEEN '2025-11-27' AND '2025-12-13'
         AND imp_pag > 14 
         AND imp_pag <= 18`
    );

    connection.release();

    const stats = {
      totalInscritos: inscritosResult[0].total,
      totalPagados: pagadosResult[0].total,
      timestamp: new Date().toISOString()
    };

    res.json(stats);

  } catch (error) {
    console.error('Error en la consulta:', error);
    res.status(500).json({
      error: 'Error al obtener datos',
      message: error.message
    });
  }
});

// Endpoint para inscritos por área (simulacro)
app.get('/api/inscritos-por-area', async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT 
        a.denominacion as area,
        COUNT(DISTINCT ise.nro_documento) as total_inscritos
      FROM inscripcion_simulacros ise
      INNER JOIN estudiantes e ON ise.nro_documento = e.nro_documento
      INNER JOIN inscripciones i ON e.id = i.estudiantes_id
      INNER JOIN areas a ON i.areas_id = a.id
      WHERE i.periodos_id = 1
      GROUP BY a.id, a.denominacion
      ORDER BY a.denominacion
    `);

    connection.release();

    res.json({
      areas: result,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error en la consulta de áreas:', error);
    res.status(500).json({
      error: 'Error al obtener datos por área',
      message: error.message
    });
  }
});

// ============ ENDPOINTS MATRÍCULAS ============

// 1. Totales Generales
app.get('/api/matriculas/totales', cacheMiddleware(300), async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        COUNT(DISTINCT m.estudiantes_id) as total_inscritos,
        SUM(CASE WHEN m.habilitado = '1' THEN 1 ELSE 0 END) as total_habilitados,
        SUM(CASE WHEN m.habilitado = '1' AND m.habilitado_estado = '1' THEN 1 ELSE 0 END) as total_sincronizados
      FROM matriculas m
      WHERE m.periodos_id = 1
    `);

    connection.release();

    // Convertir a números para asegurar consistencia
    const totales = {
      total_inscritos: parseInt(result[0].total_inscritos) || 0,
      total_habilitados: parseInt(result[0].total_habilitados) || 0,
      total_sincronizados: parseInt(result[0].total_sincronizados) || 0,
      timestamp: new Date().toISOString()
    };

    res.json(totales);

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al obtener totales', message: error.message });
  }
});

// 2. Desglose por Área
app.get('/api/matriculas/por-area', cacheMiddleware(300), async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        a.denominacion AS area,
        COUNT(DISTINCT m.estudiantes_id) AS total_estudiantes,
        SUM(CASE WHEN m.habilitado = '1' AND m.habilitado_estado = '1' THEN 1 ELSE 0 END) AS total_sincronizados,
        ROUND((SUM(CASE WHEN m.habilitado = '1' AND m.habilitado_estado = '1' THEN 1 ELSE 0 END) * 100.0) / COUNT(DISTINCT m.estudiantes_id), 2) AS porcentaje_sincronizados
      FROM
        matriculas m
        INNER JOIN grupo_aulas ga ON m.grupo_aulas_id = ga.id
        INNER JOIN areas a ON ga.areas_id = a.id
      WHERE
        m.periodos_id = 1
      GROUP BY
        a.id, a.denominacion
      ORDER BY
        total_estudiantes DESC
    `);

    connection.release();

    // Convertir a números para asegurar consistencia
    const areas = result.map(row => ({
      area: row.area,
      total_estudiantes: parseInt(row.total_estudiantes) || 0,
      total_sincronizados: parseInt(row.total_sincronizados) || 0,
      porcentaje_sincronizados: parseFloat(row.porcentaje_sincronizados) || 0
    }));

    res.json({
      areas,
      total_areas: areas.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al obtener datos por área', message: error.message });
  }
});

// 3. Desglose por Sede
app.get('/api/matriculas/por-sede', cacheMiddleware(300), async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        s.id as sede_id,
        s.denominacion AS sede,
        COUNT(DISTINCT m.estudiantes_id) as total_inscritos,
        SUM(CASE WHEN m.habilitado = '1' THEN 1 ELSE 0 END) as total_habilitados,
        SUM(CASE WHEN m.habilitado = '1' AND m.habilitado_estado = '1' THEN 1 ELSE 0 END) as total_sincronizados
      FROM matriculas m
      INNER JOIN grupo_aulas ga ON m.grupo_aulas_id = ga.id
      INNER JOIN aulas au ON ga.aulas_id = au.id
      INNER JOIN locales l ON au.locales_id = l.id
      INNER JOIN sedes s ON l.sedes_id = s.id
      WHERE m.periodos_id = 1
      GROUP BY s.id, s.denominacion
      ORDER BY s.denominacion
    `);

    connection.release();

    // Convertir valores a números
    const sedes = result.map(row => ({
      sede_id: row.sede_id,
      sede: row.sede,
      total_inscritos: parseInt(row.total_inscritos) || 0,
      total_habilitados: parseInt(row.total_habilitados) || 0,
      total_sincronizados: parseInt(row.total_sincronizados) || 0
    }));

    res.json({ sedes, timestamp: new Date().toISOString() });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al obtener datos por sede', message: error.message });
  }
});

// 3. Desglose por Sede > Área
app.get('/api/matriculas/por-sede-area', async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        s.id as sede_id,
        s.denominacion AS sede,
        a.id as area_id,
        a.denominacion AS area,
        COUNT(DISTINCT m.estudiantes_id) as total_inscritos,
        SUM(CASE WHEN m.habilitado = '1' THEN 1 ELSE 0 END) as total_habilitados,
        SUM(CASE WHEN m.habilitado = '1' AND m.habilitado_estado = '1' THEN 1 ELSE 0 END) as total_sincronizados
      FROM matriculas m
      INNER JOIN grupo_aulas ga ON m.grupo_aulas_id = ga.id
      INNER JOIN areas a ON ga.areas_id = a.id
      INNER JOIN aulas au ON ga.aulas_id = au.id
      INNER JOIN locales l ON au.locales_id = l.id
      INNER JOIN sedes s ON l.sedes_id = s.id
      WHERE m.periodos_id = 1
      GROUP BY s.id, s.denominacion, a.id, a.denominacion
      ORDER BY s.denominacion, a.denominacion
    `);

    connection.release();

    // Convertir valores a números
    const data = result.map(row => ({
      sede_id: row.sede_id,
      sede: row.sede,
      area_id: row.area_id,
      area: row.area,
      total_inscritos: parseInt(row.total_inscritos) || 0,
      total_habilitados: parseInt(row.total_habilitados) || 0,
      total_sincronizados: parseInt(row.total_sincronizados) || 0
    }));

    res.json({ data, timestamp: new Date().toISOString() });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al obtener datos', message: error.message });
  }
});

// 4. Desglose por Sede > Área > Turno
app.get('/api/matriculas/por-sede-area-turno', async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        s.id as sede_id,
        s.denominacion AS sede,
        a.id as area_id,
        a.denominacion AS area,
        t.id as turno_id,
        t.denominacion AS turno,
        COUNT(DISTINCT m.estudiantes_id) as total_inscritos,
        SUM(CASE WHEN m.habilitado = '1' THEN 1 ELSE 0 END) as total_habilitados,
        SUM(CASE WHEN m.habilitado = '1' AND m.habilitado_estado = '1' THEN 1 ELSE 0 END) as total_sincronizados
      FROM matriculas m
      INNER JOIN grupo_aulas ga ON m.grupo_aulas_id = ga.id
      INNER JOIN areas a ON ga.areas_id = a.id
      INNER JOIN turnos t ON ga.turnos_id = t.id
      INNER JOIN aulas au ON ga.aulas_id = au.id
      INNER JOIN locales l ON au.locales_id = l.id
      INNER JOIN sedes s ON l.sedes_id = s.id
      WHERE m.periodos_id = 1
      GROUP BY s.id, s.denominacion, a.id, a.denominacion, t.id, t.denominacion
      ORDER BY s.denominacion, a.denominacion, t.denominacion
    `);

    connection.release();

    // Convertir valores a números
    const data = result.map(row => ({
      sede_id: row.sede_id,
      sede: row.sede,
      area_id: row.area_id,
      area: row.area,
      turno_id: row.turno_id,
      turno: row.turno,
      total_inscritos: parseInt(row.total_inscritos) || 0,
      total_habilitados: parseInt(row.total_habilitados) || 0,
      total_sincronizados: parseInt(row.total_sincronizados) || 0
    }));

    res.json({ data, timestamp: new Date().toISOString() });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al obtener datos', message: error.message });
  }
});

// 5. Desglose completo: Sede > Área > Turno > Grupo
app.get('/api/matriculas/completo', cacheMiddleware(600), async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        s.id as sede_id,
        s.denominacion AS sede,
        a.id as area_id,
        a.denominacion AS area,
        t.id as turno_id,
        t.denominacion AS turno,
        g.id as grupo_id,
        g.denominacion AS grupo,
        COUNT(DISTINCT m.estudiantes_id) as total_inscritos,
        SUM(CASE WHEN m.habilitado = '1' THEN 1 ELSE 0 END) as total_habilitados,
        SUM(CASE WHEN m.habilitado = '1' AND m.habilitado_estado = '1' THEN 1 ELSE 0 END) as total_sincronizados,
        SUM(CASE WHEN m.habilitado = '1' AND m.habilitado_estado = '0' THEN 1 ELSE 0 END) as total_pendientes,
        SUM(CASE WHEN m.habilitado = '1' AND m.habilitado_estado = '2' THEN 1 ELSE 0 END) as total_error
      FROM matriculas m
      INNER JOIN grupo_aulas ga ON m.grupo_aulas_id = ga.id
      INNER JOIN grupos g ON ga.grupos_id = g.id
      INNER JOIN areas a ON ga.areas_id = a.id
      INNER JOIN turnos t ON ga.turnos_id = t.id
      INNER JOIN aulas au ON ga.aulas_id = au.id
      INNER JOIN locales l ON au.locales_id = l.id
      INNER JOIN sedes s ON l.sedes_id = s.id
      WHERE m.periodos_id = 1
      GROUP BY s.id, s.denominacion, a.id, a.denominacion, t.id, t.denominacion, g.id, g.denominacion
      ORDER BY s.denominacion, a.denominacion, t.denominacion, g.denominacion
    `);

    connection.release();

    // Convertir valores a números
    const data = result.map(row => ({
      sede_id: row.sede_id,
      sede: row.sede,
      area_id: row.area_id,
      area: row.area,
      turno_id: row.turno_id,
      turno: row.turno,
      grupo_id: row.grupo_id,
      grupo: row.grupo,
      total_inscritos: parseInt(row.total_inscritos) || 0,
      total_habilitados: parseInt(row.total_habilitados) || 0,
      total_sincronizados: parseInt(row.total_sincronizados) || 0,
      total_pendientes: parseInt(row.total_pendientes) || 0,
      total_error: parseInt(row.total_error) || 0
    }));

    res.json({ data, timestamp: new Date().toISOString() });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al obtener datos', message: error.message });
  }
});

// 6. Detalle de estudiantes pendientes sin deuda por grupo
app.get('/api/matriculas/pendientes-sin-deuda/detalle', async (req, res) => {
  try {
    const { sede, area, turno, grupo } = req.query;

    if (!sede || !area || !turno || !grupo) {
      return res.status(400).json({
        error: 'Parámetros requeridos: sede, area, turno, grupo'
      });
    }

    const connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        e.nro_documento AS dni,
        CONCAT(e.paterno, ' ', e.materno, ' ', e.nombres) AS apellidos_nombres,
        s.denominacion AS sede,
        a.denominacion AS area,
        t.denominacion AS turno,
        g.denominacion AS grupo,
        SUM(te.monto) AS total_tarifa,
        SUM(te.pagado) AS total_pagado,
        SUM(te.monto - te.pagado) AS deuda_total
      FROM
        estudiantes e
        INNER JOIN inscripciones i ON e.id = i.estudiantes_id
        INNER JOIN matriculas m ON e.id = m.estudiantes_id AND m.periodos_id = 1
        INNER JOIN tarifa_estudiantes te ON e.id = te.estudiantes_id
        INNER JOIN grupo_aulas ga ON m.grupo_aulas_id = ga.id
        INNER JOIN grupos g ON ga.grupos_id = g.id
        INNER JOIN areas a ON ga.areas_id = a.id
        INNER JOIN turnos t ON ga.turnos_id = t.id
        INNER JOIN aulas au ON ga.aulas_id = au.id
        INNER JOIN locales l ON au.locales_id = l.id
        INNER JOIN sedes s ON l.sedes_id = s.id
      WHERE
        i.periodos_id = 1
        AND m.habilitado = '0'
        AND s.denominacion = ?
        AND a.denominacion = ?
        AND t.denominacion = ?
        AND g.denominacion = ?
      GROUP BY
        e.id,
        e.nro_documento,
        e.paterno,
        e.materno,
        e.nombres,
        s.denominacion,
        a.denominacion,
        t.denominacion,
        g.denominacion
      HAVING
        SUM(te.monto - te.pagado) <= 0
      ORDER BY
        e.paterno,
        e.materno,
        e.nombres
    `, [sede, area, turno, grupo]);

    connection.release();

    // Convertir valores a números
    const estudiantes = result.map(row => ({
      dni: row.dni,
      apellidos_nombres: row.apellidos_nombres,
      sede: row.sede,
      area: row.area,
      turno: row.turno,
      grupo: row.grupo,
      total_tarifa: parseFloat(row.total_tarifa) || 0,
      total_pagado: parseFloat(row.total_pagado) || 0,
      deuda_total: parseFloat(row.deuda_total) || 0
    }));

    res.json({
      estudiantes,
      total: estudiantes.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Error al obtener detalle de estudiantes',
      message: error.message
    });
  }
});

// 7. Estudiantes sin deuda pero no habilitados
app.get('/api/matriculas/pendientes-sin-deuda', async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        s.denominacion AS sede,
        a.denominacion AS area,
        t.denominacion AS turno,
        g.denominacion AS grupo,
        COUNT(*) AS total_no_habilitados_sin_deuda
      FROM (
        SELECT
          e.id,
          s.id AS sede_id,
          a.id AS area_id,
          t.id AS turno_id,
          g.id AS grupo_id
        FROM
          estudiantes e
          INNER JOIN matriculas m ON e.id = m.estudiantes_id AND m.periodos_id = 1
          INNER JOIN tarifa_estudiantes te ON e.id = te.estudiantes_id
          INNER JOIN grupo_aulas ga ON m.grupo_aulas_id = ga.id
          INNER JOIN grupos g ON ga.grupos_id = g.id
          INNER JOIN areas a ON ga.areas_id = a.id
          INNER JOIN turnos t ON ga.turnos_id = t.id
          INNER JOIN aulas au ON ga.aulas_id = au.id
          INNER JOIN locales l ON au.locales_id = l.id
          INNER JOIN sedes s ON l.sedes_id = s.id
        WHERE
          m.habilitado = '0'
        GROUP BY
          e.id,
          s.id,
          a.id,
          t.id,
          g.id
        HAVING
          SUM(te.monto - te.pagado) <= 0
      ) AS estudiantes_sin_deuda
      INNER JOIN sedes s ON estudiantes_sin_deuda.sede_id = s.id
      INNER JOIN areas a ON estudiantes_sin_deuda.area_id = a.id
      INNER JOIN turnos t ON estudiantes_sin_deuda.turno_id = t.id
      INNER JOIN grupos g ON estudiantes_sin_deuda.grupo_id = g.id
      GROUP BY
        s.id,
        s.denominacion,
        a.id,
        a.denominacion,
        t.id,
        t.denominacion,
        g.id,
        g.denominacion
      ORDER BY
        s.denominacion,
        a.denominacion,
        t.denominacion,
        g.denominacion
    `);

    connection.release();

    // Convertir valores a números
    const data = result.map(row => ({
      sede: row.sede,
      area: row.area,
      turno: row.turno,
      grupo: row.grupo,
      total_no_habilitados_sin_deuda: parseInt(row.total_no_habilitados_sin_deuda) || 0
    }));

    // Calcular total general
    const total_general = data.reduce((sum, row) => sum + row.total_no_habilitados_sin_deuda, 0);

    res.json({
      data,
      total_general,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error al obtener pendientes sin deuda', message: error.message });
  }
});

// 8. Estudiantes habilitados con deuda pendiente (ALERTA)
app.get('/api/matriculas/habilitados-con-deuda', async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        e.nro_documento as dni,
        CONCAT(e.paterno, ' ', e.materno, ' ', e.nombres) as apellidos_nombres,
        s.denominacion as sede,
        a.denominacion as area,
        t.denominacion as turno,
        g.denominacion as grupo,
        SUM(te.monto - te.pagado) as deuda_total
      FROM estudiantes e
      INNER JOIN inscripciones i ON e.id = i.estudiantes_id
      INNER JOIN matriculas m ON e.id = m.estudiantes_id AND m.periodos_id = 1
      INNER JOIN tarifa_estudiantes te ON e.id = te.estudiantes_id
      INNER JOIN sedes s ON i.sedes_id = s.id
      INNER JOIN grupo_aulas ga ON m.grupo_aulas_id = ga.id
      INNER JOIN grupos g ON ga.grupos_id = g.id
      INNER JOIN areas a ON ga.areas_id = a.id
      INNER JOIN turnos t ON ga.turnos_id = t.id
      WHERE
        i.periodos_id = 1
        AND m.habilitado = '1'
      GROUP BY
        e.id,
        e.nro_documento,
        e.paterno,
        e.materno,
        e.nombres,
        s.denominacion,
        a.denominacion,
        t.denominacion,
        g.denominacion
      HAVING
        SUM(te.monto - te.pagado) > 0
      ORDER BY
        SUM(te.monto - te.pagado) DESC,
        e.paterno,
        e.materno,
        e.nombres
    `);

    connection.release();

    // Convertir valores a números
    const estudiantes = result.map(row => ({
      dni: row.dni,
      apellidos_nombres: row.apellidos_nombres,
      sede: row.sede,
      area: row.area,
      turno: row.turno,
      grupo: row.grupo,
      deuda_total: parseFloat(row.deuda_total) || 0
    }));

    res.json({
      estudiantes,
      total: estudiantes.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Error al obtener habilitados con deuda',
      message: error.message
    });
  }
});

// 9. Progreso de habilitaciones por auxiliar (TESTING - NO PUBLICAR)
app.get('/api/matriculas/progreso-auxiliares', async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        dates.fecha,
        u.id AS auxiliar_id,
        CONCAT(u.paterno, ' ', u.materno, ', ', u.name) AS auxiliar,
        COALESCE(COUNT(a.id), 0) AS total_habilitados
      FROM (
        SELECT DATE('2025-12-01') + INTERVAL (a.a + (10 * b.a)) DAY AS fecha
        FROM (SELECT 0 AS a UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3
              UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6
              UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS a
        CROSS JOIN (SELECT 0 AS a UNION ALL SELECT 1 UNION ALL SELECT 2) AS b
        WHERE DATE('2025-12-01') + INTERVAL (a.a + (10 * b.a)) DAY <= '2025-12-23'
      ) AS dates
      CROSS JOIN users u
      LEFT JOIN audits a ON DATE(a.created_at) = dates.fecha
        AND a.user_id = u.id
        AND a.auditable_type = 'App\\\\Models\\\\Matricula'
        AND a.event = 'updated'
        AND a.old_values LIKE '%"habilitado":"0"%'
        AND a.new_values LIKE '%"habilitado":"1"%'
      WHERE
        u.estado = '1'
      GROUP BY
        dates.fecha,
        u.id,
        u.paterno,
        u.materno,
        u.name
      ORDER BY
        auxiliar, dates.fecha
    `);

    connection.release();

    // Agrupar datos por auxiliar
    const auxiliaresMap = {};

    result.forEach(row => {
      const auxiliarId = row.auxiliar_id;

      if (!auxiliaresMap[auxiliarId]) {
        auxiliaresMap[auxiliarId] = {
          auxiliar_id: auxiliarId,
          auxiliar: row.auxiliar,
          fechas: [],
          totales: []
        };
      }

      auxiliaresMap[auxiliarId].fechas.push(row.fecha);
      auxiliaresMap[auxiliarId].totales.push(parseInt(row.total_habilitados) || 0);
    });

    const auxiliares = Object.values(auxiliaresMap);

    res.json({
      auxiliares,
      total_auxiliares: auxiliares.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Error al obtener progreso de auxiliares',
      message: error.message
    });
  }
});

// Búsqueda de estudiante por DNI para descarga de constancia
app.get('/api/matriculas/buscar-por-dni/:dni', async (req, res) => {
  try {
    const { dni } = req.params;

    if (!dni || dni.trim() === '') {
      return res.status(400).json({ error: 'DNI es requerido' });
    }

    const connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        m.id AS matricula_id,
        e.nro_documento AS dni,
        CONCAT(e.paterno, ' ', e.materno, ' ', e.nombres) AS apellidos_nombres,
        m.habilitado,
        m.habilitado_estado,
        s.denominacion AS sede,
        a.denominacion AS area,
        t.denominacion AS turno,
        g.denominacion AS grupo
      FROM
        estudiantes e
        INNER JOIN matriculas m ON e.id = m.estudiantes_id
        LEFT JOIN grupo_aulas ga ON m.grupo_aulas_id = ga.id
        LEFT JOIN grupos g ON ga.grupos_id = g.id
        LEFT JOIN areas a ON ga.areas_id = a.id
        LEFT JOIN turnos t ON ga.turnos_id = t.id
        LEFT JOIN aulas au ON ga.aulas_id = au.id
        LEFT JOIN locales l ON au.locales_id = l.id
        LEFT JOIN sedes s ON l.sedes_id = s.id
      WHERE
        e.nro_documento = ?
        AND m.periodos_id = 1
      LIMIT 1
    `, [dni]);

    connection.release();

    if (result.length === 0) {
      return res.status(404).json({
        error: 'No se encontró estudiante con ese DNI',
        dni: dni
      });
    }

    const estudiante = result[0];

    res.json({
      matricula_id: estudiante.matricula_id,
      dni: estudiante.dni,
      apellidos_nombres: estudiante.apellidos_nombres,
      habilitado: estudiante.habilitado === '1',
      habilitado_estado: estudiante.habilitado_estado === '1',
      sede: estudiante.sede,
      area: estudiante.area,
      turno: estudiante.turno,
      grupo: estudiante.grupo,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Error al buscar estudiante',
      message: error.message
    });
  }
});

// Generar token encriptado para descarga de constancia
app.get('/api/matriculas/generar-token/:matricula_id', async (req, res) => {
  try {
    const { matricula_id } = req.params;

    if (!matricula_id || isNaN(matricula_id)) {
      return res.status(400).json({ error: 'ID de matrícula inválido' });
    }

    // Hacer petición a la API externa para obtener el token
    const response = await fetch(`https://sistemas.cepreuna.edu.pe/api/perfil/encrypt/${matricula_id}`);

    if (!response.ok) {
      throw new Error(`Error al generar token: ${response.status} ${response.statusText}`);
    }

    // La API devuelve el token como texto plano, no como JSON
    const token = await response.text();

    res.json({
      token: token,
      pdf_url: `https://sistemas.cepreuna.edu.pe/dga/estudiantes/pdf-constancia/${token}`,
      matricula_id: parseInt(matricula_id),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Error al generar token',
      message: error.message
    });
  }
});

// ============ ENDPOINTS LISTADO CURSO TALLER 2026 ============

// GET: obtiene el listado completo desde la base de datos local
app.get('/api/listado-curso/inscritos', cacheMiddleware(300), async (_req, res) => {
  try {
    console.log('🔄 Consultando listado desde base de datos...');
    const connection = await pool.getConnection();

    // Obtener listado completo
    const [listado] = await connection.query(`
      SELECT
        id,
        nombres,
        paterno,
        materno,
        nro_documento,
        email,
        celular,
        area,
        condicion,
        monto
      FROM inscripcion_curso_tallers
      ORDER BY id ASC
    `);

    // Obtener total
    const [[{ total }]] = await connection.query(`
      SELECT COUNT(*) as total FROM inscripcion_curso_tallers
    `);

    // Obtener totales por área
    const [porArea] = await connection.query(`
      SELECT area, COUNT(*) as total
      FROM inscripcion_curso_tallers
      GROUP BY area
      ORDER BY area
    `);

    connection.release();

    console.log(`✅ Datos obtenidos: ${listado.length} registros`);

    res.json({
      total: parseInt(total) || 0,
      por_area: porArea.map(a => ({
        area: parseInt(a.area),
        total: parseInt(a.total)
      })),
      listado: listado.map(item => ({
        id: item.id,
        nombres: item.nombres,
        paterno: item.paterno,
        materno: item.materno,
        nro_documento: item.nro_documento,
        email: item.email || '',
        area: parseInt(item.area),
        condicion: parseInt(item.condicion),
        monto: parseFloat(item.monto) || 0,
        celular: item.celular || ''
      }))
    });

  } catch (error) {
    console.error('❌ Error listado-curso inscritos:', error);
    res.status(500).json({
      error: 'Error al obtener listado',
      message: error.message
    });
  }
});

// PUT: Proxy - actualiza un inscrito en el sistema Laravel (porque usuario vista no tiene permisos UPDATE)
app.put('/api/listado-curso/actualizar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'ID inválido.' });
    }

    console.log(`🔄 Actualizando inscripción ${id} vía API Laravel...`);
    const response = await fetch(`https://sistemas.cepreuna.edu.pe/api/inscripciones/curso/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(req.body),
      timeout: 10000
    });

    console.log(`📡 Respuesta actualización: ${response.status} ${response.statusText}`);
    const data = await response.json();
    res.status(response.status).json(data);

  } catch (error) {
    console.error('❌ Error listado-curso actualizar:', error);
    res.status(500).json({
      status: false,
      error: 'Error al actualizar inscripción',
      message: error.message
    });
  }
});

// ============ ENDPOINTS CURSO TALLER 2026 ============

// Total de inscritos del curso taller
app.get('/api/curso2026/total-inscritos', cacheMiddleware(300), async (req, res) => {
  try {
    const [[result]] = await pool.execute(`
      SELECT COUNT(*) AS total
      FROM inscripcion_curso_tallers
    `);
    res.json({ total: result.total || 0 });
  } catch (error) {
    console.error('Error total-inscritos curso2026:', error);
    res.status(500).json({ error: 'Error al obtener total de inscritos', message: error.message });
  }
});

// Distribución por género
app.get('/api/curso2026/distribucion-genero', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        sexo,
        COUNT(*) AS total
      FROM inscripcion_curso_tallers
      WHERE sexo IS NOT NULL
      GROUP BY sexo
    `);

    const masculino = rows.find(r => r.sexo === 'M' || r.sexo === 'MASCULINO')?.total || 0;
    const femenino = rows.find(r => r.sexo === 'F' || r.sexo === 'FEMENINO')?.total || 0;

    res.json({ masculino, femenino });
  } catch (error) {
    console.error('Error distribucion-genero curso2026:', error);
    // Enviar datos por defecto en caso de error
    res.json({ masculino: 0, femenino: 0 });
  }
});

// Top instituciones
app.get('/api/curso2026/top-instituciones', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        colegio_procedencia,
        COUNT(*) AS total_inscritos
      FROM inscripcion_curso_tallers
      WHERE colegio_procedencia IS NOT NULL AND colegio_procedencia != ''
      GROUP BY colegio_procedencia
      ORDER BY total_inscritos DESC
      LIMIT 10
    `);
    res.json(rows);
  } catch (error) {
    console.error('Error top-instituciones curso2026:', error);
    // Enviar array vacío en caso de error
    res.json([]);
  }
});

// Inscritos por área del curso taller
app.get('/api/curso2026/inscritos-por-area', cacheMiddleware(300), async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        area,
        COUNT(*) AS total_inscritos
      FROM inscripcion_curso_tallers
      GROUP BY area
      ORDER BY area
    `);
    res.json(rows);
  } catch (error) {
    console.error('Error inscritos-por-area curso2026:', error);
    res.status(500).json({ error: 'Error al obtener inscritos por área', message: error.message });
  }
});

// Pagos del curso taller (desde 08-Feb-2026, importe >= 41)
app.get('/api/curso2026/pagos', async (req, res) => {
  try {
    const [[resumen]] = await pool.execute(`
      SELECT COUNT(*) AS total_pagos
      FROM banco_pagos
      WHERE fch_pag >= '2026-02-08' AND imp_pag >= 41
    `);

    res.json({
      total_pagos: resumen.total_pagos || 0
    });
  } catch (error) {
    console.error('Error pagos curso2026:', error);
    res.status(500).json({ error: 'Error al obtener pagos', message: error.message });
  }
});

// Buscar inscrito al curso taller por DNI
app.get('/api/curso2026/buscar/:dni', async (req, res) => {
  try {
    const { dni } = req.params;
    if (!dni || !/^\d{8}$/.test(dni)) {
      return res.status(400).json({ error: 'DNI inválido. Debe tener 8 dígitos.' });
    }

    const [rows] = await pool.execute(`
      SELECT
        nombres, paterno, materno,
        nro_documento, area, condicion, path
      FROM inscripcion_curso_tallers
      WHERE nro_documento = ?
      LIMIT 1
    `, [dni]);

    if (rows.length === 0) {
      return res.status(404).json({ encontrado: false, message: 'No se encontró inscripción para este DNI.' });
    }

    const inscrito = rows[0];
    const AREAS = {
      1: 'Razonamiento Matemático, Aritmética, Álgebra, Geometría, Trigonometría',
      2: 'Razonamiento Verbal, Comunicación, Literatura, Quechua y Aimara',
      3: 'Física, Química, Biología y Anatomía',
      4: 'Geografía, Historia, Educación Cívica, Economía, Psicología y Filosofía'
    };

    res.json({
      encontrado: true,
      nombres: `${inscrito.paterno} ${inscrito.materno}, ${inscrito.nombres}`,
      nro_documento: inscrito.nro_documento,
      area: inscrito.area,
      area_descripcion: AREAS[inscrito.area] || `Área ${inscrito.area}`,
      condicion: inscrito.condicion == 1 ? 'UNAP' : 'Particular',
      pdf_url: inscrito.path ? `https://sistemas.cepreuna.edu.pe/${inscrito.path}` : null
    });

  } catch (error) {
    console.error('Error búsqueda curso2026:', error);
    res.status(500).json({ error: 'Error al buscar inscripción', message: error.message });
  }
});

// ============ ENDPOINTS EXTEMPORÁNEOS ============

// Configurar multer para subir archivos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
});

// 1. POST: Validar voucher (proxy a API externa)
app.post('/api/extemporaneo/validar-voucher', upload.single('archivo'), async (req, res) => {
  try {
    const { tipo_pago, nro_documento, secuencia, fecha, monto } = req.body;
    const archivo = req.file;

    const debugInfo = {
      received: {
        tipo_pago,
        tipo_pago_type: typeof tipo_pago,
        nro_documento,
        secuencia,
        fecha,
        monto,
        monto_type: typeof monto,
        archivo_recibido: !!archivo,
        archivo_size: archivo ? archivo.size : 0,
        archivo_mimetype: archivo ? archivo.mimetype : null
      }
    };

    console.log('📥 Request recibido:', debugInfo.received);

    if (!archivo) {
      return res.status(400).json({
        error: 'Archivo es requerido',
        debug: {
          body_keys: Object.keys(req.body),
          file_received: !!req.file
        }
      });
    }

    // La API espera tipo_pago como INTEGER (1 o 2) y monto como NUMBER
    const tipo_pago_int = parseInt(tipo_pago);
    const monto_num = parseFloat(monto);

    // Validar que tipo_pago sea 1 o 2
    if (tipo_pago_int !== 1 && tipo_pago_int !== 2) {
      console.log(`❌ Tipo de pago inválido: ${tipo_pago}`);
      return res.status(400).json({
        error: 'Tipo de pago inválido',
        detail: 'El tipo de pago debe ser 1 (Ventanilla BN) o 2 (Pagalo.pe)',
        received: tipo_pago
      });
    }

    console.log(`🔄 Validando voucher para DNI: ${nro_documento}, tipo_pago: ${tipo_pago_int} (${tipo_pago_int === 1 ? 'Ventanilla BN' : 'Pagalo.pe'})...`);

    // Crear FormData usando FormData global nativo de Node.js 18+
    // Crear un Blob del archivo
    const fileBlob = new Blob([archivo.buffer], { type: archivo.mimetype });
    const file = new File([fileBlob], archivo.originalname, { type: archivo.mimetype });

    const formData = new FormData();

    // FormData nativo debería manejar los tipos correctamente
    formData.append('tipo_pago', tipo_pago_int.toString());
    formData.append('nro_documento', String(nro_documento).trim());
    formData.append('secuencia', String(secuencia).trim());
    formData.append('fecha', String(fecha).trim());
    formData.append('monto', monto_num.toString());
    formData.append('archivo', file, archivo.originalname);

    console.log('📤 Enviando a API externa con FormData nativo:', {
      tipo_pago: tipo_pago_int.toString(),
      nro_documento: String(nro_documento).trim(),
      secuencia: String(secuencia).trim(),
      fecha: String(fecha).trim(),
      monto: monto_num.toString(),
      filename: archivo.originalname,
      filesize: archivo.size,
      mimetype: archivo.mimetype
    });

    const response = await fetch('https://prepagovalido.waready.org.pe/api/v1/vouchers/validate', {
      method: 'POST',
      body: formData
      // No agregar headers manualmente con FormData nativo
    });

    const data = await response.json();
    console.log(`📡 Respuesta validación voucher: ${response.status}`, data);

    // Si es error, agregar debug info
    if (!response.ok) {
      debugInfo.sent_to_api = {
        tipo_pago: tipo_pago_int,
        nro_documento: String(nro_documento).trim(),
        secuencia: String(secuencia).trim(),
        fecha: String(fecha).trim(),
        monto: monto_num,
        archivo_name: archivo.originalname
      };
      debugInfo.api_response = data;

      return res.status(response.status).json({
        ...data,
        _debug: debugInfo
      });
    }

    res.status(response.status).json(data);

  } catch (error) {
    console.error('❌ Error validar voucher:', error);
    res.status(500).json({
      error: 'Error al validar voucher',
      message: error.message
    });
  }
});

// 2. GET: Resumen de pagos por DNI (proxy a API externa)
app.get('/api/extemporaneo/resumen-pagos/:nro_documento', async (req, res) => {
  try {
    const { nro_documento } = req.params;

    if (!nro_documento || !/^\d+$/.test(nro_documento)) {
      return res.status(400).json({ error: 'Número de documento inválido' });
    }

    console.log(`🔄 Consultando resumen de pagos para DNI: ${nro_documento}...`);

    const response = await fetch(`https://prepagovalido.waready.org.pe/api/v1/pagos/resumen/${nro_documento}`);
    const data = await response.json();

    console.log(`📡 Respuesta resumen pagos: ${response.status}`);

    res.status(response.status).json(data);

  } catch (error) {
    console.error('❌ Error resumen pagos:', error);
    res.status(500).json({
      error: 'Error al obtener resumen de pagos',
      message: error.message
    });
  }
});

// 3. POST: Crear inscripción (proxy a API externa)
app.post('/api/extemporaneo/inscripcion', async (req, res) => {
  try {
    const { tipo_documento, nro_documento, nombres, paterno, materno, celular, email, area, condicion } = req.body;

    // Validaciones básicas
    if (!tipo_documento || !nro_documento || !nombres || !paterno || !materno || !celular || !email || !area || !condicion) {
      return res.status(400).json({
        error: 'Faltan campos requeridos',
        detail: 'Todos los campos son obligatorios'
      });
    }

    console.log(`🔄 Creando inscripción para DNI: ${nro_documento}...`);

    const response = await fetch('https://prepagovalido.waready.org.pe/api/v1/inscripciones', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        tipo_documento,
        nro_documento,
        nombres,
        paterno,
        materno,
        celular,
        email,
        area: parseInt(area),
        condicion: parseInt(condicion)
      })
    });

    const data = await response.json();
    console.log(`📡 Respuesta inscripción: ${response.status}`);

    res.status(response.status).json(data);

  } catch (error) {
    console.error('❌ Error crear inscripción:', error);
    res.status(500).json({
      error: 'Error al crear inscripción',
      message: error.message
    });
  }
});

// Endpoint para listar materiales por área
app.get('/api/materiales/area/:areaNum', async (req, res) => {
  try {
    const { areaNum } = req.params;
    const fs = require('fs').promises;
    const path = require('path');

    // Validar que el área sea 1, 2, 3 o 4
    if (!/^[1-4]$/.test(areaNum)) {
      return res.status(400).json({ error: 'Área inválida. Debe ser 1, 2, 3 o 4' });
    }

    const dirPath = path.join(__dirname, 'materiales', `area-${areaNum}`);

    try {
      const files = await fs.readdir(dirPath);

      // Filtrar solo archivos (no directorios) y obtener info
      const filesInfo = await Promise.all(
        files.map(async (file) => {
          const filePath = path.join(dirPath, file);
          const stats = await fs.stat(filePath);

          if (!stats.isFile()) return null;

          // Determinar tipo de archivo
          const ext = path.extname(file).toLowerCase();
          let tipo = 'otro';
          if (['.pptx', '.ppt'].includes(ext)) tipo = 'presentacion';
          else if (['.docx', '.doc'].includes(ext)) tipo = 'documento';
          else if (['.pdf'].includes(ext)) tipo = 'pdf';

          // Calcular tamaño en formato legible
          const bytes = stats.size;
          let tamañoFormateado;
          if (bytes < 1024) tamañoFormateado = bytes + ' B';
          else if (bytes < 1024 * 1024) tamañoFormateado = (bytes / 1024).toFixed(1) + ' KB';
          else tamañoFormateado = (bytes / (1024 * 1024)).toFixed(1) + ' MB';

          return {
            nombre: file,
            tipo,
            tamaño: tamañoFormateado,
            url: `/materiales/area-${areaNum}/${encodeURIComponent(file)}`
          };
        })
      );

      // Filtrar nulls y agrupar por tipo
      const archivos = filesInfo.filter(f => f !== null);

      const resultado = {
        presentaciones: archivos.filter(f => f.tipo === 'presentacion'),
        documentos: archivos.filter(f => f.tipo === 'documento'),
        pdfs: archivos.filter(f => f.tipo === 'pdf')
      };

      res.json(resultado);

    } catch (err) {
      if (err.code === 'ENOENT') {
        // Carpeta no existe, devolver vacío
        res.json({ presentaciones: [], documentos: [], pdfs: [] });
      } else {
        throw err;
      }
    }

  } catch (error) {
    console.error('Error al listar materiales:', error);
    res.status(500).json({
      error: 'Error al listar materiales',
      message: error.message
    });
  }
});

// ============ FORMS-ADMIN: PROXY APPS SCRIPT (DNI lookup + envío) ============
// Evita el JSONP y el mode:'no-cors' en el cliente: aquí sí podemos leer la respuesta real.

// Verificar DNI contra el Apps Script (equivalente a la antigua llamada JSONP).
app.get('/api/forms-admin/check-dni/:dni', async (req, res) => {
  const dni = String(req.params.dni || '').trim();
  if (!/^\d{8}$/.test(dni)) {
    return res.status(400).json({ error: 'DNI inválido' });
  }
  const scriptUrl = process.env.APPS_SCRIPT_URL;
  if (!scriptUrl) {
    return res.status(500).json({ error: 'APPS_SCRIPT_URL no configurado' });
  }
  try {
    // El Apps Script actual responde en formato JSONP cuando se pasa `callback`.
    // Pasamos un callback conocido y desempaquetamos la respuesta para devolver JSON real.
    const cb = '__proxyCb__';
    const upstream = await fetch(`${scriptUrl}?dni=${encodeURIComponent(dni)}&callback=${cb}`);
    const text = (await upstream.text()).trim();
    const match = text.match(new RegExp(`^${cb}\\((.*)\\);?$`, 's'));
    const jsonText = match ? match[1] : text;
    try {
      res.status(upstream.status).json(JSON.parse(jsonText));
    } catch {
      res.status(502).json({ error: 'Respuesta no parseable del Apps Script', raw: jsonText.slice(0, 500) });
    }
  } catch (err) {
    console.error('Error proxy check-dni:', err);
    res.status(502).json({ error: 'Error consultando Apps Script' });
  }
});

// Enviar el formulario al Apps Script y devolver la respuesta real.
// El límite de body está elevado globalmente (ver app.use(express.json({ limit: '6mb' })) arriba)
// porque la foto viaja en Base64 (~2.7MB cuando la original es 2MB).
app.post('/api/forms-admin/submit', async (req, res) => {
  const scriptUrl = process.env.APPS_SCRIPT_URL;
  if (!scriptUrl) {
    return res.status(500).json({ error: 'APPS_SCRIPT_URL no configurado' });
  }
  try {
    const upstream = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    const text = await upstream.text();
    try {
      res.status(upstream.status).json(JSON.parse(text));
    } catch {
      res.status(upstream.status).json({ success: upstream.ok, raw: text.slice(0, 500) });
    }
  } catch (err) {
    console.error('Error proxy submit:', err);
    res.status(502).json({ error: 'Error enviando al Apps Script' });
  }
});

// ============ FORMS-ADMIN: PROXY APISPERU (RUC) ============
// Mantiene el token JWT en el servidor en lugar de exponerlo en el cliente.
app.get('/api/forms-admin/ruc/:ruc', async (req, res) => {
  const ruc = String(req.params.ruc || '').trim();
  if (!/^\d{11}$/.test(ruc)) {
    return res.status(400).json({ error: 'RUC inválido' });
  }
  const token = process.env.APISPERU_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'APISPERU_TOKEN no configurado' });
  }
  try {
    const upstream = await fetch(`https://dniruc.apisperu.com/api/v1/ruc/${ruc}?token=${token}`);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Error proxy apisperu:', err);
    res.status(502).json({ error: 'Error consultando apisperu' });
  }
});

// ============ ENDPOINTS ESTADÍSTICAS INSCRIPCIONES ============

// 1. Total de inscritos
app.get('/api/stats-inscripciones/totales', requireStatsAuth, cacheMiddleware(180), async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [[totales]] = await connection.query(`
      SELECT
        COUNT(DISTINCT id) as total_inscritos,
        SUM(CASE WHEN modalidad = '1' THEN 1 ELSE 0 END) as total_virtual,
        SUM(CASE WHEN modalidad = '2' THEN 1 ELSE 0 END) as total_presencial,
        (SELECT COUNT(*) FROM banco_pagos WHERE fch_pag >= '2026-02-25' AND imp_pag > 200) as total_pagos_25feb,
        (SELECT COUNT(*) FROM inscripciones WHERE periodos_id = 1 AND DATE(created_at) = CURDATE()) as total_hoy
      FROM inscripciones
      WHERE periodos_id = 1
    `);

    connection.release();

    res.json({
      total_inscritos: parseInt(totales.total_inscritos) || 0,
      total_virtual: parseInt(totales.total_virtual) || 0,
      total_presencial: parseInt(totales.total_presencial) || 0,
      total_pagos_25feb: parseInt(totales.total_pagos_25feb) || 0,
      total_hoy: parseInt(totales.total_hoy) || 0,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error en totales:', error);
    res.status(500).json({ error: 'Error al obtener totales', message: error.message });
  }
});

// 2. Inscritos por sede
app.get('/api/stats-inscripciones/por-sede', requireStatsAuth, cacheMiddleware(300), async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        s.denominacion as sede,
        s.id as sede_id,
        COUNT(DISTINCT i.id) as total_inscritos,
        SUM(CASE WHEN i.modalidad = '1' THEN 1 ELSE 0 END) as \`virtual\`,
        SUM(CASE WHEN i.modalidad = '2' THEN 1 ELSE 0 END) as presencial
      FROM sedes s
      LEFT JOIN inscripciones i ON i.sedes_id = s.id AND i.periodos_id = 1
      GROUP BY s.id, s.denominacion
      ORDER BY total_inscritos DESC
    `);

    connection.release();

    const sedes = result.map(row => ({
      sede_id: parseInt(row.sede_id) || 0,
      sede: row.sede,
      total_inscritos: parseInt(row.total_inscritos) || 0,
      virtual: parseInt(row.virtual) || 0,
      presencial: parseInt(row.presencial) || 0
    }));

    res.json({ sedes, timestamp: new Date().toISOString() });

  } catch (error) {
    if (connection) connection.release();
    console.error('Error por sede:', error);
    res.status(500).json({ error: 'Error al obtener datos por sede', message: error.message });
  }
});

// 3. Inscritos por área
app.get('/api/stats-inscripciones/por-area', requireStatsAuth, cacheMiddleware(300), async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        a.denominacion as area,
        a.id as area_id,
        COUNT(DISTINCT i.id) as total_inscritos,
        SUM(CASE WHEN i.modalidad = '1' THEN 1 ELSE 0 END) as \`virtual\`,
        SUM(CASE WHEN i.modalidad = '2' THEN 1 ELSE 0 END) as presencial
      FROM inscripciones i
      INNER JOIN areas a ON i.areas_id = a.id
      WHERE i.periodos_id = 1
      GROUP BY a.id, a.denominacion
      ORDER BY total_inscritos DESC
    `);

    connection.release();

    const areas = result.map(row => ({
      area_id: parseInt(row.area_id) || 0,
      area: row.area,
      total_inscritos: parseInt(row.total_inscritos) || 0,
      virtual: parseInt(row.virtual) || 0,
      presencial: parseInt(row.presencial) || 0
    }));

    res.json({ areas, timestamp: new Date().toISOString() });

  } catch (error) {
    if (connection) connection.release();
    console.error('Error por área:', error);
    res.status(500).json({ error: 'Error al obtener datos por área', message: error.message });
  }
});

// 4. Inscritos por turno
app.get('/api/stats-inscripciones/por-turno', requireStatsAuth, cacheMiddleware(300), async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        t.denominacion as turno,
        t.id as turno_id,
        COUNT(DISTINCT i.id) as total_inscritos,
        SUM(CASE WHEN i.modalidad = '1' THEN 1 ELSE 0 END) as \`virtual\`,
        SUM(CASE WHEN i.modalidad = '2' THEN 1 ELSE 0 END) as presencial
      FROM inscripciones i
      INNER JOIN turnos t ON i.turnos_id = t.id
      WHERE i.periodos_id = 1
      GROUP BY t.id, t.denominacion
      ORDER BY total_inscritos DESC
    `);

    connection.release();

    const turnos = result.map(row => ({
      turno_id: parseInt(row.turno_id) || 0,
      turno: row.turno,
      total_inscritos: parseInt(row.total_inscritos) || 0,
      virtual: parseInt(row.virtual) || 0,
      presencial: parseInt(row.presencial) || 0
    }));

    res.json({ turnos, timestamp: new Date().toISOString() });

  } catch (error) {
    if (connection) connection.release();
    console.error('Error por turno:', error);
    res.status(500).json({ error: 'Error al obtener datos por turno', message: error.message });
  }
});

// 5. Inscritos por día
app.get('/api/stats-inscripciones/por-dia', requireStatsAuth, cacheMiddleware(300), async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        DATE(created_at) as fecha,
        COUNT(DISTINCT id) as total_inscritos,
        SUM(CASE WHEN modalidad = '1' THEN 1 ELSE 0 END) as \`virtual\`,
        SUM(CASE WHEN modalidad = '2' THEN 1 ELSE 0 END) as presencial
      FROM inscripciones
      WHERE periodos_id = 1 AND created_at IS NOT NULL
      GROUP BY DATE(created_at)
      ORDER BY fecha ASC
    `);

    connection.release();

    const dias = result.map(row => ({
      fecha: row.fecha,
      total_inscritos: parseInt(row.total_inscritos) || 0,
      virtual: parseInt(row.virtual) || 0,
      presencial: parseInt(row.presencial) || 0
    }));

    res.json({ dias, timestamp: new Date().toISOString() });

  } catch (error) {
    if (connection) connection.release();
    console.error('Error por día:', error);
    res.status(500).json({ error: 'Error al obtener datos por día', message: error.message });
  }
});

// 6. Pagos por día (desde 25 Feb 2026, imp_pag > 200)
app.get('/api/stats-inscripciones/pagos-por-dia', requireStatsAuth, cacheMiddleware(300), async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [result] = await connection.query(`
      SELECT
        DATE(fch_pag) as fecha,
        COUNT(*) as total_pagos,
        SUM(imp_pag) as total_monto
      FROM banco_pagos
      WHERE fch_pag >= '2026-02-25' AND imp_pag > 200 AND fch_pag IS NOT NULL
      GROUP BY DATE(fch_pag)
      ORDER BY fecha ASC
    `);

    connection.release();

    const dias = result.map(row => ({
      fecha: row.fecha,
      total_pagos: parseInt(row.total_pagos) || 0,
      total_monto: parseFloat(row.total_monto) || 0
    }));

    res.json({ dias, timestamp: new Date().toISOString() });

  } catch (error) {
    if (connection) connection.release();
    console.error('Error pagos por día:', error);
    res.status(500).json({ error: 'Error al obtener pagos por día', message: error.message });
  }
});

// 7. Filtro combinado: Sede + Área + Turno (muestra 0 si no hay inscritos)
app.get('/api/stats-inscripciones/filtro-completo', requireStatsAuth, async (req, res) => {
  try {
    const { sede_id, area_id, turno_id } = req.query;

    const connection = await pool.getConnection();

    // Generar todas las combinaciones posibles desde grupo_aulas
    // y hacer LEFT JOIN con inscripciones para contar inscritos (0 si no hay)
    let query = `
      SELECT
        s.denominacion as sede,
        a.denominacion as area,
        t.denominacion as turno,
        COUNT(DISTINCT i.id) as total_inscritos
      FROM grupo_aulas ga
      INNER JOIN areas a ON ga.areas_id = a.id
      INNER JOIN turnos t ON ga.turnos_id = t.id
      INNER JOIN aulas au ON ga.aulas_id = au.id
      INNER JOIN locales l ON au.locales_id = l.id
      INNER JOIN sedes s ON l.sedes_id = s.id
      LEFT JOIN inscripciones i ON i.sedes_id = s.id
        AND i.areas_id = a.id
        AND i.turnos_id = t.id
        AND i.periodos_id = 1
      WHERE 1=1
    `;

    const params = [];

    if (sede_id) {
      query += ` AND s.id = ?`;
      params.push(sede_id);
    }

    if (area_id) {
      query += ` AND a.id = ?`;
      params.push(area_id);
    }

    if (turno_id) {
      query += ` AND t.id = ?`;
      params.push(turno_id);
    }

    query += `
      GROUP BY s.denominacion, a.denominacion, t.denominacion
      ORDER BY s.denominacion, a.denominacion, t.denominacion
    `;

    const [result] = await connection.query(query, params);
    connection.release();

    const data = result.map(row => ({
      sede: row.sede,
      area: row.area,
      turno: row.turno,
      total_inscritos: parseInt(row.total_inscritos) || 0
    }));

    res.json({ data, total: data.length, timestamp: new Date().toISOString() });

  } catch (error) {
    console.error('Error filtro completo:', error);
    res.status(500).json({ error: 'Error al obtener datos filtrados', message: error.message });
  }
});

// 8. Todas las sedes (incluidas las que no tienen inscritos)
app.get('/api/stats-inscripciones/todas-sedes', requireStatsAuth, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    const [sedes] = await connection.query(`
      SELECT id, denominacion
      FROM sedes
      ORDER BY denominacion
    `);

    connection.release();

    res.json({
      sedes: sedes.map(s => ({ sede_id: s.id, sede: s.denominacion })),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    if (connection) connection.release();
    console.error('Error todas las sedes:', error);
    res.status(500).json({ error: 'Error al obtener todas las sedes', message: error.message });
  }
});

// 9. Áreas y turnos disponibles por sede
app.get('/api/stats-inscripciones/opciones-por-sede/:sedeId', requireStatsAuth, async (req, res) => {
  let connection;
  try {
    const { sedeId } = req.params;
    connection = await pool.getConnection();

    // Obtener áreas disponibles para esta sede desde grupo_aulas
    const [areas] = await connection.query(`
      SELECT DISTINCT a.id as area_id, a.denominacion as area
      FROM grupo_aulas ga
      INNER JOIN areas a ON ga.areas_id = a.id
      INNER JOIN aulas au ON ga.aulas_id = au.id
      INNER JOIN locales l ON au.locales_id = l.id
      WHERE l.sedes_id = ?
      ORDER BY a.id
    `, [sedeId]);

    // Obtener turnos disponibles para esta sede desde grupo_aulas
    const [turnos] = await connection.query(`
      SELECT DISTINCT t.id as turno_id, t.denominacion as turno
      FROM grupo_aulas ga
      INNER JOIN turnos t ON ga.turnos_id = t.id
      INNER JOIN aulas au ON ga.aulas_id = au.id
      INNER JOIN locales l ON au.locales_id = l.id
      WHERE l.sedes_id = ?
      ORDER BY t.id
    `, [sedeId]);

    connection.release();

    res.json({
      areas: areas.map(a => ({ area_id: a.area_id, area: a.area })),
      turnos: turnos.map(t => ({ turno_id: t.turno_id, turno: t.turno })),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    if (connection) connection.release();
    console.error('Error opciones por sede:', error);
    res.status(500).json({ error: 'Error al obtener opciones por sede', message: error.message });
  }
});

// 10. Reporte detallado: Sede > Turno > Área (para página de reportes)
app.get('/api/stats-inscripciones/reporte-sedes', requireStatsAuth, cacheMiddleware(300), async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();

    // Obtener todas las sedes
    const [sedes] = await connection.query(`
      SELECT id as sede_id, denominacion as sede
      FROM sedes
      ORDER BY denominacion
    `);

    const reporteCompleto = [];

    for (const sede of sedes) {
      // Determinar si es virtual
      const esVirtual = sede.sede.toLowerCase().includes('virtual');

      // Obtener turnos que tienen inscripciones o capacidad configurada en esta sede
      const [turnos] = await connection.query(`
        SELECT DISTINCT t.id as turno_id, t.denominacion as turno
        FROM turnos t
        WHERE t.id IN (
          SELECT DISTINCT turnos_id FROM inscripciones WHERE sedes_id = ? AND periodos_id = 1
          UNION
          SELECT DISTINCT turnos_id FROM configuracion_vacantes WHERE sedes_id = ? AND estado = '1'
        )
        ORDER BY t.id
      `, [sede.sede_id, sede.sede_id]);

      const turnosData = [];

      for (const turno of turnos) {
        // Obtener áreas con inscritos o capacidad para esta sede y turno
        const [areas] = await connection.query(`
          SELECT 
            a.id as area_id, 
            a.denominacion as area,
            COUNT(DISTINCT i.id) as total_inscritos,
            COALESCE(cv.cantidad, 0) as capacidad
          FROM areas a
          LEFT JOIN inscripciones i ON i.areas_id = a.id 
            AND i.sedes_id = ? 
            AND i.turnos_id = ? 
            AND i.periodos_id = 1
          LEFT JOIN configuracion_vacantes cv ON a.id = cv.areas_id
            AND cv.sedes_id = ?
            AND cv.turnos_id = ?
          GROUP BY a.id, a.denominacion, cv.cantidad
          HAVING total_inscritos > 0 OR capacidad > 0
          ORDER BY a.denominacion
        `, [sede.sede_id, turno.turno_id, sede.sede_id, turno.turno_id]);

        if (areas.length > 0) {
          turnosData.push({
            turno_id: turno.turno_id,
            turno: turno.turno,
            areas: areas.map(a => {
              const inscritos = parseInt(a.total_inscritos) || 0;
              const capacidad = parseInt(a.capacidad) || 0;
              return {
                area_id: a.area_id,
                area: a.area,
                total_inscritos: inscritos,
                capacidad: capacidad,
                vacantes_disponibles: Math.max(0, capacidad - inscritos)
              };
            })
          });
        }
      }

      reporteCompleto.push({
        sede_id: sede.sede_id,
        sede: sede.sede,
        es_virtual: esVirtual,
        turnos: turnosData
      });
    }

    connection.release();

    res.json({
      reporte: reporteCompleto,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    if (connection) connection.release();
    console.error('Error en reporte de sedes:', error);
    res.status(500).json({ error: 'Error al generar reporte', message: error.message });
  }
});

// 11. Reporte de Pagos Efectuados (FIFO) — alumnos
//
// Lee `reporte-pagos.sql` y aplica filtros opcionales:
//   - estado: '0' (PreInscrito) | '1' (Inscrito)
//   - cuotaN: '0' (PAGADA) | '1' (no PAGADA)  para N ∈ {1,2,3,4}
//   - q: búsqueda libre por DNI o nombre completo
//
// El SQL base no tiene WHERE; lo envolvemos en `SELECT * FROM (...) AS t` para
// poder filtrar por las columnas alias (estado_cuota1, etc.) sin tocar el SQL fuente.
// Construye { sql, params } del reporte de pagos según filtros + rol.
// Devuelve { blocked: true } si el rol no tiene grupos asignados.
function buildReportePagosQuery(req) {
  const { cuota1, cuota2, cuota3, cuota4, q } = req.query;
  const { grupos: gruposPermitidos } = req.user;

  if (Array.isArray(gruposPermitidos) && gruposPermitidos.length === 0) return { blocked: true };

  const conditions = [];
  const params = [];

  // Filtro por rol: si grupos es array (no admin), restringir a esos grupo_aulas_id
  if (Array.isArray(gruposPermitidos)) {
    conditions.push(`grupo_aulas_id IN (${gruposPermitidos.map(() => '?').join(',')})`);
    params.push(...gruposPermitidos);
  }

  // Filtro opcional por grupos seleccionados en la UI (se intersecta con los permitidos).
  const gruposSel = parseList(req.query.grupos);
  if (gruposSel.length) {
    conditions.push(`grupo_aulas_id IN (${gruposSel.map(() => '?').join(',')})`);
    params.push(...gruposSel);
  }

  // Nota: el filtro de "solo inscritos" (estado='1') vive en el SQL base.
  const cuotaFilter = (val, col) => {
    if (val === '0') conditions.push(`${col} = 'PAGADA'`);
    else if (val === '1') conditions.push(`${col} <> 'PAGADA'`);
  };
  cuotaFilter(cuota1, 'estado_cuota1');
  cuotaFilter(cuota2, 'estado_cuota2');
  cuotaFilter(cuota3, 'estado_cuota3');
  cuotaFilter(cuota4, 'estado_cuota4');

  if (q && String(q).trim().length > 0) {
    conditions.push('nro_documento LIKE ?');
    params.push(`%${String(q).trim()}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM (${REPORTE_PAGOS_SQL_BASE}) AS t ${where} ORDER BY paterno, materno, nombres`;
  return { sql, params };
}

// El SQL base no tiene WHERE; lo envolvemos en `SELECT * FROM (...) AS t` para
// poder filtrar por las columnas alias (estado_cuota1, etc.) sin tocar el SQL fuente.
app.get('/api/stats/reporte-pagos', requireStatsAuth, cacheMiddleware(120), async (req, res) => {
  let connection;
  try {
    const q = buildReportePagosQuery(req);
    if (q.blocked) return res.json({ total: 0, registros: [], timestamp: new Date().toISOString() });

    connection = await pool.getConnection();
    const [rows] = await connection.query(q.sql, q.params);
    connection.release();

    res.json({ total: rows.length, registros: rows, timestamp: new Date().toISOString() });
  } catch (error) {
    if (connection) connection.release();
    console.error('Error reporte-pagos:', error);
    res.status(500).json({ error: 'Error al generar reporte de pagos' });
  }
});

// Ficha de un alumno (modal en /stats/alumnos): contacto + asistencia del ciclo.
// Asistencia por alumno desde asistencia_estudiante_detalles (estado: 1=presente,
// 2=tarde, 3=falta), fecha vía la sesión asistencia_estudiantes. Rango del ciclo:
// 23/03 → 10/07/2026 (16 semanas, lunes a viernes).
const CICLO_ASIS = { desde: '2026-03-23', hasta: '2026-07-10' };
app.get('/api/stats/alumno/:dni', requireStatsAuth, async (req, res) => {
  let conn;
  try {
    const dni = String(req.params.dni || '').trim();
    if (!/^\d{6,12}$/.test(dni)) return res.status(400).json({ error: 'DNI inválido' });
    conn = await pool.getConnection();

    const [[est]] = await conn.query(`
      SELECT e.id, e.nro_documento AS dni, e.celular, e.email,
             CONCAT_WS(' ', e.paterno, e.materno, e.nombres) AS nombre
      FROM estudiantes e WHERE e.nro_documento = ?`, [dni]);
    if (!est) { conn.release(); return res.status(404).json({ error: 'Estudiante no encontrado' }); }

    // Contexto académico (sede/grupo) del periodo activo
    const [[ctx]] = await conn.query(`
      SELECT ANY_VALUE(s.denominacion) AS sede,
             ANY_VALUE(g.denominacion) AS grupo,
             ANY_VALUE(ar.denominacion) AS area,
             ANY_VALUE(t.denominacion) AS turno,
             ANY_VALUE(m.grupo_aulas_id) AS grupo_aulas_id
      FROM inscripciones i
      LEFT JOIN matriculas m ON m.estudiantes_id = i.estudiantes_id AND m.periodos_id = i.periodos_id
      LEFT JOIN grupo_aulas ga ON ga.id = m.grupo_aulas_id
      LEFT JOIN grupos g ON g.id = ga.grupos_id
      LEFT JOIN areas ar ON ar.id = ga.areas_id
      LEFT JOIN turnos t ON t.id = ga.turnos_id
      LEFT JOIN sedes s ON s.id = i.sedes_id
      WHERE i.estudiantes_id = ? AND i.periodos_id = 1 AND i.estado = '1'
      GROUP BY i.estudiantes_id`, [est.id]);

    // Restricción por rol: un usuario no-admin solo ve alumnos de sus grupos.
    const permitidos = req.user.grupos;
    if (Array.isArray(permitidos)) {
      const gid = ctx && Number(ctx.grupo_aulas_id);
      if (!gid || !permitidos.map(Number).includes(gid)) {
        conn.release();
        return res.status(403).json({ error: 'Sin acceso a este alumno' });
      }
    }

    const [asis] = await conn.query(`
      SELECT DATE_FORMAT(ae.fecha, '%Y-%m-%d') AS fecha, MAX(aed.estado) AS estado
      FROM asistencia_estudiante_detalles aed
      JOIN asistencia_estudiantes ae ON ae.id = aed.asistencia_estudiantes_id
      WHERE aed.estudiantes_id = ? AND ae.fecha BETWEEN ? AND ?
      GROUP BY ae.fecha
      ORDER BY ae.fecha`, [est.id, CICLO_ASIS.desde, CICLO_ASIS.hasta]);
    conn.release();

    const resumen = { presente: 0, tarde: 0, falta: 0 };
    for (const r of asis) {
      if (r.estado === '1') resumen.presente++;
      else if (r.estado === '2') resumen.tarde++;
      else if (r.estado === '3') resumen.falta++;
    }
    const totalReg = asis.length;
    resumen.total = totalReg;
    resumen.pct = totalReg ? Math.round(100 * (resumen.presente + resumen.tarde) / totalReg) : null;

    res.json({ ...est, ...(ctx || {}), asistencia: asis, resumen, rango: CICLO_ASIS });
  } catch (error) {
    if (conn) conn.release();
    console.error('Error ficha alumno:', error);
    res.status(500).json({ error: 'Error al obtener la ficha del alumno' });
  }
});

// Descarga Excel del reporte de pagos con los filtros aplicados.
app.get('/api/stats/reporte-pagos/excel', requireStatsAuth, async (req, res) => {
  let connection;
  try {
    const q = buildReportePagosQuery(req);
    const rows = q.blocked ? [] : await (async () => {
      connection = await pool.getConnection();
      const [r] = await connection.query(q.sql, q.params);
      connection.release();
      return r;
    })();

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CEPREUNA Stats';
    const ws = wb.addWorksheet('Reporte de pagos');

    const headers = ['N°', 'DNI', 'Apellidos y Nombres', 'Sede', 'Área', 'Turno', 'Grupo',
      'Tipo Colegio', '1ra', '2da', '3ra', '4ta'];
    const lastCol = headers.length;

    ws.mergeCells(1, 1, 1, lastCol);
    ws.getCell(1, 1).value = 'Reporte de pagos por estudiante (solo inscritos)';
    ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    ws.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
    ws.getCell(1, 1).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 24;
    ws.mergeCells(2, 1, 2, lastCol);
    ws.getCell(2, 1).value = `Generado: ${new Date().toLocaleString('es-PE')}`;
    ws.getCell(2, 1).font = { italic: true, size: 10, color: { argb: 'FF666666' } };
    ws.getCell(2, 1).alignment = { horizontal: 'center' };

    const headerRow = ws.getRow(4);
    headerRow.values = headers;
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, size: 9 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    // Color por estado de cuota (igual que la web)
    const COLORS = { PAGADA: 'FF66BB6A', PARCIAL: 'FFF4FF81', SIN_PAGAR: 'FFEF5350' };
    const num = v => (v == null ? 0 : Number(v));

    rows.forEach((r, i) => {
      const row = ws.getRow(5 + i);
      row.values = [
        i + 1, r.nro_documento, [r.paterno, r.materno, r.nombres].filter(Boolean).join(' '),
        r.sede || '', r.area || '', r.turno || '', r.grupo || '', r.tipo_colegio || '',
        num(r.primera_mensualidad), num(r.segunda_mensualidad), num(r.tercera_mensualidad), num(r.cuarta_mensualidad),
      ];
      // Colorear las 4 cuotas (columnas 9..12) según estado
      [r.estado_cuota1, r.estado_cuota2, r.estado_cuota3, r.estado_cuota4].forEach((est, k) => {
        const color = COLORS[est];
        const cell = row.getCell(9 + k);
        cell.alignment = { horizontal: 'right' };
        if (color) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
      });
    });

    const widths = [6, 12, 34, 14, 14, 10, 10, 22, 9, 9, 9, 9];
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.views = [{ state: 'frozen', ySplit: 4 }];

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="reporte-pagos_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(buffer));
  } catch (error) {
    if (connection) connection.release();
    console.error('Error reporte-pagos excel:', error);
    res.status(500).json({ error: 'Error al generar el Excel' });
  }
});

// ============ ALUMNOS · CALIFICACIÓN DOCENTE ============
// Por estudiante: a cuántos docentes calificó (X) de los docentes de su grupo (Y).
//   Y = COUNT(DISTINCT docentes_id) en carga_academicas del grupo del alumno.
//   X = COUNT(DISTINCT docentes_id) de esos docentes que el alumno evaluó
//       (calificacion_docente_detalles → calificacion_docentes → carga_academicas).
// Se cuenta por DOCENTE (no por curso) porque en algunas áreas un mismo docente
// dicta varios cursos; contar docentes es más estable y representa "calificó al docente".
// Misma auth y restricción por rol (grupo_aulas_id) que /api/stats/reporte-pagos.
const CALIFICACIONES_SQL_BASE = `
  SELECT
    e.nro_documento,
    e.paterno,
    e.materno,
    e.nombres,
    s.denominacion        AS sede,
    areas.denominacion     AS area,
    turnos.denominacion    AS turno,
    grupos.denominacion    AS grupo,
    m.grupo_aulas_id,
    sede_aula.denominacion AS sede_aula,
    COALESCE(tc.total_docentes, 0)         AS total_docentes,
    COALESCE(cal.docentes_calificados, 0)  AS docentes_calificados,
    -- Solo para PARCIALES (0 < X < Y): cursos de los docentes que aún no calificó.
    -- El CASE evita correr el subquery pesado en las ~7000 filas restantes.
    CASE
      WHEN COALESCE(cal.docentes_calificados, 0) > 0
       AND COALESCE(cal.docentes_calificados, 0) < COALESCE(tc.total_docentes, 0)
      THEN (
        SELECT GROUP_CONCAT(DISTINCT c2.denominacion ORDER BY c2.denominacion SEPARATOR ', ')
        FROM carga_academicas ca3
        JOIN cursos c2 ON c2.id = ca3.cursos_id
        WHERE ca3.grupo_aulas_id = m.grupo_aulas_id
          AND ca3.periodos_id = 1 AND ca3.estado = '1' AND ca3.tipo = '1'
          AND ca3.docentes_id IS NOT NULL
          AND ca3.docentes_id NOT IN (
            SELECT ca4.docentes_id
            FROM calificacion_docente_detalles d2
            JOIN calificacion_docentes cd2 ON cd2.id = d2.calificacion_docentes_id
            JOIN carga_academicas ca4      ON ca4.id = cd2.carga_academicas_id
            WHERE d2.estudiantes_id = e.id
              AND ca4.grupo_aulas_id = m.grupo_aulas_id
              AND ca4.periodos_id = 1 AND ca4.estado = '1' AND ca4.tipo = '1'
              AND ca4.docentes_id IS NOT NULL
          )
      )
      ELSE NULL
    END AS cursos_faltantes
  FROM inscripciones i
  JOIN estudiantes e ON e.id = i.estudiantes_id
  JOIN sedes s ON s.id = i.sedes_id
  LEFT JOIN matriculas m ON m.estudiantes_id = e.id AND m.periodos_id = i.periodos_id
  LEFT JOIN grupo_aulas ga ON ga.id = m.grupo_aulas_id
  LEFT JOIN areas  ON areas.id  = ga.areas_id
  LEFT JOIN grupos ON grupos.id = ga.grupos_id
  LEFT JOIN turnos ON turnos.id = ga.turnos_id
  LEFT JOIN aulas aula_real     ON aula_real.id   = ga.aulas_id
  LEFT JOIN locales local_aula  ON local_aula.id  = aula_real.locales_id
  LEFT JOIN sedes sede_aula     ON sede_aula.id   = local_aula.sedes_id
  -- Y: total de docentes del grupo (mismo para todos los alumnos del grupo).
  -- Solo titulares (tipo='1'): si un curso pasa de titular A a suplente B, el
  -- titular ya calificado quedaba contabilizado y el suplente sumaba como
  -- "no calificado", dando un PARCIAL falso. Suplentes no califican.
  LEFT JOIN (
    -- Denominador ESTABLE: titulares con calificacion_docentes ACTIVA por grupo.
    -- Se ancla en cd.estado='1' y NO filtra ca.estado: si la carga se reasigna o
    -- desactiva tras la evaluacion, sigue contando → el % del alumno no varia.
    SELECT ca.grupo_aulas_id, COUNT(DISTINCT cd.docentes_id) AS total_docentes
    FROM carga_academicas ca
    JOIN calificacion_docentes cd ON cd.carga_academicas_id = ca.id AND cd.estado = '1'
    WHERE ca.periodos_id = 1 AND ca.tipo = '1'
    GROUP BY ca.grupo_aulas_id
  ) tc ON tc.grupo_aulas_id = m.grupo_aulas_id
  -- X: docentes TITULARES del grupo que el alumno efectivamente calificó.
  -- Si una calificación quedó asociada a una carga de suplente (raro), no se
  -- cuenta: la cobertura se mide solo contra titulares (denominador en tc).
  -- X: docentes TITULARES que el alumno calificó (numerador), por ALUMNO (no por
  -- grupo de la carga). Así, si una carga se reasigna de grupo/curso después de
  -- que el alumno la calificó, su calificación sigue contando. Misma definición
  -- robusta que el dashboard docentes-stats.
  LEFT JOIN (
    SELECT d.estudiantes_id,
           COUNT(DISTINCT cd.docentes_id) AS docentes_calificados
    FROM calificacion_docente_detalles d
    JOIN calificacion_docentes cd ON cd.id = d.calificacion_docentes_id
    JOIN carga_academicas ca      ON ca.id = cd.carga_academicas_id AND ca.tipo = '1'
    GROUP BY d.estudiantes_id
  ) cal ON cal.estudiantes_id = e.id
  WHERE i.periodos_id = 1 AND i.estado = '1'
`;

app.get('/api/stats/calificaciones', requireStatsAuth, cacheMiddleware(300), async (req, res) => {
  let connection;
  try {
    const { q } = req.query;
    const { grupos: gruposPermitidos } = req.user;

    // Lista vacía de grupos → no ve nada (auxiliar/coordinador sin asignaciones).
    if (Array.isArray(gruposPermitidos) && gruposPermitidos.length === 0) {
      return res.json({ total: 0, registros: [], timestamp: new Date().toISOString() });
    }

    const conditions = [];
    const params = [];

    // Restricción por rol: si grupos es array (no admin), limitar a esos grupo_aulas_id.
    if (Array.isArray(gruposPermitidos)) {
      conditions.push(`grupo_aulas_id IN (${gruposPermitidos.map(() => '?').join(',')})`);
      params.push(...gruposPermitidos);
    }

    // Búsqueda por DNI.
    if (q && String(q).trim().length > 0) {
      conditions.push('nro_documento LIKE ?');
      params.push(`%${String(q).trim()}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM (${CALIFICACIONES_SQL_BASE}) AS t ${where} ORDER BY paterno, materno, nombres`;

    connection = await pool.getConnection();
    const [rows] = await connection.query(sql, params);
    connection.release();

    res.json({ total: rows.length, registros: rows, timestamp: new Date().toISOString() });
  } catch (error) {
    if (connection) connection.release();
    console.error('Error calificaciones:', error);
    res.status(500).json({ error: 'Error al generar el reporte de calificaciones' });
  }
});

// ============ DOCENTES STATS · DASHBOARD ============
// Dashboard agregado de calificación docente para la página /stats/docentes-stats.
// Devuelve KPIs globales + 6 series listas para Chart.js. Solo admin.
//
// Importante: TODAS las queries que tocan carga_academicas filtran tipo='1'
// (solo titulares); los suplentes no se cuentan como docentes a calificar.

// ---- Switch "solo calificaciones válidas" (>=80% asistencia del alumno) ----
// Una calificación se considera válida solo si el alumno tuvo >=80% de asistencia
// (presente=1 + tarde=2 cuentan; falta=3 no). Cuando el switch está activo, los
// scores se RECALCULAN desde calificacion_docente_detalles (puntaje individual),
// porque calificacion_docentes.promedio está pre-agregado y no se puede filtrar.
const UMBRAL_ASISTENCIA = 80;

// Subquery de estudiantes con asistencia válida (>= umbral). Reutilizable.
const ASIST_VALIDA_SQL = `
  SELECT estudiantes_id
  FROM asistencia_estudiante_detalles
  GROUP BY estudiantes_id
  HAVING 100 * SUM(estado IN ('1','2')) / COUNT(*) >= ${UMBRAL_ASISTENCIA}
`;

// Devuelve el CTE `cd_src` que reemplaza a calificacion_docentes en las queries
// de score. Sin filtro: passthrough (mismas columnas). Con filtro: recalcula
// promedio y participantes solo con alumnos de asistencia válida.
// Verificado: AVG(cdd.puntaje) sobre criterios activos == cd.promedio pre-agregado.
function cdSourceCTE(soloValidas) {
  if (!soloValidas) {
    return `cd_src AS (
      SELECT id, docentes_id, carga_academicas_id, promedio, participantes, modalidad
      FROM calificacion_docentes
      WHERE estado='1' AND participantes > 0
    )`;
  }
  return `asist_valida AS (${ASIST_VALIDA_SQL}),
    cd_src AS (
      SELECT MIN(cd.id) AS id, cd.docentes_id, cd.carga_academicas_id,
             AVG(cdd.puntaje) AS promedio,
             COUNT(DISTINCT cdd.estudiantes_id) AS participantes,
             cd.modalidad
      FROM calificacion_docentes cd
      JOIN calificacion_docente_detalles cdd ON cdd.calificacion_docentes_id = cd.id
      JOIN criterios cr ON cr.id = cdd.criterios_id AND cr.tipo='1' AND cr.estado='1'
      JOIN asist_valida av ON av.estudiantes_id = cdd.estudiantes_id
      WHERE cd.estado='1'
      GROUP BY cd.docentes_id, cd.carga_academicas_id, cd.modalidad
      HAVING COUNT(DISTINCT cdd.estudiantes_id) > 0
    )`;
}

// Helper: construye fragmentos JOIN/WHERE para filtros del dashboard.
// Devuelve dos variantes:
//   - ca: para queries que parten desde calificacion_docentes + carga_academicas
//   - im: para queries que parten desde inscripciones + matriculas (perspectiva alumno)
// Aliases con sufijo _f para no chocar con joins existentes.
function buildDashboardFilters(query) {
  const norm = v => { const s = String(v ?? '').trim(); return s && /^\d+$/.test(s) ? s : null; };
  const sede = norm(query.sede);
  const area = norm(query.area);
  const turno = norm(query.turno);
  const aplicados = { sede, area, turno };

  // Perspectiva docente (carga_academicas alias 'ca')
  const joinsCa = [];
  const whereCa = [];
  const valuesCa = [];
  if (area || turno || sede) joinsCa.push('JOIN grupo_aulas ga_f ON ga_f.id = ca.grupo_aulas_id');
  if (area)  { whereCa.push('ga_f.areas_id = ?');  valuesCa.push(area); }
  if (turno) { whereCa.push('ga_f.turnos_id = ?'); valuesCa.push(turno); }
  if (sede) {
    joinsCa.push('LEFT JOIN aulas au_f ON au_f.id = ga_f.aulas_id');
    joinsCa.push('LEFT JOIN locales lo_f ON lo_f.id = au_f.locales_id');
    whereCa.push('lo_f.sedes_id = ?');
    valuesCa.push(sede);
  }

  // Perspectiva alumno (matriculas alias 'm' y inscripciones alias 'i')
  const joinsIm = [];
  const whereIm = [];
  const valuesIm = [];
  if (area || turno) joinsIm.push('JOIN grupo_aulas ga_fi ON ga_fi.id = m.grupo_aulas_id');
  if (area)  { whereIm.push('ga_fi.areas_id = ?');  valuesIm.push(area); }
  if (turno) { whereIm.push('ga_fi.turnos_id = ?'); valuesIm.push(turno); }
  if (sede)  { whereIm.push('i.sedes_id = ?'); valuesIm.push(sede); }

  return {
    activos: !!(sede || area || turno),
    aplicados,
    joinsCa: joinsCa.join('\n            '),
    whereCa: whereCa.length ? 'AND ' + whereCa.join(' AND ') : '',
    valuesCa,
    joinsIm: joinsIm.join('\n            '),
    whereIm: whereIm.length ? 'AND ' + whereIm.join(' AND ') : '',
    valuesIm
  };
}

app.get('/api/stats/docentes-stats/dashboard', requireAdmin, cacheMiddleware(180), async (req, res) => {
  const F = buildDashboardFilters(req.query);
  const soloValidas = req.query.solo_validas === '1' || req.query.solo_validas === 'true';
  const CD_CTE = cdSourceCTE(soloValidas);
  // Para queries que leen calificacion_docente_detalles directamente (puntaje individual):
  // JOIN opcional que descarta respuestas de alumnos con asistencia < umbral.
  const JOIN_ASIST = soloValidas
    ? `JOIN (${ASIST_VALIDA_SQL}) av ON av.estudiantes_id = cdd.estudiantes_id`
    : '';
  // Umbral de "robusta" (participantes): seleccionable 50/80/100. Referencial = [30, umbral).
  // Solo cambia la ETIQUETA de confianza; la entrada al ranking sigue siendo >=30.
  const umbralRobusta = [50, 80, 100].includes(Number(req.query.umbral)) ? Number(req.query.umbral) : 50;
  try {
    // Ejecuta una query del pool y devuelve solo las filas. Cada llamada usa su
    // propia conexión del pool, así que varias pueden correr en paralelo con
    // Promise.all (antes eran ~17 queries en serie → ahora 2 olas paralelas).
    const q = (sql, params) => pool.query(sql, params).then(r => r[0]);

    // ------------------------------------------------------------------
    // COBERTURA correlacionada con lo que REALMENTE se calificó (estable).
    //
    //   DENOMINADOR (tc) por grupo = docentes titulares con calificación activa
    //     (cd.estado='1') cuya carga pertenece al grupo. Usa cd como fuente.
    //   NUMERADOR (num) por ALUMNO = docentes distintos que el alumno
    //     efectivamente calificó (calificacion_docente_detalles). NO se agrupa
    //     por grupo de la carga: así, si una carga cambia de grupo/curso después
    //     de que el alumno la calificó, su calificación SIGUE contando. Esta era
    //     la causa de que los conteos cayeran al reasignar cargas.
    //
    // El alumno se compara contra el denominador de SU grupo (matrícula).
    // Denominador ESTABLE: docentes titulares evaluados por grupo. Se ancla en la
    // calificación (cd.estado='1') y NO filtra ca.estado: si una carga se reasigna
    // o desactiva tras la evaluación sigue contando, así el denominador no cambia
    // (antes ca.estado='1' lo hacía variar en cada F5). Lo usan KPIs, distribución,
    // cobertura por sede y grupos en riesgo.
    const TC_SUBQ = `
        SELECT ca.grupo_aulas_id, COUNT(DISTINCT cd.docentes_id) AS total_docentes
        FROM calificacion_docentes cd
        JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id
        WHERE cd.estado='1' AND ca.periodos_id=1 AND ca.tipo='1'
        GROUP BY ca.grupo_aulas_id`;
    // Numerador por alumno (inmutable): docentes distintos calificados. Sin grupo.
    const NUM_SUBQ = `
        SELECT d.estudiantes_id, COUNT(DISTINCT cd.docentes_id) AS docentes_calificados
        FROM calificacion_docente_detalles d
        JOIN calificacion_docentes cd ON cd.id = d.calificacion_docentes_id
        JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
        GROUP BY d.estudiantes_id`;

    // ------------------------------------------------------------------
    // COBERTURA ANCLADA EN calificacion_docente_detalles (estable e inmutable).
    //
    // Problema previo: completos/parciales partían de `inscripciones` (estado
    // vivo) y el denominador filtraba `ca.estado='1'`. Al reasignar/desactivar
    // cargas (hay 46 evaluadas hoy inactivas) el denominador del grupo cambiaba
    // y los alumnos saltaban completo↔parcial en cada F5. Y los alumnos
    // retirados (sin inscripción activa) desaparecían del conteo.
    //
    // Solución: el universo y el numerador salen de lo REALMENTE calificado
    // (cdd → cd → carga tipo='1'), que no cambia. El denominador es el total de
    // docentes titulares evaluados del grupo SIN depender de ca.estado.
    //   universo = alumnos que calificaron a un titular (incluye retirados)
    //   numerador (calif) = docentes distintos que el alumno calificó
    //   grupo_ref = grupo de las cargas que calificó (para el denominador)
    // ------------------------------------------------------------------
    const CALIF_SRC = `
        SELECT cdd.estudiantes_id,
               COUNT(DISTINCT cd.docentes_id) AS calif,
               MAX(ca.grupo_aulas_id) AS grupo_ref
        FROM calificacion_docente_detalles cdd
        JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id
        JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
        GROUP BY cdd.estudiantes_id`;

    // Helper de ranking por dimensión (curso/área/turno/sede). Definido aquí
    // arriba para poder lanzarlo dentro de la ola 1.
    const dimQuery = (joinExpr, labelExpr, groupBy) => `
      WITH ${CD_CTE}
      SELECT ${labelExpr} AS etiqueta,
             ROUND(AVG(cd.promedio), 2) AS promedio,
             SUM(cd.participantes) AS participantes,
             COUNT(DISTINCT d.id) AS docentes
      FROM cd_src cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      JOIN docentes d ON d.id = cd.docentes_id
      ${joinExpr}
      WHERE cd.participantes > 0
      GROUP BY ${groupBy}
      HAVING SUM(cd.participantes) >= 30
      ORDER BY promedio DESC
    `;

    // Filtros de "grupos en riesgo" (perspectiva grupo). Definidos aquí arriba
    // para lanzar la query dentro de la ola 1.
    const grWhere = [];
    const grValues = [];
    if (F.aplicados.area)  { grWhere.push('ga.areas_id = ?');  grValues.push(F.aplicados.area); }
    if (F.aplicados.turno) { grWhere.push('ga.turnos_id = ?'); grValues.push(F.aplicados.turno); }
    if (F.aplicados.sede)  { grWhere.push('(lo.sedes_id = ? OR i.sedes_id = ?)'); grValues.push(F.aplicados.sede, F.aplicados.sede); }
    const grWhereStr = grWhere.length ? 'AND ' + grWhere.join(' AND ') : '';

    // Filtros para la cobertura anclada en cdd: se aplican sobre el grupo de
    // referencia (ga_r) derivado de las cargas que el alumno calificó.
    const gr2Joins = [];
    const gr2Where = [];
    const gr2Values = [];
    if (F.aplicados.area)  { gr2Where.push('ga_r.areas_id = ?');  gr2Values.push(F.aplicados.area); }
    if (F.aplicados.turno) { gr2Where.push('ga_r.turnos_id = ?'); gr2Values.push(F.aplicados.turno); }
    if (F.aplicados.sede)  {
      gr2Joins.push('LEFT JOIN aulas au_r ON au_r.id = ga_r.aulas_id');
      gr2Joins.push('LEFT JOIN locales lo_r ON lo_r.id = au_r.locales_id');
      gr2Where.push('lo_r.sedes_id = ?'); gr2Values.push(F.aplicados.sede);
    }
    const gr2JoinsStr = gr2Joins.join('\n        ');
    const gr2WhereStr = gr2Where.length ? 'WHERE ' + gr2Where.join(' AND ') : '';

    // ================== OLA 1: queries independientes del score (paralelas) ==================
    const [
      kpisRows, distribucion, porSede, perDoc,
      rankingPorCurso, rankingPorArea, rankingPorTurno, rankingPorSede,
      porPregunta, gruposRiesgo, evolucion, robustezRows,
      porModalidad, varianzaCursos, participacionCiclo,
    ] = await Promise.all([
    // 1) KPIs globales (con filtros opcionales de sede/area/turno via perspectiva alumno)
    q(`
      WITH calif_src AS (${CALIF_SRC}
      ),
      cobertura AS (
        SELECT
          cs.estudiantes_id AS id,
          COALESCE(tc.total_docentes, 0) AS total,
          cs.calif AS calif
        FROM calif_src cs
        JOIN grupo_aulas ga_r ON ga_r.id = cs.grupo_ref
        ${gr2JoinsStr}
        LEFT JOIN (${TC_SUBQ}
        ) tc ON tc.grupo_aulas_id = cs.grupo_ref
        ${gr2WhereStr}
      )
      SELECT
        COUNT(*) AS total_alumnos,
        -- Misma clasificación que /stats/alumnos-calificacion (4 categorías):
        --   completo  = total>0 y calificó a todos
        --   parcial   = total>0 y calificó a algunos
        --   sin       = total>0 y calificó a ninguno
        --   sin_grupo = total=0 (alumno inscrito sin matrícula → no tiene docentes que calificar)
        -- sin_grupo NO entra en sin_calificar: no es "pendiente", no hay nada que calificar.
        SUM(CASE WHEN total > 0 AND calif >= total THEN 1 ELSE 0 END)            AS completos,
        SUM(CASE WHEN total > 0 AND calif > 0 AND calif < total THEN 1 ELSE 0 END) AS parciales,
        SUM(CASE WHEN total > 0 AND calif = 0 THEN 1 ELSE 0 END)                 AS sin_calificar,
        SUM(CASE WHEN total = 0 THEN 1 ELSE 0 END)                              AS sin_grupo,
        -- Cobertura promedio solo sobre alumnos con docentes evaluables (total>0):
        -- los total=0 (NULL) los ignora AVG automáticamente. LEAST(100,...) capea
        -- a los alumnos que calificaron a docentes ya movidos de su grupo (calif>total).
        ROUND(AVG(CASE WHEN total = 0 THEN NULL ELSE LEAST(100, 100 * calif / total) END), 1) AS cobertura_global_pct,
        (SELECT COUNT(*) FROM calificacion_docentes)                 AS total_calificaciones_docente,
        (SELECT COUNT(*) FROM calificacion_docente_detalles)         AS total_respuestas_criterios,
        (SELECT COUNT(DISTINCT docentes_id) FROM calificacion_docentes) AS docentes_evaluados
      FROM cobertura
    `, gr2Values),

    // 2) Distribución de cumplimiento (histograma) — mismo universo cdd estable
    q(`
      WITH calif_src AS (${CALIF_SRC}
      ),
      cobertura AS (
        SELECT
          CASE WHEN COALESCE(tc.total_docentes,0) = 0 THEN 0
               ELSE LEAST(100, ROUND(100 * cs.calif / tc.total_docentes)) END AS pct
        FROM calif_src cs
        JOIN grupo_aulas ga_r ON ga_r.id = cs.grupo_ref
        ${gr2JoinsStr}
        LEFT JOIN (${TC_SUBQ}
        ) tc ON tc.grupo_aulas_id = cs.grupo_ref
        ${gr2WhereStr ? gr2WhereStr + ' AND' : 'WHERE'} COALESCE(tc.total_docentes,0) > 0
      )
      SELECT rango, alumnos FROM (
        SELECT
          CASE
            WHEN pct >= 100 THEN '100% Completo'
            WHEN pct >= 75  THEN '75-99%'
            WHEN pct >= 50  THEN '50-74%'
            WHEN pct >= 25  THEN '25-49%'
            WHEN pct >= 1   THEN '1-24%'
            ELSE '0% Sin calificar'
          END AS rango,
          MIN(pct) AS ord,
          COUNT(*) AS alumnos
        FROM cobertura
        GROUP BY rango
      ) x
      ORDER BY ord
    `, gr2Values),

    // 3) Cobertura por sede (excluye alumnos sin docentes evaluables: NULL no entra al AVG)
    q(`
      SELECT s.denominacion AS sede,
             COUNT(DISTINCT CASE WHEN COALESCE(tc.total_docentes,0) > 0 THEN e.id END) AS alumnos,
             ROUND(AVG(CASE WHEN COALESCE(tc.total_docentes,0)=0 THEN NULL
                            ELSE LEAST(100, 100 * COALESCE(cal.docentes_calificados,0) / tc.total_docentes) END), 1) AS pct
      FROM inscripciones i
      JOIN estudiantes e ON e.id = i.estudiantes_id
      JOIN sedes s ON s.id = i.sedes_id
      LEFT JOIN matriculas m ON m.estudiantes_id = e.id AND m.periodos_id = i.periodos_id
      LEFT JOIN (${TC_SUBQ}
      ) tc ON tc.grupo_aulas_id = m.grupo_aulas_id
      LEFT JOIN (${NUM_SUBQ}
      ) cal ON cal.estudiantes_id = e.id
      WHERE i.periodos_id=1 AND i.estado='1'
      GROUP BY s.id ORDER BY pct DESC
    `),

    // ------------------------------------------------------------------
    // SCORE BAYESIANO (anti-sesgo de muestra y de grupo dominante)
    // ------------------------------------------------------------------
    // Paso 1: para cada docente, promedio = media de promedios de sus cargas
    //         (un grupo de 100 alumnos no pesa más que uno de 25).
    // Paso 2: score = (n × prom_doc + m × C) / (n + m)
    //         C  = promedio global de docentes (media institucional)
    //         m  = mediana de participantes por docente (peso "fantasma")
    //         n  = participantes totales del docente
    // Paso 3: tag de robustez según n:
    //         n >= 50 → robusta · 30-49 → referencial · <30 → insuficiente
    // Parámetros bayesianos: C (media global) y m (mediana de n por docente).
    // perDoc se trae en la ola 1; C y M se calculan tras el Promise.all.
    q(`
      WITH ${CD_CTE}
      SELECT AVG(cd.promedio) AS prom_doc, SUM(cd.participantes) AS n
      FROM cd_src cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      WHERE cd.participantes > 0
      GROUP BY cd.docentes_id
    `),

    // 6.1) Ranking por DIMENSIÓN (curso · área · sede física · turno) → ola 1
    q(dimQuery(
      `JOIN cursos c ON c.id = ca.cursos_id`,
      `c.denominacion`,
      `c.denominacion`
    )),
    q(dimQuery(
      `JOIN grupo_aulas ga ON ga.id = ca.grupo_aulas_id
       JOIN areas a ON a.id = ga.areas_id`,
      `a.denominacion`,
      `a.id, a.denominacion`
    )),
    q(dimQuery(
      `JOIN grupo_aulas ga ON ga.id = ca.grupo_aulas_id
       JOIN turnos t ON t.id = ga.turnos_id`,
      `t.denominacion`,
      `t.id, t.denominacion`
    )),
    q(dimQuery(
      `JOIN grupo_aulas ga ON ga.id = ca.grupo_aulas_id
       LEFT JOIN aulas au ON au.id = ga.aulas_id
       LEFT JOIN locales lo ON lo.id = au.locales_id
       LEFT JOIN sedes s ON s.id = lo.sedes_id`,
      `COALESCE(s.denominacion, '— Sin local —')`,
      `COALESCE(s.id, 0), COALESCE(s.denominacion, '— Sin local —')`
    )),

    // 6.2) Promedio por PREGUNTA (criterios activos tipo='1')
    q(`
      SELECT cr.id, cr.denominacion AS pregunta,
             ROUND(AVG(cdd.puntaje), 2) AS promedio,
             COUNT(*) AS respuestas,
             SUM(CASE WHEN cdd.puntaje >= 4 THEN 1 ELSE 0 END) AS aprobatorias,
             SUM(CASE WHEN cdd.puntaje <= 2 THEN 1 ELSE 0 END) AS criticas
      FROM calificacion_docente_detalles cdd
      JOIN criterios cr ON cr.id = cdd.criterios_id
      JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      ${JOIN_ASIST}
      WHERE cr.tipo='1' AND cr.estado='1' AND cr.modalidad = cd.modalidad
      GROUP BY cr.id, cr.denominacion
      ORDER BY promedio DESC
    `),

    // 7) Grupos en riesgo (bottom 20 por cobertura, con mínimo 10 alumnos, filtrable)
    q(`
      SELECT g.denominacion AS grupo, ar.denominacion AS area, t.denominacion AS turno,
             COALESCE(ANY_VALUE(sa.denominacion), ANY_VALUE(s.denominacion)) AS sede,
             COUNT(DISTINCT e.id) AS alumnos,
             ROUND(AVG(CASE WHEN COALESCE(tc.total_docentes,0)=0 THEN 0
                            ELSE LEAST(100, 100 * COALESCE(cal.docentes_calificados,0) / tc.total_docentes) END), 1) AS cobertura_pct
      FROM inscripciones i
      JOIN estudiantes e ON e.id = i.estudiantes_id
      JOIN sedes s ON s.id = i.sedes_id
      JOIN matriculas m ON m.estudiantes_id = e.id AND m.periodos_id = i.periodos_id
      JOIN grupo_aulas ga ON ga.id = m.grupo_aulas_id
      JOIN grupos g ON g.id = ga.grupos_id
      JOIN areas  ar ON ar.id = ga.areas_id
      JOIN turnos t  ON t.id = ga.turnos_id
      LEFT JOIN aulas au ON au.id = ga.aulas_id
      LEFT JOIN locales lo ON lo.id = au.locales_id
      LEFT JOIN sedes sa ON sa.id = lo.sedes_id
      LEFT JOIN (${TC_SUBQ}
      ) tc ON tc.grupo_aulas_id = m.grupo_aulas_id
      LEFT JOIN (${NUM_SUBQ}
      ) cal ON cal.estudiantes_id = e.id
      WHERE i.periodos_id=1 AND i.estado='1' ${grWhereStr}
      GROUP BY ga.id
      HAVING alumnos >= 10
      ORDER BY cobertura_pct ASC, alumnos DESC LIMIT 20
    `, grValues),

    // 8) Evolución temporal (calificaciones por día, últimos 30 días con actividad)
    // Usa DATE(created_at) en vez de DATE_FORMAT para poder aprovechar un índice
    // sobre created_at (DATE_FORMAT envuelve la columna e impide su uso).
    q(`
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS dia,
             COUNT(DISTINCT calificacion_docentes_id) AS calificaciones,
             COUNT(*) AS respuestas
      FROM calificacion_docente_detalles
      GROUP BY dia
      ORDER BY dia DESC LIMIT 30
    `),

    // 8.5) Conteo de docentes por nivel de robustez (según el umbral seleccionado)
    q(`
      WITH ${CD_CTE}
      SELECT
        SUM(p >= ${umbralRobusta}) AS robustos,
        SUM(p >= 30 AND p < ${umbralRobusta}) AS referenciales,
        SUM(p < 30) AS insuficientes,
        COUNT(*) AS total
      FROM (
        SELECT SUM(cd.participantes) AS p
        FROM cd_src cd
        JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
        WHERE cd.participantes > 0
        GROUP BY cd.docentes_id
      ) x
    `),

    // 9) Modalidad institucional (virtual vs presencial)
    q(`
      SELECT CASE cd.modalidad WHEN '1' THEN 'Virtual' WHEN '0' THEN 'Presencial' ELSE 'Otra' END AS modalidad,
             COUNT(DISTINCT cd.docentes_id) AS docentes,
             COUNT(DISTINCT cd.carga_academicas_id) AS cargas,
             SUM(cd.participantes) AS calificaciones,
             ROUND(AVG(cd.promedio), 2) AS promedio
      FROM calificacion_docentes cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      WHERE cd.participantes > 0
      GROUP BY cd.modalidad
      ORDER BY cd.modalidad
    `),

    // 11) Cursos con mayor varianza entre docentes (necesidad de estandarización)
    q(`
      WITH ${CD_CTE}
      SELECT c.denominacion AS curso,
             COUNT(DISTINCT d.id) AS docentes,
             ROUND(AVG(cd.promedio), 2) AS promedio,
             ROUND(STDDEV_POP(cd.promedio), 3) AS desviacion,
             ROUND(MAX(cd.promedio) - MIN(cd.promedio), 2) AS rango,
             ROUND(MIN(cd.promedio), 2) AS minimo,
             ROUND(MAX(cd.promedio), 2) AS maximo
      FROM cd_src cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      JOIN cursos c ON c.id = ca.cursos_id
      JOIN docentes d ON d.id = cd.docentes_id
      WHERE cd.participantes > 0
      GROUP BY c.denominacion
      HAVING docentes >= 5
      ORDER BY desviacion DESC
      LIMIT 10
    `),

    // 12) Participación del ciclo: total de estudiantes inscritos (activos) y cuántos
    // de ellos NO calificaron. "Calificó" = tiene al menos una respuesta en cdd sobre
    // una carga titular (tipo='1'). Métrica de inscripción, separada del universo cdd.
    q(`
      SELECT
        COUNT(DISTINCT i.estudiantes_id) AS total_inscritos,
        COUNT(DISTINCT c.estudiantes_id) AS inscritos_calificaron
      FROM inscripciones i
      LEFT JOIN (
        SELECT DISTINCT cdd.estudiantes_id
        FROM calificacion_docente_detalles cdd
        JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id
        JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      ) c ON c.estudiantes_id = i.estudiantes_id
      WHERE i.periodos_id = 1 AND i.estado = '1'
    `),
    ]); // ===== fin OLA 1 =====

    const kpis = kpisRows[0];
    const robustez = robustezRows[0];
    evolucion.reverse();

    // Parámetros bayesianos C (media global) y M (mediana de n por docente),
    // derivados de perDoc (traído en la ola 1).
    const proms = perDoc.map(r => Number(r.prom_doc)).filter(x => !isNaN(x));
    const ns = perDoc.map(r => Number(r.n)).filter(x => !isNaN(x)).sort((a,b) => a-b);
    const C = proms.length ? Number((proms.reduce((a,b) => a+b, 0) / proms.length).toFixed(3)) : 4.3;
    const medianaN = ns.length ? ns[Math.floor(ns.length/2)] : 30;
    const M = Math.max(20, medianaN);  // mínimo 20

    // ------------------------------------------------------------------
    // Ranking por SEDE física: anti-sesgo de muestra + de participación.
    // (1) score bayesiano: prom crudo "encogido" hacia la media global C con
    //     peso M, igual que el ranking de docentes → sedes con poca evidencia
    //     dejan de copar el top por azar.
    // (2) participación: se cruza la cobertura (% de docentes que cada alumno
    //     calificó) por nombre de sede. Una nota alta con baja participación es
    //     poco representativa (sesgo de no-respuesta), así que se etiqueta.
    //       >= 70% → alta · 50-69% → media · < 50% → baja (⚠️ poco representativa)
    // ------------------------------------------------------------------
    {
      const cobMap = {};
      for (const r of porSede) cobMap[r.sede] = r.pct == null ? null : Number(r.pct);
      const etiquetaRobustez = (p) => p == null ? 'sin-dato' : p >= 70 ? 'alta' : p >= 50 ? 'media' : 'baja';
      for (const r of rankingPorSede) {
        const n = Number(r.participantes) || 0;
        const prom = Number(r.promedio) || 0;
        r.promedio_crudo = Number(prom.toFixed(2));
        r.score = Number(((n * prom + M * C) / (n + M)).toFixed(2));
        r.participacion = (r.etiqueta in cobMap) ? cobMap[r.etiqueta] : null;
        r.robustez = etiquetaRobustez(r.participacion);
      }
      // Reordenar por el score honesto (no por el promedio crudo).
      rankingPorSede.sort((a, b) => b.score - a.score || b.participantes - a.participantes);
    }

    // ================== OLA 2: queries que dependen de C y M (paralelas) ==================
    const [topDocentes, bottomDocentes, distPromedios, intervenciones] = await Promise.all([
    // 4) Top 15 docentes (score bayesiano sobre media de grupos, filtrable)
    q(`
      WITH ${CD_CTE}
      SELECT d.id,
             CONCAT_WS(' ', d.paterno, d.materno, d.nombres) AS docente,
             ROUND(AVG(cd.promedio), 2) AS promedio_crudo,
             ROUND((SUM(cd.participantes) * AVG(cd.promedio) + ? * ?) / (SUM(cd.participantes) + ?), 2) AS score,
             SUM(cd.participantes) AS participantes,
             COUNT(DISTINCT cd.carga_academicas_id) AS asignaciones,
             CASE WHEN SUM(cd.participantes) >= ${umbralRobusta} THEN 'robusta'
                  WHEN SUM(cd.participantes) >= 30 THEN 'referencial'
                  ELSE 'insuficiente' END AS robustez
      FROM cd_src cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      ${F.joinsCa}
      JOIN docentes d ON d.id = cd.docentes_id
      WHERE cd.participantes > 0 ${F.whereCa}
      GROUP BY d.id
      HAVING participantes >= 30
      ORDER BY score DESC, participantes DESC LIMIT 15
    `, [M, C, M, ...F.valuesCa]),

    // 5) Bottom 15 docentes (mismo score, orden inverso)
    q(`
      WITH ${CD_CTE}
      SELECT d.id,
             CONCAT_WS(' ', d.paterno, d.materno, d.nombres) AS docente,
             ROUND(AVG(cd.promedio), 2) AS promedio_crudo,
             ROUND((SUM(cd.participantes) * AVG(cd.promedio) + ? * ?) / (SUM(cd.participantes) + ?), 2) AS score,
             SUM(cd.participantes) AS participantes,
             COUNT(DISTINCT cd.carga_academicas_id) AS asignaciones,
             CASE WHEN SUM(cd.participantes) >= ${umbralRobusta} THEN 'robusta'
                  WHEN SUM(cd.participantes) >= 30 THEN 'referencial'
                  ELSE 'insuficiente' END AS robustez
      FROM cd_src cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      ${F.joinsCa}
      JOIN docentes d ON d.id = cd.docentes_id
      WHERE cd.participantes > 0 ${F.whereCa}
      GROUP BY d.id
      HAVING participantes >= 30
      ORDER BY score ASC, participantes DESC LIMIT 15
    `, [M, C, M, ...F.valuesCa]),

    // 6) Distribución de scores bayesianos (histograma corregido)
    q(`
      WITH ${CD_CTE}
      SELECT rango, docentes FROM (
        SELECT
          CASE
            WHEN sc >= 4.5 THEN '4.5–5.0 Excelente'
            WHEN sc >= 4.0 THEN '4.0–4.5 Muy bueno'
            WHEN sc >= 3.5 THEN '3.5–4.0 Bueno'
            WHEN sc >= 3.0 THEN '3.0–3.5 Regular'
            WHEN sc >= 2.5 THEN '2.5–3.0 Bajo'
            ELSE '< 2.5 Muy bajo'
          END AS rango,
          MIN(sc) AS ord,
          COUNT(*) AS docentes
        FROM (
          SELECT d.id,
                 (SUM(cd.participantes) * AVG(cd.promedio) + ? * ?) / (SUM(cd.participantes) + ?) AS sc,
                 SUM(cd.participantes) AS p
          FROM cd_src cd
          JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
          JOIN docentes d ON d.id = cd.docentes_id
          WHERE cd.participantes > 0
          GROUP BY d.id
          HAVING p >= 30
        ) x
        GROUP BY rango
      ) y ORDER BY ord DESC
    `, [M, C, M]),

    // 10) Lista priorizada de intervenciones: (C - score) × n  (impacto institucional, filtrable)
    q(`
      WITH ${CD_CTE}
      SELECT d.id,
             CONCAT_WS(' ', d.paterno, d.materno, d.nombres) AS docente,
             d.nro_documento AS dni,
             CASE d.condicion WHEN '2' THEN 'UNAP' WHEN '1' THEN 'Particular' ELSE '—' END AS vinculo,
             ROUND(AVG(cd.promedio), 2) AS promedio_crudo,
             ROUND((SUM(cd.participantes) * AVG(cd.promedio) + ? * ?) / (SUM(cd.participantes) + ?), 2) AS score,
             SUM(cd.participantes) AS participantes,
             COUNT(DISTINCT ca.cursos_id) AS cursos,
             COUNT(DISTINCT ca.grupo_aulas_id) AS grupos,
             ROUND((? - (SUM(cd.participantes) * AVG(cd.promedio) + ? * ?) / (SUM(cd.participantes) + ?)) * SUM(cd.participantes), 1) AS impacto
      FROM cd_src cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      ${F.joinsCa}
      JOIN docentes d ON d.id = cd.docentes_id
      WHERE cd.participantes > 0 ${F.whereCa}
      GROUP BY d.id
      HAVING participantes >= 30
         AND (SUM(cd.participantes) * AVG(cd.promedio) + ? * ?) / (SUM(cd.participantes) + ?) < ?
      ORDER BY impacto DESC
      LIMIT 20
    `, [M, C, M, C, M, C, M, ...F.valuesCa, M, C, M, C]),
    ]); // ===== fin OLA 2 =====

    res.json({
      kpis,
      bayes: { C, m: M, formula: 'score = (n·prom_doc + m·C)/(n+m); prom_doc = media de promedios por grupo' },
      solo_validas: soloValidas,
      umbral_asistencia: UMBRAL_ASISTENCIA,
      umbral_robusta: umbralRobusta,
      robustez_conteo: robustez,
      filtros_aplicados: F.aplicados,
      participacion_ciclo: {
        total_inscritos: Number(participacionCiclo[0]?.total_inscritos || 0),
        calificaron: Number(participacionCiclo[0]?.inscritos_calificaron || 0),
        no_calificaron: Number(participacionCiclo[0]?.total_inscritos || 0) - Number(participacionCiclo[0]?.inscritos_calificaron || 0),
      },
      distribucion_cumplimiento: distribucion,
      cobertura_por_sede: porSede,
      top_docentes: topDocentes,
      bottom_docentes: bottomDocentes,
      distribucion_promedios: distPromedios,
      ranking_por_curso: rankingPorCurso,
      ranking_por_area: rankingPorArea,
      ranking_por_turno: rankingPorTurno,
      ranking_por_sede: rankingPorSede,
      por_pregunta: porPregunta,
      por_modalidad: porModalidad,
      intervenciones,
      varianza_cursos: varianzaCursos,
      grupos_riesgo: gruposRiesgo,
      evolucion,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Error docentes-stats:', e);
    res.status(500).json({ error: 'Error al generar el dashboard' });
  }
});

// ---- Buscador de docente (autocompletar por DNI / código UNAP / nombre) ----
app.get('/api/stats/docentes-stats/buscar', requireAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ resultados: [] });
  let conn;
  try {
    conn = await pool.getConnection();
    const like = `%${q}%`;
    const [rows] = await conn.query(`
      SELECT d.id,
             d.nro_documento AS dni,
             d.codigo_unap,
             CONCAT_WS(' ', d.paterno, d.materno, d.nombres) AS nombre,
             CASE d.condicion WHEN '2' THEN 'UNAP' WHEN '1' THEN 'Particular' ELSE '—' END AS vinculo,
             d.profesion
      FROM docentes d
      WHERE d.nro_documento LIKE ?
         OR d.codigo_unap LIKE ?
         OR CONCAT_WS(' ', d.paterno, d.materno, d.nombres) LIKE ?
      ORDER BY d.paterno, d.materno, d.nombres
      LIMIT 25
    `, [like, like, like]);
    conn.release();
    res.json({ resultados: rows });
  } catch (e) {
    if (conn) conn.release();
    console.error('Error buscar docente:', e);
    res.status(500).json({ error: 'Error al buscar', message: e.message });
  }
});

// ---- Ficha individual del docente (perfil + ranking + cargas + preguntas) ----
app.get('/api/stats/docentes-stats/docente/:id', requireAdmin, cacheMiddleware(120), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });
  const soloValidas = req.query.solo_validas === '1' || req.query.solo_validas === 'true';
  const CD_CTE = cdSourceCTE(soloValidas);
  const JOIN_ASIST = soloValidas
    ? `JOIN (${ASIST_VALIDA_SQL}) av ON av.estudiantes_id = cdd.estudiantes_id`
    : '';
  try {
    // Pool helper: cada query usa su propia conexión → permite Promise.all.
    const q = (sql, params) => pool.query(sql, params).then(r => r[0]);

    // ===== OLA 1: identidad + bayes globales + todo lo que depende solo de :id =====
    const [
      docRows, perDoc, resumenRows, cargas, porPregunta,
      porModalidad, polarizacionRows, consistenciaRows, asistenciaRows, observaciones,
    ] = await Promise.all([
    // 1) Identidad
    q(`
      SELECT id,
             nro_documento AS dni,
             codigo_unap,
             CONCAT_WS(' ', paterno, materno, nombres) AS nombre,
             CASE condicion WHEN '2' THEN 'UNAP' WHEN '1' THEN 'Particular' ELSE '—' END AS vinculo,
             profesion, email
      FROM docentes WHERE id = ?
    `, [id]),

    // 2) Parámetros bayesianos (C, m)
    q(`
      WITH ${CD_CTE}
      SELECT AVG(cd.promedio) AS prom_doc, SUM(cd.participantes) AS n
      FROM cd_src cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      WHERE cd.participantes > 0
      GROUP BY cd.docentes_id
    `),

    // 3) Resumen del docente (titular, periodo activo)
    q(`
      WITH ${CD_CTE}
      SELECT AVG(cd.promedio) AS prom_doc,
             COALESCE(SUM(cd.participantes), 0) AS n,
             COUNT(DISTINCT cd.carga_academicas_id) AS asignaciones,
             COUNT(DISTINCT ca.cursos_id) AS cursos_distintos,
             COUNT(DISTINCT ca.grupo_aulas_id) AS grupos_distintos
      FROM cd_src cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      WHERE cd.docentes_id = ? AND cd.participantes > 0
    `, [id]),

    // 5) Detalle por carga académica (curso × grupo titular)
    q(`
      WITH ${CD_CTE}
      SELECT cd.id,
             c.denominacion AS curso,
             g.denominacion AS grupo,
             ar.denominacion AS area,
             t.denominacion AS turno,
             COALESCE(s.denominacion, '— Sin local —') AS sede,
             ROUND(cd.promedio, 2) AS promedio, cd.participantes
      FROM cd_src cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      JOIN cursos c ON c.id = ca.cursos_id
      JOIN grupo_aulas ga ON ga.id = ca.grupo_aulas_id
      JOIN grupos g ON g.id = ga.grupos_id
      JOIN areas ar ON ar.id = ga.areas_id
      JOIN turnos t ON t.id = ga.turnos_id
      LEFT JOIN aulas au ON au.id = ga.aulas_id
      LEFT JOIN locales lo ON lo.id = au.locales_id
      LEFT JOIN sedes s ON s.id = lo.sedes_id
      WHERE cd.docentes_id = ?
      ORDER BY cd.promedio DESC, cd.participantes DESC
    `, [id]),

    // 6) Desempeño por pregunta (docente vs media institucional)
    q(`
      SELECT cr.id, cr.denominacion AS pregunta,
             ROUND(AVG(CASE WHEN cd.docentes_id = ? THEN cdd.puntaje END), 2) AS promedio_docente,
             ROUND(AVG(cdd.puntaje), 2) AS promedio_global,
             SUM(CASE WHEN cd.docentes_id = ? THEN 1 ELSE 0 END) AS n_docente
      FROM calificacion_docente_detalles cdd
      JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      JOIN criterios cr ON cr.id = cdd.criterios_id
      ${JOIN_ASIST}
      WHERE cr.tipo='1' AND cr.estado='1' AND cr.modalidad = cd.modalidad
      GROUP BY cr.id, cr.denominacion
      HAVING n_docente > 0
      ORDER BY promedio_docente DESC
    `, [id, id]),

    // 7) Modalidad del docente (virtual vs presencial)
    q(`
      WITH ${CD_CTE}
      SELECT CASE cd.modalidad WHEN '1' THEN 'Virtual' WHEN '0' THEN 'Presencial' ELSE 'Otra' END AS modalidad,
             ROUND(AVG(cd.promedio), 2) AS promedio,
             SUM(cd.participantes) AS calificaciones,
             COUNT(DISTINCT cd.carga_academicas_id) AS cargas
      FROM cd_src cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      WHERE cd.docentes_id = ? AND cd.participantes > 0
      GROUP BY cd.modalidad
      ORDER BY cd.modalidad
    `, [id]),

    // 8) Polarización de respuestas (% top, % medio, % crítica)
    q(`
      SELECT
        COUNT(*) AS total,
        SUM(cdd.puntaje = 5)       AS top5,
        SUM(cdd.puntaje = 4)       AS p4,
        SUM(cdd.puntaje = 3)       AS p3,
        SUM(cdd.puntaje IN (1,2))  AS criticas,
        ROUND(100 * SUM(cdd.puntaje = 5)      / COUNT(*), 1) AS pct_top,
        ROUND(100 * SUM(cdd.puntaje IN (4))   / COUNT(*), 1) AS pct_buena,
        ROUND(100 * SUM(cdd.puntaje IN (3))   / COUNT(*), 1) AS pct_regular,
        ROUND(100 * SUM(cdd.puntaje IN (1,2)) / COUNT(*), 1) AS pct_critica
      FROM calificacion_docente_detalles cdd
      JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      JOIN criterios cr ON cr.id = cdd.criterios_id
      ${JOIN_ASIST}
      WHERE cd.docentes_id = ? AND cr.tipo='1' AND cr.estado='1'
    `, [id]),

    // 9) Consistencia entre grupos (desviación estándar de sus promedios)
    q(`
      WITH ${CD_CTE}
      SELECT
        ROUND(STDDEV_POP(cd.promedio), 3) AS desviacion,
        ROUND(MIN(cd.promedio), 2) AS min_grupo,
        ROUND(MAX(cd.promedio), 2) AS max_grupo,
        ROUND(MAX(cd.promedio) - MIN(cd.promedio), 2) AS rango,
        COUNT(*) AS n_grupos
      FROM cd_src cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      WHERE cd.docentes_id = ? AND cd.participantes > 0
    `, [id]),

    // 10) Asistencia del docente (puntualidad)
    q(`
      SELECT
        COUNT(*) AS total_sesiones,
        SUM(ad.estado='1') AS presente,
        SUM(ad.estado='2') AS tarde,
        SUM(ad.estado='3') AS falta,
        ROUND(100 * SUM(ad.estado='1') / NULLIF(COUNT(*),0), 1) AS pct_presente,
        ROUND(100 * SUM(ad.estado='2') / NULLIF(COUNT(*),0), 1) AS pct_tarde,
        ROUND(100 * SUM(ad.estado='3') / NULLIF(COUNT(*),0), 1) AS pct_falta,
        COALESCE(SUM(ad.cantidad_horas), 0) AS horas_dictadas
      FROM asistencia_docentes ad
      JOIN carga_academicas ca ON ca.id = ad.carga_academicas_id AND ca.tipo='1'
      WHERE ad.docentes_id = ?
    `, [id]),

    // 11) Observaciones del auxiliar (notas cualitativas de las sesiones)
    q(`
      SELECT ad.id, ad.fecha, ad.estado, ad.hora_inicio,
             c.denominacion AS curso,
             g.denominacion AS grupo,
             ad.observacion AS texto
      FROM asistencia_docentes ad
      JOIN carga_academicas ca ON ca.id = ad.carga_academicas_id
      JOIN cursos c ON c.id = ca.cursos_id
      JOIN grupo_aulas ga ON ga.id = ca.grupo_aulas_id
      JOIN grupos g ON g.id = ga.grupos_id
      WHERE ad.docentes_id = ?
        AND ad.observacion IS NOT NULL AND TRIM(ad.observacion) <> ''
      ORDER BY ad.fecha DESC, ad.id DESC
      LIMIT 30
    `, [id]),
    ]); // ===== fin OLA 1 =====

    const doc = docRows[0];
    if (!doc) return res.status(404).json({ error: 'Docente no encontrado' });
    const resumen = resumenRows[0];
    const polarizacion = polarizacionRows[0];
    const consistencia = consistenciaRows[0];
    const asistencia = asistenciaRows[0];

    // Parámetros bayesianos (C, m) derivados de perDoc
    const proms = perDoc.map(r => Number(r.prom_doc)).filter(x => !isNaN(x));
    const ns = perDoc.map(r => Number(r.n)).filter(x => !isNaN(x)).sort((a,b) => a-b);
    const C = proms.length ? Number((proms.reduce((a,b) => a+b, 0) / proms.length).toFixed(3)) : 4.3;
    const M = Math.max(20, ns.length ? ns[Math.floor(ns.length/2)] : 30);

    const promCrudo = Number(resumen.prom_doc) || 0;
    const n = Number(resumen.n) || 0;
    const score = n > 0 ? (n * promCrudo + M * C) / (n + M) : null;
    const robustez = n >= 50 ? 'robusta' : n >= 30 ? 'referencial' : n > 0 ? 'insuficiente' : 'sin_datos';

    // 4) Posición en el ranking institucional (solo si n >= 30; depende de C/M)
    let posicion = null, totalRanking = null;
    if (n >= 30) {
      const ranks = await q(`
        WITH ${CD_CTE}
        SELECT cd.docentes_id,
               (SUM(cd.participantes) * AVG(cd.promedio) + ? * ?) / (SUM(cd.participantes) + ?) AS sc
        FROM cd_src cd
        JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
        WHERE cd.participantes > 0
        GROUP BY cd.docentes_id
        HAVING SUM(cd.participantes) >= 30
        ORDER BY sc DESC
      `, [M, C, M]);
      totalRanking = ranks.length;
      const idx = ranks.findIndex(r => Number(r.docentes_id) === id);
      posicion = idx >= 0 ? idx + 1 : null;
    }

    res.json({
      docente: doc,
      bayes: { C, m: M },
      solo_validas: soloValidas,
      umbral_asistencia: UMBRAL_ASISTENCIA,
      resumen: {
        promedio_crudo: Number(promCrudo.toFixed(2)),
        score: score != null ? Number(score.toFixed(2)) : null,
        participantes: n,
        asignaciones: Number(resumen.asignaciones || 0),
        cursos_distintos: Number(resumen.cursos_distintos || 0),
        grupos_distintos: Number(resumen.grupos_distintos || 0),
        robustez,
        posicion,
        total_ranking: totalRanking,
        media_institucional: C
      },
      cargas,
      por_pregunta: porPregunta,
      por_modalidad: porModalidad,
      polarizacion,
      consistencia,
      asistencia,
      observaciones,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('Error ficha docente:', e);
    res.status(500).json({ error: 'Error al generar la ficha' });
  }
});

// ---- Ranking de docentes dentro de un curso (score bayesiano local al curso) ----
app.get('/api/stats/docentes-stats/curso', requireAdmin, cacheMiddleware(180), async (req, res) => {
  const curso = String(req.query.curso || '').trim();
  if (curso.length < 2) return res.status(400).json({ error: 'Parámetro "curso" requerido' });
  const soloValidas = req.query.solo_validas === '1' || req.query.solo_validas === 'true';
  const CD_CTE = cdSourceCTE(soloValidas);
  const JOIN_ASIST = soloValidas
    ? `JOIN (${ASIST_VALIDA_SQL}) av ON av.estudiantes_id = cdd.estudiantes_id`
    : '';
  let conn;
  try {
    conn = await pool.getConnection();

    // C y m LOCALES al curso (no globales): permite comparación justa entre docentes del mismo curso
    const [perDoc] = await conn.query(`
      WITH ${CD_CTE}
      SELECT cd.docentes_id,
             AVG(cd.promedio) AS prom_doc,
             SUM(cd.participantes) AS n
      FROM cd_src cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      JOIN cursos c ON c.id = ca.cursos_id
      WHERE cd.participantes > 0 AND c.denominacion = ?
      GROUP BY cd.docentes_id
    `, [curso]);

    if (!perDoc.length) {
      conn.release();
      return res.json({ curso, bayes: null, docentes: [], total_calificaciones: 0 });
    }

    const proms = perDoc.map(r => Number(r.prom_doc));
    const ns = perDoc.map(r => Number(r.n)).sort((a, b) => a - b);
    const C = Number((proms.reduce((a, b) => a + b, 0) / proms.length).toFixed(3));
    const medianaN = ns[Math.floor(ns.length / 2)] || 20;
    const M = Math.max(10, medianaN);  // umbral más bajo que el global (intra-curso = muestras menores)

    const [docentes] = await conn.query(`
      WITH ${CD_CTE},
      detalles AS (
        SELECT cd.docentes_id,
               SUM(cdd.puntaje = 5)       AS top5,
               SUM(cdd.puntaje IN (1,2))  AS criticas,
               COUNT(*)                    AS total_resp
        FROM calificacion_docente_detalles cdd
        JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id
        JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
        JOIN cursos c ON c.id = ca.cursos_id
        JOIN criterios cr ON cr.id = cdd.criterios_id
        ${JOIN_ASIST}
        WHERE c.denominacion = ? AND cr.tipo='1' AND cr.estado='1'
        GROUP BY cd.docentes_id
      )
      SELECT d.id,
             CONCAT_WS(' ', d.paterno, d.materno, d.nombres) AS docente,
             d.nro_documento AS dni,
             CASE d.condicion WHEN '2' THEN 'UNAP' WHEN '1' THEN 'Particular' ELSE '—' END AS vinculo,
             ROUND(AVG(cd.promedio), 2) AS promedio_crudo,
             ROUND((SUM(cd.participantes) * AVG(cd.promedio) + ? * ?) / (SUM(cd.participantes) + ?), 2) AS score,
             SUM(cd.participantes) AS participantes,
             COUNT(DISTINCT cd.carga_academicas_id) AS grupos,
             ROUND(100 * det.top5     / NULLIF(det.total_resp, 0), 1) AS pct_top,
             ROUND(100 * det.criticas / NULLIF(det.total_resp, 0), 1) AS pct_critica,
             CASE WHEN SUM(cd.participantes) >= 30 THEN 'robusta'
                  WHEN SUM(cd.participantes) >= 15 THEN 'referencial'
                  ELSE 'insuficiente' END AS robustez
      FROM cd_src cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      JOIN cursos c ON c.id = ca.cursos_id
      JOIN docentes d ON d.id = cd.docentes_id
      LEFT JOIN detalles det ON det.docentes_id = d.id
      WHERE cd.participantes > 0 AND c.denominacion = ?
      GROUP BY d.id, det.top5, det.criticas, det.total_resp
      ORDER BY score DESC, participantes DESC
    `, [curso, M, C, M, curso]);

    const total = docentes.reduce((a, b) => a + Number(b.participantes), 0);
    conn.release();
    res.json({
      curso,
      bayes: { C, m: M, formula: 'score local al curso = (n·prom_doc + m·C_curso)/(n+m)' },
      docentes,
      total_calificaciones: total,
      total_docentes: docentes.length,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    if (conn) conn.release();
    console.error('Error ranking por curso:', e);
    res.status(500).json({ error: 'Error al generar el ranking', message: e.message });
  }
});

// ---- Heatmap docente × pregunta para un curso ----
app.get('/api/stats/docentes-stats/heatmap', requireAdmin, cacheMiddleware(180), async (req, res) => {
  const curso = String(req.query.curso || '').trim();
  if (curso.length < 2) return res.status(400).json({ error: 'Parámetro "curso" requerido' });
  const soloValidas = req.query.solo_validas === '1' || req.query.solo_validas === 'true';
  const JOIN_ASIST = soloValidas
    ? `JOIN (${ASIST_VALIDA_SQL}) av ON av.estudiantes_id = cdd.estudiantes_id`
    : '';
  let conn;
  try {
    conn = await pool.getConnection();

    const [preguntas] = await conn.query(`
      SELECT id, denominacion FROM criterios WHERE tipo='1' AND estado='1' ORDER BY id
    `);

    const [filas] = await conn.query(`
      SELECT cd.docentes_id AS docente_id,
             CONCAT_WS(' ', d.paterno, d.materno, d.nombres) AS docente,
             cdd.criterios_id AS pregunta_id,
             ROUND(AVG(cdd.puntaje), 2) AS promedio,
             COUNT(*) AS n
      FROM calificacion_docente_detalles cdd
      JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      JOIN cursos c ON c.id = ca.cursos_id
      JOIN docentes d ON d.id = cd.docentes_id
      JOIN criterios cr ON cr.id = cdd.criterios_id
      ${JOIN_ASIST}
      WHERE c.denominacion = ? AND cr.tipo='1' AND cr.estado='1' AND cr.modalidad = cd.modalidad
      GROUP BY cd.docentes_id, cdd.criterios_id
    `, [curso]);

    // Pivotar en JS a matriz: filas = docentes, columnas = preguntas
    const docentesMap = new Map();
    for (const row of filas) {
      if (!docentesMap.has(row.docente_id)) {
        docentesMap.set(row.docente_id, { id: row.docente_id, nombre: row.docente, byPregunta: {}, n_total: 0 });
      }
      const d = docentesMap.get(row.docente_id);
      d.byPregunta[row.pregunta_id] = Number(row.promedio);
      d.n_total += Number(row.n);
    }

    const docentes = [...docentesMap.values()]
      .map(d => {
        const valores = preguntas.map(p => (d.byPregunta[p.id] != null ? d.byPregunta[p.id] : null));
        const validos = valores.filter(v => v !== null);
        const promedio = validos.length ? Number((validos.reduce((a, b) => a + b, 0) / validos.length).toFixed(2)) : 0;
        return { id: d.id, nombre: d.nombre, valores, promedio, n: d.n_total };
      })
      .filter(d => d.valores.filter(v => v !== null).length >= 1)
      .sort((a, b) => b.promedio - a.promedio);

    // Promedio del curso por pregunta (para fila resumen)
    const promedio_curso_por_pregunta = preguntas.map(p => {
      const vals = docentes.map(d => d.valores[preguntas.indexOf(p)]).filter(v => v !== null);
      return vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : null;
    });

    conn.release();
    res.json({ curso, preguntas, docentes, promedio_curso_por_pregunta, timestamp: new Date().toISOString() });
  } catch (e) {
    if (conn) conn.release();
    console.error('Error heatmap:', e);
    res.status(500).json({ error: 'Error al generar el heatmap', message: e.message });
  }
});

// ===== Helper Excel: workbook con título azul + fecha + tabla =====
function _setupDocentesWorkbook(ws, titulo, headers) {
  const ExcelJS = require('exceljs');
  const lastCol = headers.length;
  ws.mergeCells(1, 1, 1, lastCol);
  ws.getCell(1, 1).value = titulo;
  ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  ws.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
  ws.getCell(1, 1).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 24;
  ws.mergeCells(2, 1, 2, lastCol);
  ws.getCell(2, 1).value = `Generado: ${new Date().toLocaleString('es-PE')} · CEPREUNA — Docentes Stats`;
  ws.getCell(2, 1).font = { italic: true, size: 10, color: { argb: 'FF666666' } };
  ws.getCell(2, 1).alignment = { horizontal: 'center' };
  const headerRow = ws.getRow(4);
  headerRow.values = headers;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  });
}

// ---- Export: Lista priorizada de intervenciones (con filtros opcionales) ----
app.get('/api/stats/docentes-stats/export/intervenciones.xlsx', requireAdmin, async (req, res) => {
  const F = buildDashboardFilters(req.query);
  let conn;
  try {
    conn = await pool.getConnection();
    // Recalcular C y M con los mismos parametros que el dashboard (sin filtro, escala institucional)
    const [perDoc] = await conn.query(`
      SELECT AVG(cd.promedio) AS prom_doc, SUM(cd.participantes) AS n
      FROM calificacion_docentes cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      WHERE cd.participantes > 0
      GROUP BY cd.docentes_id
    `);
    const proms = perDoc.map(r => Number(r.prom_doc)).filter(x => !isNaN(x));
    const ns = perDoc.map(r => Number(r.n)).filter(x => !isNaN(x)).sort((a, b) => a - b);
    const C = proms.length ? Number((proms.reduce((a, b) => a + b, 0) / proms.length).toFixed(3)) : 4.3;
    const M = Math.max(20, ns.length ? ns[Math.floor(ns.length / 2)] : 30);

    const [rows] = await conn.query(`
      SELECT d.id,
             CONCAT_WS(' ', d.paterno, d.materno, d.nombres) AS docente,
             d.nro_documento AS dni,
             CASE d.condicion WHEN '2' THEN 'UNAP' WHEN '1' THEN 'Particular' ELSE '—' END AS vinculo,
             ROUND(AVG(cd.promedio), 2) AS promedio_crudo,
             ROUND((SUM(cd.participantes) * AVG(cd.promedio) + ? * ?) / (SUM(cd.participantes) + ?), 2) AS score,
             SUM(cd.participantes) AS participantes,
             COUNT(DISTINCT ca.cursos_id) AS cursos,
             COUNT(DISTINCT ca.grupo_aulas_id) AS grupos,
             ROUND((? - (SUM(cd.participantes) * AVG(cd.promedio) + ? * ?) / (SUM(cd.participantes) + ?)) * SUM(cd.participantes), 1) AS impacto
      FROM calificacion_docentes cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      ${F.joinsCa}
      JOIN docentes d ON d.id = cd.docentes_id
      WHERE cd.participantes > 0 ${F.whereCa}
      GROUP BY d.id
      HAVING participantes >= 30
         AND (SUM(cd.participantes) * AVG(cd.promedio) + ? * ?) / (SUM(cd.participantes) + ?) < ?
      ORDER BY impacto DESC
      LIMIT 50
    `, [M, C, M, C, M, C, M, ...F.valuesCa, M, C, M, C]);
    conn.release();

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CEPREUNA Stats';
    const ws = wb.addWorksheet('Intervenciones');
    const headers = ['#', 'Docente', 'DNI', 'Vínculo', 'Score', 'Promedio crudo', 'Calificaciones', 'Cursos', 'Grupos', 'Impacto'];
    _setupDocentesWorkbook(ws, 'Lista priorizada de intervenciones · CEPREUNA', headers);
    rows.forEach((r, i) => {
      const row = ws.getRow(5 + i);
      row.values = [i + 1, r.docente, r.dni, r.vinculo, Number(r.score), Number(r.promedio_crudo), Number(r.participantes), Number(r.cursos), Number(r.grupos), Number(r.impacto)];
      row.eachCell((cell, col) => {
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        cell.alignment = { horizontal: col >= 5 ? 'right' : 'left' };
      });
    });
    ws.columns = [{ width: 5 }, { width: 38 }, { width: 12 }, { width: 12 }, { width: 9 }, { width: 14 }, { width: 14 }, { width: 8 }, { width: 8 }, { width: 11 }];

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="intervenciones-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    if (conn) conn.release();
    console.error('Error export intervenciones:', e);
    res.status(500).json({ error: 'Error al generar Excel', message: e.message });
  }
});

// ---- Export: Ranking de docentes en un curso ----
app.get('/api/stats/docentes-stats/export/curso.xlsx', requireAdmin, async (req, res) => {
  const curso = String(req.query.curso || '').trim();
  if (curso.length < 2) return res.status(400).json({ error: 'Parámetro "curso" requerido' });
  let conn;
  try {
    conn = await pool.getConnection();
    const [perDoc] = await conn.query(`
      SELECT AVG(cd.promedio) AS prom_doc, SUM(cd.participantes) AS n
      FROM calificacion_docentes cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      JOIN cursos c ON c.id = ca.cursos_id
      WHERE cd.participantes > 0 AND c.denominacion = ?
      GROUP BY cd.docentes_id
    `, [curso]);
    if (!perDoc.length) { conn.release(); return res.status(404).json({ error: 'Curso sin datos' }); }
    const proms = perDoc.map(r => Number(r.prom_doc));
    const ns = perDoc.map(r => Number(r.n)).sort((a, b) => a - b);
    const C = Number((proms.reduce((a, b) => a + b, 0) / proms.length).toFixed(3));
    const M = Math.max(10, ns[Math.floor(ns.length / 2)] || 20);

    const [rows] = await conn.query(`
      WITH detalles AS (
        SELECT cd.docentes_id,
               SUM(cdd.puntaje = 5)       AS top5,
               SUM(cdd.puntaje IN (1,2))  AS criticas,
               COUNT(*)                    AS total_resp
        FROM calificacion_docente_detalles cdd
        JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id
        JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
        JOIN cursos c ON c.id = ca.cursos_id
        JOIN criterios cr ON cr.id = cdd.criterios_id
        WHERE c.denominacion = ? AND cr.tipo='1' AND cr.estado='1'
        GROUP BY cd.docentes_id
      )
      SELECT CONCAT_WS(' ', d.paterno, d.materno, d.nombres) AS docente,
             d.nro_documento AS dni,
             CASE d.condicion WHEN '2' THEN 'UNAP' WHEN '1' THEN 'Particular' ELSE '—' END AS vinculo,
             ROUND(AVG(cd.promedio), 2) AS promedio_crudo,
             ROUND((SUM(cd.participantes) * AVG(cd.promedio) + ? * ?) / (SUM(cd.participantes) + ?), 2) AS score,
             SUM(cd.participantes) AS participantes,
             COUNT(DISTINCT cd.carga_academicas_id) AS grupos,
             ROUND(100 * det.top5     / NULLIF(det.total_resp, 0), 1) AS pct_top,
             ROUND(100 * det.criticas / NULLIF(det.total_resp, 0), 1) AS pct_critica
      FROM calificacion_docentes cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      JOIN cursos c ON c.id = ca.cursos_id
      JOIN docentes d ON d.id = cd.docentes_id
      LEFT JOIN detalles det ON det.docentes_id = d.id
      WHERE cd.participantes > 0 AND c.denominacion = ?
      GROUP BY d.id, det.top5, det.criticas, det.total_resp
      ORDER BY score DESC, participantes DESC
    `, [curso, M, C, M, curso]);
    conn.release();

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CEPREUNA Stats';
    const ws = wb.addWorksheet('Ranking');
    const headers = ['#', 'Docente', 'DNI', 'Vínculo', 'Score', 'Promedio crudo', '% Top (5)', '% Crítica (1-2)', 'Calificaciones', 'Grupos'];
    _setupDocentesWorkbook(ws, `Ranking de docentes · ${curso}`, headers);
    rows.forEach((r, i) => {
      const row = ws.getRow(5 + i);
      row.values = [i + 1, r.docente, r.dni, r.vinculo, Number(r.score), Number(r.promedio_crudo), r.pct_top == null ? '' : Number(r.pct_top), r.pct_critica == null ? '' : Number(r.pct_critica), Number(r.participantes), Number(r.grupos)];
      row.eachCell((cell, col) => {
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        cell.alignment = { horizontal: col >= 5 ? 'right' : 'left' };
      });
    });
    ws.columns = [{ width: 5 }, { width: 38 }, { width: 12 }, { width: 12 }, { width: 9 }, { width: 14 }, { width: 11 }, { width: 14 }, { width: 14 }, { width: 8 }];

    const buf = await wb.xlsx.writeBuffer();
    const safeName = curso.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ranking-${safeName}-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    if (conn) conn.release();
    console.error('Error export curso:', e);
    res.status(500).json({ error: 'Error al generar Excel', message: e.message });
  }
});

// ---- Export: Ficha individual del docente (multi-hoja) ----
app.get('/api/stats/docentes-stats/export/ficha/:id.xlsx', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });
  let conn;
  try {
    conn = await pool.getConnection();
    const [[doc]] = await conn.query(`
      SELECT id, nro_documento AS dni, codigo_unap,
             CONCAT_WS(' ', paterno, materno, nombres) AS nombre,
             CASE condicion WHEN '2' THEN 'UNAP' WHEN '1' THEN 'Particular' ELSE '—' END AS vinculo,
             profesion, email
      FROM docentes WHERE id = ?
    `, [id]);
    if (!doc) { conn.release(); return res.status(404).json({ error: 'Docente no encontrado' }); }

    const [cargas] = await conn.query(`
      SELECT c.denominacion AS curso, g.denominacion AS grupo,
             ar.denominacion AS area, t.denominacion AS turno,
             COALESCE(s.denominacion, '— Sin local —') AS sede,
             cd.promedio, cd.participantes
      FROM calificacion_docentes cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      JOIN cursos c ON c.id = ca.cursos_id
      JOIN grupo_aulas ga ON ga.id = ca.grupo_aulas_id
      JOIN grupos g ON g.id = ga.grupos_id
      JOIN areas ar ON ar.id = ga.areas_id
      JOIN turnos t ON t.id = ga.turnos_id
      LEFT JOIN aulas au ON au.id = ga.aulas_id
      LEFT JOIN locales lo ON lo.id = au.locales_id
      LEFT JOIN sedes s ON s.id = lo.sedes_id
      WHERE cd.docentes_id = ?
      ORDER BY cd.promedio DESC
    `, [id]);

    const [porPregunta] = await conn.query(`
      SELECT cr.denominacion AS pregunta,
             ROUND(AVG(CASE WHEN cd.docentes_id = ? THEN cdd.puntaje END), 2) AS prom_doc,
             ROUND(AVG(cdd.puntaje), 2) AS prom_global
      FROM calificacion_docente_detalles cdd
      JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      JOIN criterios cr ON cr.id = cdd.criterios_id
      WHERE cr.tipo='1' AND cr.estado='1'
      GROUP BY cr.id, cr.denominacion
      HAVING prom_doc IS NOT NULL
      ORDER BY prom_doc DESC
    `, [id]);

    const [observaciones] = await conn.query(`
      SELECT ad.fecha, ad.estado, c.denominacion AS curso, g.denominacion AS grupo, ad.observacion
      FROM asistencia_docentes ad
      JOIN carga_academicas ca ON ca.id = ad.carga_academicas_id
      JOIN cursos c ON c.id = ca.cursos_id
      JOIN grupo_aulas ga ON ga.id = ca.grupo_aulas_id
      JOIN grupos g ON g.id = ga.grupos_id
      WHERE ad.docentes_id = ? AND ad.observacion IS NOT NULL AND TRIM(ad.observacion) <> ''
      ORDER BY ad.fecha DESC LIMIT 100
    `, [id]);

    conn.release();

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CEPREUNA Stats';

    // Hoja 1: Identidad
    const ws1 = wb.addWorksheet('Resumen');
    _setupDocentesWorkbook(ws1, `Ficha docente · ${doc.nombre}`, ['Campo', 'Valor']);
    const idData = [
      ['Nombre', doc.nombre], ['DNI', doc.dni || '—'], ['Vínculo', doc.vinculo],
      ['Código UNAP', doc.codigo_unap || '—'], ['Profesión', doc.profesion || '—'], ['Email', doc.email || '—']
    ];
    idData.forEach((r, i) => {
      const row = ws1.getRow(5 + i);
      row.values = r;
      row.getCell(1).font = { bold: true };
      row.eachCell(cell => cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } });
    });
    ws1.columns = [{ width: 18 }, { width: 50 }];

    // Hoja 2: Cargas
    const ws2 = wb.addWorksheet('Cursos y grupos');
    _setupDocentesWorkbook(ws2, `Cursos y grupos · ${doc.nombre}`, ['Curso', 'Grupo', 'Área', 'Turno', 'Sede', 'Calificaciones', 'Promedio']);
    cargas.forEach((r, i) => {
      const row = ws2.getRow(5 + i);
      row.values = [r.curso, r.grupo, r.area, r.turno, r.sede, Number(r.participantes), Number(r.promedio)];
      row.eachCell(cell => cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } });
    });
    ws2.columns = [{ width: 24 }, { width: 12 }, { width: 14 }, { width: 10 }, { width: 18 }, { width: 14 }, { width: 10 }];

    // Hoja 3: Preguntas
    const ws3 = wb.addWorksheet('Por pregunta');
    _setupDocentesWorkbook(ws3, `Desempeño por pregunta · ${doc.nombre}`, ['Pregunta', 'Promedio docente', 'Media institucional', 'Diferencia']);
    porPregunta.forEach((r, i) => {
      const row = ws3.getRow(5 + i);
      const diff = Number(r.prom_doc) - Number(r.prom_global);
      row.values = [r.pregunta, Number(r.prom_doc), Number(r.prom_global), Number(diff.toFixed(2))];
      row.eachCell(cell => cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } });
    });
    ws3.columns = [{ width: 80 }, { width: 16 }, { width: 18 }, { width: 12 }];

    // Hoja 4: Observaciones
    if (observaciones.length) {
      const ws4 = wb.addWorksheet('Observaciones');
      _setupDocentesWorkbook(ws4, `Observaciones del auxiliar · ${doc.nombre}`, ['Fecha', 'Estado', 'Curso', 'Grupo', 'Observación']);
      const estadoLabel = { '1': 'Presente', '2': 'Tarde', '3': 'Falta' };
      observaciones.forEach((r, i) => {
        const row = ws4.getRow(5 + i);
        row.values = [r.fecha, estadoLabel[r.estado] || '—', r.curso, r.grupo, r.observacion];
        row.eachCell(cell => {
          cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
          cell.alignment = { wrapText: true, vertical: 'top' };
        });
      });
      ws4.columns = [{ width: 12 }, { width: 11 }, { width: 18 }, { width: 10 }, { width: 70 }];
    }

    const buf = await wb.xlsx.writeBuffer();
    const safeName = doc.nombre.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ficha-${safeName}-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    if (conn) conn.release();
    console.error('Error export ficha:', e);
    res.status(500).json({ error: 'Error al generar Excel', message: e.message });
  }
});

// ---- Export: Padrón de desempeño docente (una fila por docente, lineal) ----
app.get('/api/stats/docentes-stats/export/padron.xlsx', requireAdmin, async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();

    // Criterios activos → columnas por pregunta
    const [criterios] = await conn.query(`
      SELECT id, denominacion FROM criterios WHERE tipo='1' AND estado='1' ORDER BY id
    `);

    // Parámetros bayesianos C, m (todas las calificaciones)
    const calcCM = (rows) => {
      const proms = rows.map(r => Number(r.prom_doc)).filter(x => !isNaN(x));
      const ns = rows.map(r => Number(r.n)).filter(x => !isNaN(x)).sort((a, b) => a - b);
      const C = proms.length ? Number((proms.reduce((a, b) => a + b, 0) / proms.length).toFixed(3)) : 4.3;
      const M = Math.max(20, ns.length ? ns[Math.floor(ns.length / 2)] : 30);
      return { C, M };
    };
    const [perDocAll] = await conn.query(`
      SELECT AVG(cd.promedio) AS prom_doc, SUM(cd.participantes) AS n
      FROM calificacion_docentes cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      WHERE cd.participantes > 0 GROUP BY cd.docentes_id
    `);
    const { C, M } = calcCM(perDocAll);
    const [perDocVal] = await conn.query(`
      WITH asist_valida AS (${ASIST_VALIDA_SQL})
      SELECT AVG(sub.prom) AS prom_doc, SUM(sub.n) AS n FROM (
        SELECT cd.docentes_id, AVG(cdd.puntaje) AS prom, COUNT(DISTINCT cdd.estudiantes_id) AS n
        FROM calificacion_docente_detalles cdd
        JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id AND cd.estado='1'
        JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
        JOIN criterios cr ON cr.id = cdd.criterios_id AND cr.tipo='1' AND cr.estado='1'
        JOIN asist_valida av ON av.estudiantes_id = cdd.estudiantes_id
        GROUP BY cd.docentes_id, cd.carga_academicas_id
      ) sub GROUP BY sub.docentes_id
    `);
    const { C: Cv, M: Mv } = calcCM(perDocVal);

    // Ranking institucional (para columna posición), todas
    const [ranks] = await conn.query(`
      SELECT cd.docentes_id,
             (SUM(cd.participantes) * AVG(cd.promedio) + ? * ?) / (SUM(cd.participantes) + ?) AS sc
      FROM calificacion_docentes cd
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      WHERE cd.participantes > 0
      GROUP BY cd.docentes_id
      HAVING SUM(cd.participantes) >= 30
      ORDER BY sc DESC
    `, [M, C, M]);
    const posMap = new Map();
    ranks.forEach((r, i) => posMap.set(Number(r.docentes_id), i + 1));
    const totalRanking = ranks.length;

    // Base: SOLO docentes que están en calificacion_docentes/calificacion_docente_detalles
    // (fueron realmente evaluados). El universo y las métricas se anclan en cd.docentes_id
    // —a quién calificaron— NO en ca.docentes_id (titular actual de la carga). Si una carga
    // se reasigna o desactiva tras la evaluación, la calificación SIGUE contando para el
    // docente evaluado (caso 29534119: evaluada en Álgebra, carga luego desasignada).
    // Los titulares activos que NUNCA recibieron calificación NO aparecen aquí
    // (caso 44124860: sin filas en cdd → fuera del padrón).
    const [base] = await conn.query(`
      WITH doc_cargas AS (
        -- Cargas donde el docente fue REALMENTE evaluado (inmutable, por cdd → cd).
        SELECT cd.docentes_id AS doc_id, cd.carga_academicas_id AS carga_id
        FROM calificacion_docentes cd
        WHERE cd.estado='1' AND cd.participantes > 0 AND cd.docentes_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM calificacion_docente_detalles cdd
                      WHERE cdd.calificacion_docentes_id = cd.id)
        GROUP BY cd.docentes_id, cd.carga_academicas_id
      )
      SELECT d.id,
             d.nro_documento AS dni,
             CONCAT_WS(' ', d.paterno, d.materno, d.nombres) AS nombre,
             CASE d.condicion WHEN '2' THEN 'UNAP' WHEN '1' THEN 'Particular' ELSE '—' END AS vinculo,
             d.codigo_unap, d.profesion, d.email,
             ROUND(AVG(cd.promedio), 2) AS prom_crudo,
             COALESCE(SUM(cd.participantes), 0) AS n,
             COUNT(DISTINCT ca.cursos_id) AS n_cursos,
             COUNT(DISTINCT ca.grupo_aulas_id) AS n_grupos,
             COUNT(DISTINCT ca.id) AS n_asignaciones,
             GROUP_CONCAT(DISTINCT cur.denominacion ORDER BY cur.denominacion SEPARATOR ', ') AS cursos,
             GROUP_CONCAT(DISTINCT ar.denominacion ORDER BY ar.denominacion SEPARATOR ', ') AS areas,
             GROUP_CONCAT(DISTINCT t.denominacion ORDER BY t.denominacion SEPARATOR ', ') AS turnos,
             GROUP_CONCAT(DISTINCT COALESCE(s.denominacion,'—') ORDER BY s.denominacion SEPARATOR ', ') AS sedes,
             ROUND(AVG(CASE WHEN cd.modalidad='0' THEN cd.promedio END), 2) AS prom_presencial,
             ROUND(AVG(CASE WHEN cd.modalidad='1' THEN cd.promedio END), 2) AS prom_virtual,
             EXISTS (SELECT 1 FROM carga_academicas cax
                     WHERE cax.docentes_id = d.id AND cax.tipo='1' AND cax.periodos_id=1 AND cax.estado='1') AS tiene_carga_activa
      FROM doc_cargas dc
      JOIN docentes d ON d.id = dc.doc_id
      JOIN carga_academicas ca ON ca.id = dc.carga_id
      LEFT JOIN calificacion_docentes cd ON cd.docentes_id = dc.doc_id AND cd.carga_academicas_id = dc.carga_id
        AND cd.estado='1' AND cd.participantes > 0
      LEFT JOIN cursos cur ON cur.id = ca.cursos_id
      LEFT JOIN grupo_aulas ga ON ga.id = ca.grupo_aulas_id
      LEFT JOIN areas ar ON ar.id = ga.areas_id
      LEFT JOIN turnos t ON t.id = ga.turnos_id
      LEFT JOIN aulas au ON au.id = ga.aulas_id
      LEFT JOIN locales lo ON lo.id = au.locales_id
      LEFT JOIN sedes s ON s.id = lo.sedes_id
      GROUP BY d.id
      ORDER BY d.paterno, d.materno, d.nombres
    `);

    // Score solo válidas por docente (media de promedios por carga, ya filtrada por asistencia)
    const [valRows] = await conn.query(`
      WITH asist_valida AS (${ASIST_VALIDA_SQL})
      SELECT docentes_id, AVG(prom) AS prom_doc, SUM(n) AS n FROM (
        SELECT cd.docentes_id, AVG(cdd.puntaje) AS prom, COUNT(DISTINCT cdd.estudiantes_id) AS n
        FROM calificacion_docente_detalles cdd
        JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id AND cd.estado='1'
        JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
        JOIN criterios cr ON cr.id = cdd.criterios_id AND cr.tipo='1' AND cr.estado='1'
        JOIN asist_valida av ON av.estudiantes_id = cdd.estudiantes_id
        GROUP BY cd.docentes_id, cd.carga_academicas_id
      ) sub GROUP BY docentes_id
    `);
    const valMap = new Map(valRows.map(r => [Number(r.docentes_id), r]));

    // Polarización por docente (% top, % crítica)
    const [polar] = await conn.query(`
      SELECT cd.docentes_id,
             ROUND(100 * SUM(cdd.puntaje=5) / COUNT(*), 1) AS pct_top,
             ROUND(100 * SUM(cdd.puntaje IN (1,2)) / COUNT(*), 1) AS pct_critica
      FROM calificacion_docente_detalles cdd
      JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id AND cd.estado='1'
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      JOIN criterios cr ON cr.id = cdd.criterios_id AND cr.tipo='1' AND cr.estado='1'
      GROUP BY cd.docentes_id
    `);
    const polarMap = new Map(polar.map(r => [Number(r.docentes_id), r]));

    // Asistencia del docente
    const [asist] = await conn.query(`
      SELECT ad.docentes_id,
             COUNT(*) AS sesiones,
             ROUND(100*SUM(ad.estado='1')/COUNT(*),1) AS pct_presente,
             ROUND(100*SUM(ad.estado='2')/COUNT(*),1) AS pct_tarde,
             ROUND(100*SUM(ad.estado='3')/COUNT(*),1) AS pct_falta,
             COALESCE(SUM(ad.cantidad_horas),0) AS horas
      FROM asistencia_docentes ad
      JOIN carga_academicas ca ON ca.id = ad.carga_academicas_id AND ca.tipo='1'
      GROUP BY ad.docentes_id
    `);
    const asistMap = new Map(asist.map(r => [Number(r.docentes_id), r]));

    // Promedio por pregunta (docente × criterio)
    const [pregRows] = await conn.query(`
      SELECT cd.docentes_id, cdd.criterios_id, ROUND(AVG(cdd.puntaje), 2) AS prom
      FROM calificacion_docente_detalles cdd
      JOIN calificacion_docentes cd ON cd.id = cdd.calificacion_docentes_id AND cd.estado='1'
      JOIN carga_academicas ca ON ca.id = cd.carga_academicas_id AND ca.tipo='1'
      -- La pregunta debe corresponder a la modalidad de la clase (cr.modalidad =
      -- cd.modalidad): descarta respuestas cruzadas (p.ej. 1 alumno que respondió
      -- preguntas virtuales en una clase presencial).
      JOIN criterios cr ON cr.id = cdd.criterios_id AND cr.tipo='1' AND cr.estado='1' AND cr.modalidad = cd.modalidad
      GROUP BY cd.docentes_id, cdd.criterios_id
    `);
    const pregMap = new Map();
    for (const r of pregRows) {
      const k = Number(r.docentes_id);
      if (!pregMap.has(k)) pregMap.set(k, {});
      pregMap.get(k)[Number(r.criterios_id)] = Number(r.prom);
    }

    // Construir el workbook
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CEPREUNA Stats';
    const ws = wb.addWorksheet('Padrón docentes');

    const headersFijos = ['#', 'DNI', 'Apellidos y Nombres', 'Vínculo', 'Cód. UNAP', 'Profesión', 'Email', 'Estado carga',
      'Score (todas)', 'Score (válidas ≥80%)', `vs Media (C=${C})`, 'Promedio crudo', 'Participantes', 'Robustez', 'Posición',
      '% Top (5)', '% Crítica (1-2)',
      'N° cursos', 'N° grupos', 'N° asignaciones', 'Cursos', 'Áreas', 'Turnos', 'Sedes',
      'Prom. presencial', 'Prom. virtual',
      'Sesiones', '% Presente', '% Tarde', '% Falta', 'Horas dictadas'];
    const headersPreg = criterios.map((cr, i) => `P${i + 1}`);
    const headers = [...headersFijos, ...headersPreg];

    const lastCol = headers.length;
    ws.mergeCells(1, 1, 1, lastCol);
    ws.getCell(1, 1).value = 'Padrón de desempeño docente · CEPREUNA';
    ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    ws.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
    ws.getCell(1, 1).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 24;
    ws.mergeCells(2, 1, 2, lastCol);
    ws.getCell(2, 1).value = `Generado: ${new Date().toLocaleString('es-PE')} · C=${C} m=${M} · Score válidas: C=${Cv} m=${Mv} · Leyenda P1..P${criterios.length}: ` +
      criterios.map((cr, i) => `P${i + 1}=${cr.denominacion}`).join('  |  ');
    ws.getCell(2, 1).font = { italic: true, size: 9, color: { argb: 'FF666666' } };
    ws.getCell(2, 1).alignment = { horizontal: 'left', wrapText: true };
    ws.getRow(2).height = 42;

    const headerRow = ws.getRow(4);
    headerRow.values = headers;
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, size: 9 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    const colVsMedia = headersFijos.findIndex(h => h.startsWith('vs Media')) + 1;
    base.forEach((d, idx) => {
      const id = Number(d.id);
      const n = Number(d.n) || 0;
      const promCrudo = d.prom_crudo != null ? Number(d.prom_crudo) : null;
      const score = n > 0 && promCrudo != null ? Number(((n * promCrudo + M * C) / (n + M)).toFixed(2)) : null;
      const v = valMap.get(id);
      const nv = v ? Number(v.n) : 0;
      const promV = v ? Number(v.prom_doc) : null;
      // Score válidas solo si el docente está evaluado (n>0): evita mostrar score
      // a partir de cd con participantes desactualizado.
      const scoreV = (n > 0 && nv > 0 && promV != null) ? Number(((nv * promV + Mv * Cv) / (nv + Mv)).toFixed(2)) : null;
      // Comparación contra la media institucional C (mismo criterio que la línea
      // de referencia en las gráficas): ≥ Media si el score alcanza o supera C.
      const vsMedia = score == null ? '' : (score >= C ? '≥ Media' : '< Media');
      const robustez = n >= 50 ? 'robusta' : n >= 30 ? 'referencial' : n > 0 ? 'insuficiente' : 'sin evaluar';
      const pol = polarMap.get(id) || {};
      const asi = asistMap.get(id) || {};
      const pr = pregMap.get(id) || {};

      const estadoCarga = Number(d.tiene_carga_activa) === 1 ? 'Activo' : 'Reasignado/inactivo';
      const fijos = [
        idx + 1, d.dni || '', d.nombre, d.vinculo, d.codigo_unap || '', d.profesion || '', d.email || '', estadoCarga,
        score, scoreV, vsMedia, promCrudo, n, robustez, posMap.get(id) || '',
        pol.pct_top != null ? Number(pol.pct_top) : '', pol.pct_critica != null ? Number(pol.pct_critica) : '',
        Number(d.n_cursos || 0), Number(d.n_grupos || 0), Number(d.n_asignaciones || 0),
        d.cursos || '', d.areas || '', d.turnos || '', d.sedes || '',
        d.prom_presencial != null ? Number(d.prom_presencial) : '', d.prom_virtual != null ? Number(d.prom_virtual) : '',
        Number(asi.sesiones || 0), asi.pct_presente != null ? Number(asi.pct_presente) : '',
        asi.pct_tarde != null ? Number(asi.pct_tarde) : '', asi.pct_falta != null ? Number(asi.pct_falta) : '',
        Number(asi.horas || 0)
      ];
      const pregVals = criterios.map(cr => pr[Number(cr.id)] != null ? pr[Number(cr.id)] : '');
      const row = ws.getRow(5 + idx);
      row.values = [...fijos, ...pregVals];
      row.eachCell((cell) => {
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        cell.font = { size: 9 };
      });
      // Resaltar la celda vs Media (verde = alcanza/supera, ámbar = por debajo)
      if (vsMedia) {
        const cell = row.getCell(colVsMedia);
        const verde = vsMedia.startsWith('≥');
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: verde ? 'FFD1FAE5' : 'FFFEF3C7' } };
        cell.font = { size: 9, bold: true, color: { argb: verde ? 'FF065F46' : 'FF92400E' } };
        cell.alignment = { horizontal: 'center' };
      }
    });

    // Anchos (incluye 'Estado carga' tras Email)
    const widthsFijos = [4, 11, 32, 11, 10, 20, 24, 16, 11, 13, 12, 12, 12, 12, 9, 9, 10, 9, 9, 12, 40, 22, 16, 22, 13, 12, 9, 10, 9, 9, 12];
    ws.columns = headers.map((h, i) => ({ width: i < widthsFijos.length ? widthsFijos[i] : 7 }));
    ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 4 }];

    const buf = await wb.xlsx.writeBuffer();
    conn.release();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="padron-docentes-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    if (conn) conn.release();
    console.error('Error export padron:', e);
    res.status(500).json({ error: 'Error al generar el padrón', message: e.message });
  }
});

// ============ REPORTES AUXILIARES (horas docentes + cobertura) ============

// Helper: parsea un parámetro multi-valor (acepta array o CSV) y devuelve array limpio.
function parseList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map(x => String(x).trim()).filter(Boolean);
}

// Catálogos para los filtros de los reportes
app.get('/api/stats/catalogos/sedes', requireStatsAuth, cacheMiddleware(600), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`SELECT id, denominacion FROM sedes WHERE estado = '1' ORDER BY denominacion`);
    conn.release();
    res.json(rows);
  } catch (e) { if (conn) conn.release(); console.error('Error catálogo stats:', e); res.status(500).json({ error: 'Error al obtener el catálogo' }); }
});

app.get('/api/stats/catalogos/turnos', requireStatsAuth, cacheMiddleware(600), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`SELECT id, denominacion FROM turnos WHERE estado = '1' ORDER BY id`);
    conn.release();
    res.json(rows);
  } catch (e) { if (conn) conn.release(); console.error('Error catálogo stats:', e); res.status(500).json({ error: 'Error al obtener el catálogo' }); }
});

app.get('/api/stats/catalogos/areas', requireStatsAuth, cacheMiddleware(600), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`SELECT id, denominacion FROM areas ORDER BY denominacion`);
    conn.release();
    res.json(rows);
  } catch (e) { if (conn) conn.release(); console.error('Error catálogo stats:', e); res.status(500).json({ error: 'Error al obtener el catálogo' }); }
});

// Grupos: opcionalmente filtra por sede/turno/area; respeta restricción por rol.
app.get('/api/stats/catalogos/grupos', requireStatsAuth, async (req, res) => {
  let conn;
  try {
    const { sede_id, turno_id, area_id } = req.query;
    const allowedGrupos = req.user.grupos;

    const conditions = ['ga.periodos_id = 1'];
    const params = [];
    if (Array.isArray(allowedGrupos)) {
      if (allowedGrupos.length === 0) return res.json([]);
      conditions.push(`ga.id IN (${allowedGrupos.map(() => '?').join(',')})`);
      params.push(...allowedGrupos);
    }
    if (sede_id) { conditions.push('s.id = ?'); params.push(sede_id); }
    if (turno_id) { conditions.push('ga.turnos_id = ?'); params.push(turno_id); }
    if (area_id) { conditions.push('ga.areas_id = ?'); params.push(area_id); }

    conn = await pool.getConnection();
    const [rows] = await conn.query(`
      SELECT ga.id AS grupo_aulas_id,
             g.id   AS grupo_id,   g.denominacion  AS grupo,
             ar.id  AS area_id,    ar.denominacion AS area,
             t.id   AS turno_id,   t.denominacion  AS turno,
             s.id   AS sede_id,    s.denominacion  AS sede
      FROM grupo_aulas ga
      JOIN grupos g ON g.id = ga.grupos_id
      JOIN areas ar ON ar.id = ga.areas_id
      JOIN turnos t ON t.id = ga.turnos_id
      JOIN aulas au ON au.id = ga.aulas_id
      JOIN locales l ON l.id = au.locales_id
      JOIN sedes s ON s.id = l.sedes_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.denominacion, t.denominacion, ar.denominacion, g.denominacion
    `, params);
    conn.release();
    res.json(rows);
  } catch (e) { if (conn) conn.release(); console.error('Error catálogo stats:', e); res.status(500).json({ error: 'Error al obtener el catálogo' }); }
});

app.get('/api/stats/catalogos/coordinadores', requireAdmin, cacheMiddleware(600), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`
      SELECT u.id,
             CONCAT_WS(' ', u.paterno, u.materno, u.name) AS nombre,
             (SELECT GROUP_CONCAT(DISTINCT cg.grupos_id)
                FROM coordinador_grupos cg
               WHERE cg.coordinador_id = u.id) AS grupos_csv
      FROM users u
      WHERE u.id IN (SELECT DISTINCT coordinador_id FROM coordinador_grupos)
        AND u.estado = '1'
      ORDER BY u.paterno, u.materno, u.name
    `);
    conn.release();
    res.json(rows.map(r => ({
      id: r.id,
      nombre: r.nombre,
      grupos: r.grupos_csv ? r.grupos_csv.split(',').map(Number) : []
    })));
  } catch (e) { if (conn) conn.release(); console.error('Error catálogo stats:', e); res.status(500).json({ error: 'Error al obtener el catálogo' }); }
});

app.get('/api/stats/catalogos/auxiliares', requireAdmin, cacheMiddleware(600), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`
      SELECT u.id,
             CONCAT_WS(' ', u.paterno, u.materno, u.name) AS nombre,
             (SELECT GROUP_CONCAT(ag.grupo_aulas_id)
                FROM auxiliares a2
                JOIN auxiliar_grupos ag ON ag.auxiliares_id = a2.id
               WHERE a2.users_id = u.id) AS grupos_csv
      FROM users u
      JOIN auxiliares a ON a.users_id = u.id
      WHERE u.estado = '1'
      ORDER BY u.paterno, u.materno, u.name
    `);
    conn.release();
    // Convertir grupos_csv (string) → array de números para usar como mapa en frontend.
    res.json(rows.map(r => ({
      id: r.id,
      nombre: r.nombre,
      grupos: r.grupos_csv ? r.grupos_csv.split(',').map(Number) : []
    })));
  } catch (e) { if (conn) conn.release(); console.error('Error catálogo stats:', e); res.status(500).json({ error: 'Error al obtener el catálogo' }); }
});

// Construye el SQL + params del reporte de horas-docentes a partir de los
// filtros de la request. Devuelve { sql, params, filtros } o { blocked: true }
// si el rol no tiene grupos asignados. Lanza Error si faltan desde/hasta.
function buildHorasDocentesQuery(req) {
  const { desde, hasta, tipo_carga } = req.query;
  if (!desde || !hasta) {
    const err = new Error('Parámetros desde/hasta son requeridos');
    err.statusCode = 400;
    throw err;
  }

  const sedes = parseList(req.query.sedes);
  const turnos = parseList(req.query.turnos);
  const areas = parseList(req.query.areas);
  const grupos = parseList(req.query.grupos);
  const coordinadores = parseList(req.query.coordinadores);
  const auxiliares = parseList(req.query.auxiliares);

  const conditions = ['a.fecha BETWEEN ? AND ?'];
  const params = [desde, hasta];

  // Restricción por rol — mismo patrón que /api/stats/reporte-pagos
  const allowedGrupos = req.user.grupos;
  if (Array.isArray(allowedGrupos)) {
    if (allowedGrupos.length === 0) return { blocked: true };
    conditions.push(`ga.id IN (${allowedGrupos.map(() => '?').join(',')})`);
    params.push(...allowedGrupos);
  }

  const inFilter = (arr, col) => {
    if (arr.length === 0) return;
    conditions.push(`${col} IN (${arr.map(() => '?').join(',')})`);
    params.push(...arr);
  };
  inFilter(sedes, 's.id');
  inFilter(turnos, 't.id');
  inFilter(areas, 'ar_grupo.id');
  inFilter(grupos, 'ga.id');
  inFilter(coordinadores, 'u_coord.id');
  inFilter(auxiliares, 'u_aux.id');
  if (tipo_carga === '1' || tipo_carga === '2') {
    conditions.push('ca.tipo = ?');
    params.push(tipo_carga);
  }

  const sql = `
    SELECT
      u_coord.id AS coordinador_id,
      CONCAT_WS(' ', u_coord.paterno, u_coord.materno, u_coord.name) AS coordinador,
      u_aux.id   AS auxiliar_id,
      CONCAT_WS(' ', u_aux.paterno, u_aux.materno, u_aux.name) AS auxiliar,
      s.id AS sede_id,     s.denominacion AS sede,
      t.id AS turno_id,    t.denominacion AS turno,
      ar_grupo.id AS area_id, ar_grupo.denominacion AS area,
      g.id AS grupo_id,    g.denominacion AS grupo,
      ga.id AS grupo_aulas_id,
      SUM(a.horas_pago) AS total_horas_pago,
      SUM(a.cantidad_horas) AS total_horas_dictadas,
      COUNT(DISTINCT a.docentes_id) AS docentes_distintos,
      COUNT(*) AS asistencias
    FROM asistencia_docentes a
    JOIN carga_academicas ca ON a.carga_academicas_id = ca.id
    JOIN grupo_aulas ga ON ca.grupo_aulas_id = ga.id
    JOIN grupos    g        ON ga.grupos_id = g.id
    JOIN areas     ar_grupo ON ga.areas_id  = ar_grupo.id
    JOIN turnos    t        ON ga.turnos_id = t.id
    JOIN aulas     au       ON ga.aulas_id  = au.id
    JOIN locales   l        ON au.locales_id = l.id
    JOIN sedes     s        ON l.sedes_id   = s.id
    LEFT JOIN coordinador_grupos cg ON ga.id = cg.grupos_id
    LEFT JOIN users          u_coord ON cg.coordinador_id = u_coord.id
    LEFT JOIN auxiliar_grupos ag    ON ga.id = ag.grupo_aulas_id
    LEFT JOIN auxiliares     aux    ON ag.auxiliares_id = aux.id
    LEFT JOIN users          u_aux  ON aux.users_id = u_aux.id
    WHERE ${conditions.join(' AND ')}
    GROUP BY
      u_coord.id, u_aux.id, s.id, t.id, ar_grupo.id, g.id, ga.id
    ORDER BY coordinador, auxiliar, sede, turno, area, grupo
  `;

  return {
    sql, params,
    filtros: { desde, hasta, sedes, turnos, areas, grupos, coordinadores, auxiliares, tipo_carga: tipo_carga || null }
  };
}

// Reporte 1 — Horas pago por docentes (solo admin)
app.get('/api/stats/reportes-aux/horas-docentes', requireAdmin, async (req, res) => {
  let conn;
  try {
    const q = buildHorasDocentesQuery(req);
    if (q.blocked) return res.json({ filas: [], totales: { horas_pago: 0, horas_dictadas: 0, registros: 0 } });

    conn = await pool.getConnection();
    const [rows] = await conn.query(q.sql, q.params);
    conn.release();

    const totales = rows.reduce((acc, r) => {
      acc.horas_pago += Number(r.total_horas_pago || 0);
      acc.horas_dictadas += Number(r.total_horas_dictadas || 0);
      return acc;
    }, { horas_pago: 0, horas_dictadas: 0, registros: rows.length });

    res.json({ filas: rows, totales, filtros_aplicados: q.filtros });
  } catch (e) {
    if (conn) conn.release();
    console.error('Error horas-docentes:', e);
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Error al generar el reporte' });
  }
});

// Reporte 1 — descarga Excel con los filtros aplicados (solo admin)
app.get('/api/stats/reportes-aux/horas-docentes/excel', requireAdmin, async (req, res) => {
  let conn;
  try {
    const q = buildHorasDocentesQuery(req);
    const rows = q.blocked ? [] : await (async () => {
      conn = await pool.getConnection();
      const [r] = await conn.query(q.sql, q.params);
      conn.release();
      return r;
    })();

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CEPREUNA Stats';
    const ws = wb.addWorksheet('Horas docentes');

    // Título + rango
    ws.mergeCells('A1:I1');
    ws.getCell('A1').value = 'Reporte de Horas Pago por Docentes';
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
    ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 24;

    ws.mergeCells('A2:I2');
    ws.getCell('A2').value = `Periodo: ${q.filtros ? q.filtros.desde + ' a ' + q.filtros.hasta : ''}`;
    ws.getCell('A2').font = { italic: true, size: 10, color: { argb: 'FF666666' } };
    ws.getCell('A2').alignment = { horizontal: 'center' };

    // Cabeceras (fila 4)
    const headers = ['Coordinador', 'Auxiliar', 'Sede', 'Turno', 'Área', 'Grupo', 'Asistencias', 'H. dictadas', 'H. pago'];
    const headerRow = ws.getRow(4);
    headerRow.values = headers;
    headerRow.eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    // Datos (desde fila 5)
    let totHoras = 0, totDictadas = 0;
    rows.forEach((r, i) => {
      const row = ws.getRow(5 + i);
      row.values = [
        r.coordinador || '— sin coordinador —',
        r.auxiliar || '— sin auxiliar —',
        r.sede || '', r.turno || '', r.area || '', r.grupo || '',
        Number(r.asistencias) || 0,
        Number(r.total_horas_dictadas) || 0,
        Number(r.total_horas_pago) || 0,
      ];
      totHoras += Number(r.total_horas_pago) || 0;
      totDictadas += Number(r.total_horas_dictadas) || 0;
    });

    // Fila de totales
    const totalRow = ws.getRow(5 + rows.length);
    totalRow.getCell(6).value = 'TOTAL';
    totalRow.getCell(8).value = totDictadas;
    totalRow.getCell(9).value = totHoras;
    totalRow.eachCell((cell) => { cell.font = { bold: true }; });

    // Ancho de columnas
    const widths = [34, 34, 16, 12, 16, 14, 12, 12, 12];
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    const buffer = await wb.xlsx.writeBuffer();
    const fname = `horas-docentes_${q.filtros.desde}_a_${q.filtros.hasta}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(buffer));
  } catch (e) {
    if (conn) conn.release();
    console.error('Error horas-docentes excel:', e);
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Error al generar el Excel' });
  }
});

// Obtiene grupos filtrados + sus asistencias en el rango. Reutilizado por
// el endpoint JSON y el de Excel. Devuelve { grupos, asistencias, desde, hasta, filtros }.
async function fetchCoberturaData(req) {
  const { desde, hasta } = req.query;
  if (!desde || !hasta) {
    const err = new Error('Parámetros desde/hasta son requeridos');
    err.statusCode = 400;
    throw err;
  }

  const sedes = parseList(req.query.sedes);
  const turnos = parseList(req.query.turnos);
  const areas = parseList(req.query.areas);
  const grupos = parseList(req.query.grupos);
  const auxiliares = parseList(req.query.auxiliares);
  const filtros = { sedes, turnos, areas, grupos, auxiliares };

  const conditions = ['ga.periodos_id = 1'];
  const params = [];

  const allowedGrupos = req.user.grupos;
  if (Array.isArray(allowedGrupos)) {
    if (allowedGrupos.length === 0) return { grupos: [], asistencias: [], desde, hasta, filtros };
    conditions.push(`ga.id IN (${allowedGrupos.map(() => '?').join(',')})`);
    params.push(...allowedGrupos);
  }
  const inFilter = (arr, col) => {
    if (arr.length === 0) return;
    conditions.push(`${col} IN (${arr.map(() => '?').join(',')})`);
    params.push(...arr);
  };
  inFilter(sedes, 's.id');
  inFilter(turnos, 't.id');
  inFilter(areas, 'ar.id');
  inFilter(grupos, 'ga.id');
  if (auxiliares.length > 0) {
    conditions.push(`ga.id IN (
      SELECT ag2.grupo_aulas_id FROM auxiliar_grupos ag2
      JOIN auxiliares a2 ON a2.id = ag2.auxiliares_id
      WHERE a2.users_id IN (${auxiliares.map(() => '?').join(',')})
    )`);
    params.push(...auxiliares);
  }

  const conn = await pool.getConnection();
  try {
    const [gruposRows] = await conn.query(`
      SELECT
        ga.id AS grupo_aulas_id,
        g.denominacion AS grupo,
        ar.denominacion AS area, ar.id AS area_id,
        t.denominacion AS turno, t.id AS turno_id,
        s.denominacion AS sede, s.id AS sede_id,
        (SELECT GROUP_CONCAT(DISTINCT CONCAT_WS(' ', u.paterno, u.materno, u.name) ORDER BY u.paterno SEPARATOR ', ')
           FROM auxiliar_grupos ag2
           JOIN auxiliares a2 ON a2.id = ag2.auxiliares_id
           JOIN users u ON u.id = a2.users_id
          WHERE ag2.grupo_aulas_id = ga.id) AS auxiliares_asignados,
        -- Coordinador(es): coordinador_grupos.grupos_id apunta a grupo_aulas.id (nombre engañoso)
        (SELECT GROUP_CONCAT(DISTINCT CONCAT_WS(' ', u.paterno, u.materno, u.name) ORDER BY u.paterno SEPARATOR ', ')
           FROM coordinador_grupos cg
           JOIN users u ON u.id = cg.coordinador_id
          WHERE cg.grupos_id = ga.id) AS coordinadores_asignados
      FROM grupo_aulas ga
      JOIN grupos g ON g.id = ga.grupos_id
      JOIN areas ar ON ar.id = ga.areas_id
      JOIN turnos t ON t.id = ga.turnos_id
      JOIN aulas au ON au.id = ga.aulas_id
      JOIN locales l ON l.id = au.locales_id
      JOIN sedes s ON s.id = l.sedes_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.denominacion, t.denominacion, ar.denominacion, g.denominacion
    `, params);

    if (gruposRows.length === 0) return { grupos: [], asistencias: [], desde, hasta, filtros };

    const ids = gruposRows.map(g => g.grupo_aulas_id);
    const [asistRows] = await conn.query(`
      SELECT
        ae.grupo_aulas_id,
        DATE_FORMAT(ae.fecha, '%Y-%m-%d') AS fecha,
        GROUP_CONCAT(DISTINCT CONCAT_WS(' ', u.paterno, u.materno, u.name) ORDER BY u.paterno SEPARATOR ', ') AS tomada_por
      FROM asistencia_estudiantes ae
      JOIN users u ON u.id = ae.users_id
      WHERE ae.fecha BETWEEN ? AND ?
        AND ae.grupo_aulas_id IN (${ids.map(() => '?').join(',')})
      GROUP BY ae.grupo_aulas_id, ae.fecha
    `, [desde, hasta, ...ids]);

    return { grupos: gruposRows, asistencias: asistRows, desde, hasta, filtros };
  } finally {
    conn.release();
  }
}

// Reporte 2 — Cobertura de asistencia por grupos (JSON)
// El frontend pivota a vista semanal (DAYOFWEEK) o dinámica (1 col por fecha).
app.get('/api/stats/reportes-aux/cobertura-grupos', requireAdmin, async (req, res) => {
  try {
    const data = await fetchCoberturaData(req);
    res.json(data);
  } catch (e) {
    console.error('Error cobertura-grupos:', e);
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Error al generar el reporte' });
  }
});

// Rango de fechas disponible (min/max de asistencias del ciclo) — para el botón "Todo el ciclo"
app.get('/api/stats/reportes-aux/rango-fechas', requireAdmin, cacheMiddleware(600), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`
      SELECT DATE_FORMAT(MIN(fecha), '%Y-%m-%d') AS min_fecha,
             DATE_FORMAT(MAX(fecha), '%Y-%m-%d') AS max_fecha
      FROM asistencia_estudiantes
    `);
    conn.release();
    res.json(rows[0] || { min_fecha: null, max_fecha: null });
  } catch (e) {
    if (conn) conn.release();
    console.error('Error rango-fechas:', e);
    res.status(500).json({ error: 'Error al obtener el rango de fechas' });
  }
});

// Reporte 2 — descarga Excel.
//   vista = 'dinamica' → 1 hoja con una columna por fecha hábil del rango.
//   vista = 'semanal'  → UNA HOJA POR SEMANA (Lun-Vie), para no colapsar
//                        varias semanas en una sola matriz.
app.get('/api/stats/reportes-aux/cobertura-grupos/excel', requireAdmin, async (req, res) => {
  try {
    const vista = req.query.vista === 'semanal' ? 'semanal' : 'dinamica';
    const { grupos, asistencias, desde, hasta } = await fetchCoberturaData(req);

    // Index de asistencias por grupo|fecha
    const idx = new Map();
    for (const a of asistencias) idx.set(`${a.grupo_aulas_id}|${a.fecha}`, a.tomada_por);

    // Fechas hábiles (Lun-Vie) del rango
    const fechas = [];
    {
      const d = new Date(desde + 'T00:00:00');
      const end = new Date(hasta + 'T00:00:00');
      while (d <= end) {
        const dow = d.getDay(); // 0=Dom..6=Sab
        if (dow >= 1 && dow <= 5) fechas.push({ iso: d.toISOString().slice(0, 10), dow });
        d.setDate(d.getDate() + 1);
      }
    }
    const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const COLOR_SI = 'FF66BB6A', COLOR_NO = 'FFEF5350';

    // Devuelve el lunes (ISO) de la semana de una fecha ISO.
    const lunesDe = (iso) => {
      const d = new Date(iso + 'T00:00:00');
      const dow = d.getDay();
      const diff = dow === 0 ? -6 : 1 - dow;
      d.setDate(d.getDate() + diff);
      return d.toISOString().slice(0, 10);
    };

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CEPREUNA Stats';

    const DOW_DIAS = [1, 2, 3, 4, 5]; // Lun..Vie

    const aux = (g) => g.auxiliares_asignados || '— sin asignar —';
    const coord = (g) => g.coordinadores_asignados || '— sin asignar —';

    if (vista === 'semanal') {
      // ===== Una sola hoja plana: una fila por (grupo × semana) =====
      // Columnas: Nro | Grupo | Área | Turno | Sede | Auxiliar | Coordinador
      //           | Lun | Mar | Mié | Jue | Vie | Total % | Semana
      const ws = wb.addWorksheet('Cobertura semanal');
      const headers = ['Nro', 'Grupo', 'Área', 'Turno', 'Sede', 'Auxiliar', 'Coordinador',
        'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Total %', 'Semana'];
      const lastCol = headers.length;

      ws.mergeCells(1, 1, 1, lastCol);
      ws.getCell(1, 1).value = 'Cobertura de asistencia por grupos (semanal)';
      ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
      ws.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
      ws.getCell(1, 1).alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getRow(1).height = 24;
      ws.mergeCells(2, 1, 2, lastCol);
      ws.getCell(2, 1).value = `Periodo: ${desde} a ${hasta}`;
      ws.getCell(2, 1).font = { italic: true, size: 10, color: { argb: 'FF666666' } };
      ws.getCell(2, 1).alignment = { horizontal: 'center' };

      const headerRow = ws.getRow(4);
      headerRow.values = headers;
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, size: 9 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });

      // Agrupar fechas por semana (lunes)
      const semanas = new Map(); // lunesISO -> { dow -> fechaISO }
      for (const f of fechas) {
        const k = lunesDe(f.iso);
        if (!semanas.has(k)) semanas.set(k, {});
        semanas.get(k)[f.dow] = f.iso;
      }
      const lunesOrdenados = [...semanas.keys()].sort();

      let r = 5, nro = 1;
      lunesOrdenados.forEach((lun, si) => {
        const diasSemana = semanas.get(lun); // { dow: fechaISO }
        grupos.forEach((g) => {
          let tomados = 0, evaluables = 0;
          const estados = DOW_DIAS.map((dow) => {
            const fechaISO = diasSemana[dow];
            if (!fechaISO) return null; // ese día no cae en el rango
            evaluables++;
            const tomado = idx.has(`${g.grupo_aulas_id}|${fechaISO}`);
            if (tomado) tomados++;
            return tomado;
          });
          const pct = evaluables ? Math.round(100 * tomados / evaluables) : 0;
          const row = ws.getRow(r);
          row.values = [
            nro, g.grupo, g.area, g.turno, g.sede, aux(g), coord(g),
            ...estados.map(e => e === null ? '—' : (e ? 'SI' : 'NO')),
            pct + '%', `Semana ${si + 1}`
          ];
          // Colorear Lun-Vie (columnas 8..12)
          estados.forEach((e, i) => {
            const cell = row.getCell(8 + i);
            cell.alignment = { horizontal: 'center' };
            if (e === null) { cell.font = { color: { argb: 'FF999999' } }; return; }
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: e ? COLOR_SI : COLOR_NO } };
            cell.font = { bold: true, size: 9, color: { argb: e ? 'FF0A3D10' : 'FF4A0000' } };
          });
          r++; nro++;
        });
      });

      const widths = [6, 14, 14, 10, 12, 26, 26, 7, 7, 7, 7, 7, 10, 12];
      widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
      // Congelar cabecera + columnas de identificación
      ws.views = [{ state: 'frozen', xSplit: 7, ySplit: 4 }];
    } else {
      // ===== Vista por fecha (dinámica): 1 hoja, 1 columna por fecha hábil =====
      const ws = wb.addWorksheet('Detalle por fecha');
      const fechaCols = fechas.map(f => ({ label: f.iso.slice(5) + ' ' + DOW[f.dow], fecha: f.iso }));
      const headers = ['Nro', 'Grupo', 'Área', 'Turno', 'Sede', 'Auxiliar', 'Coordinador',
        ...fechaCols.map(c => c.label), 'Tomados', 'Faltantes', 'Total %'];
      const lastCol = headers.length;

      ws.mergeCells(1, 1, 1, lastCol);
      ws.getCell(1, 1).value = 'Cobertura de asistencia por grupos (detalle por fecha)';
      ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
      ws.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
      ws.getCell(1, 1).alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getRow(1).height = 24;
      ws.mergeCells(2, 1, 2, lastCol);
      ws.getCell(2, 1).value = `Periodo: ${desde} a ${hasta}`;
      ws.getCell(2, 1).font = { italic: true, size: 10, color: { argb: 'FF666666' } };
      ws.getCell(2, 1).alignment = { horizontal: 'center' };

      const headerRow = ws.getRow(4);
      headerRow.values = headers;
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, size: 9 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });

      grupos.forEach((g, ri) => {
        const row = ws.getRow(5 + ri);
        let si = 0;
        const estados = fechaCols.map(c => {
          const tomado = idx.has(`${g.grupo_aulas_id}|${c.fecha}`);
          if (tomado) si++;
          return tomado;
        });
        const total = fechaCols.length;
        const pct = total ? Math.round(100 * si / total) : 0;
        row.values = [
          ri + 1, g.grupo, g.area, g.turno, g.sede, aux(g), coord(g),
          ...estados.map(e => e ? 'SI' : 'NO'), si, total - si, pct + '%'
        ];
        estados.forEach((e, i) => {
          const cell = row.getCell(8 + i);
          cell.alignment = { horizontal: 'center' };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: e ? COLOR_SI : COLOR_NO } };
          cell.font = { bold: true, size: 9, color: { argb: e ? 'FF0A3D10' : 'FF4A0000' } };
        });
      });

      ws.getColumn(1).width = 6; ws.getColumn(2).width = 14; ws.getColumn(3).width = 14;
      ws.getColumn(4).width = 10; ws.getColumn(5).width = 12; ws.getColumn(6).width = 26; ws.getColumn(7).width = 26;
      for (let i = 0; i < fechaCols.length; i++) ws.getColumn(8 + i).width = 11;
      ws.getColumn(8 + fechaCols.length).width = 10;
      ws.getColumn(9 + fechaCols.length).width = 10;
      ws.getColumn(10 + fechaCols.length).width = 10;
      ws.views = [{ state: 'frozen', xSplit: 7, ySplit: 4 }];
    }

    const buffer = await wb.xlsx.writeBuffer();
    const fname = `cobertura-grupos_${vista}_${desde}_a_${hasta}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(buffer));
  } catch (e) {
    console.error('Error cobertura excel:', e);
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Error al generar el Excel' });
  }
});

// ============ REPORTE 3 — Tardanzas y faltas docentes ============
// Resumen por docente (tardanzas/faltas + descuento por modalidad) y detalle
// por fecha (con sede, curso, grupo, coordinador, auxiliar). modalidad de la
// sede: '1' = virtual, '2' = presencial. Descuento: cada 3 tardanzas = 1 hora,
// calculado por modalidad de forma independiente.

// Construye filtros opcionales (sedes/turnos/areas) sobre la cadena de joins.
// Semana del ciclo: inicio 23/03/2026 = semana 1, 16 semanas (lun-vie).
const CICLO_SEMANA_INICIO = '2026-03-23';
const CICLO_SEMANAS = 16;
function semanaCiclo(fechaYmd) {
  if (!fechaYmd) return null;
  const inicio = new Date(CICLO_SEMANA_INICIO + 'T00:00:00');
  const d = new Date(String(fechaYmd).slice(0, 10) + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return Math.floor((d - inicio) / (7 * 86400000)) + 1;
}
function semanaRangoLabel(desde, hasta) {
  const clamp = (n) => n == null ? null : Math.max(1, Math.min(CICLO_SEMANAS, n));
  const a = clamp(semanaCiclo(desde)), b = clamp(semanaCiclo(hasta));
  if (a == null || b == null) return null;
  return a === b ? `Semana ${a}` : `Semanas ${a}–${b}`;
}
// Expresión SQL para la semana del ciclo de una fecha (clamp 1..16).
const SQL_SEMANA = `GREATEST(1, LEAST(${CICLO_SEMANAS}, FLOOR(DATEDIFF(ad.fecha, '${CICLO_SEMANA_INICIO}') / 7) + 1))`;

function tardanzasFiltros(req) {
  const sedes = parseList(req.query.sedes);
  const turnos = parseList(req.query.turnos);
  const areas = parseList(req.query.areas);
  const where = [];
  const params = [];
  const addIn = (arr, col) => { if (arr.length) { where.push(`${col} IN (${arr.map(() => '?').join(',')})`); params.push(...arr); } };
  addIn(sedes, 's.id');
  addIn(turnos, 'ga.turnos_id');
  addIn(areas, 'ga.areas_id');
  return { whereStr: where.length ? 'AND ' + where.join(' AND ') : '', params, filtros: { sedes, turnos, areas } };
}

async function fetchTardanzasResumen(req) {
  const { desde, hasta } = req.query;
  if (!desde || !hasta) { const e = new Error('Parámetros desde/hasta son requeridos'); e.statusCode = 400; throw e; }
  const f = tardanzasFiltros(req);
  const conn = await pool.getConnection();
  try {
    const [filas] = await conn.query(`
      SELECT d.id AS docente_id, d.nro_documento AS dni,
             CONCAT_WS(' ', d.paterno, d.materno, d.nombres) AS docente,
             COUNT(*) AS sesiones_totales,
             SUM(ad.estado='1') AS presentes,
             SUM(ad.estado='2') AS tardanzas_total,
             SUM(ad.estado='3') AS faltas,
             SUM(ad.estado='2' AND s.modalidad='2') AS tardanzas_presencial,
             SUM(ad.estado='2' AND s.modalidad='1') AS tardanzas_virtual,
             FLOOR(SUM(ad.estado='2' AND s.modalidad='2') / 3) AS hrs_desc_presencial,
             MOD(  SUM(ad.estado='2' AND s.modalidad='2'), 3) AS tard_pend_presencial,
             FLOOR(SUM(ad.estado='2' AND s.modalidad='1') / 3) AS hrs_desc_virtual,
             MOD(  SUM(ad.estado='2' AND s.modalidad='1'), 3) AS tard_pend_virtual,
             FLOOR(SUM(ad.estado='2' AND s.modalidad='2')/3) + FLOOR(SUM(ad.estado='2' AND s.modalidad='1')/3) AS horas_descuento_total,
             ROUND(SUM(CASE WHEN s.modalidad='2' THEN ad.horas_pago ELSE 0 END), 2) AS horas_pago_presencial,
             ROUND(SUM(CASE WHEN s.modalidad='1' THEN ad.horas_pago ELSE 0 END), 2) AS horas_pago_virtual
      FROM asistencia_docentes ad
      JOIN docentes d  ON d.id  = ad.docentes_id
      JOIN carga_academicas ca ON ca.id = ad.carga_academicas_id
      JOIN grupo_aulas ga ON ga.id = ca.grupo_aulas_id
      JOIN aulas au ON au.id = ga.aulas_id
      JOIN locales l  ON l.id  = au.locales_id
      JOIN sedes s  ON s.id  = l.sedes_id
      WHERE ad.fecha BETWEEN ? AND ? ${f.whereStr}
      GROUP BY d.id, d.nro_documento, d.paterno, d.materno, d.nombres
      HAVING tardanzas_total > 0
      ORDER BY tardanzas_total DESC, docente
    `, [desde, hasta, ...f.params]);
    return {
      filas, desde, hasta, filtros: f.filtros,
      semana_desde: semanaCiclo(desde), semana_hasta: semanaCiclo(hasta),
      semana_label: semanaRangoLabel(desde, hasta)
    };
  } finally {
    conn.release();
  }
}

app.get('/api/stats/reportes-aux/tardanzas', requireAdmin, cacheMiddleware(120), async (req, res) => {
  try {
    res.json(await fetchTardanzasResumen(req));
  } catch (e) {
    console.error('Error tardanzas resumen:', e);
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Error al generar el reporte' });
  }
});

// Detalle por fecha de un docente (modal).
app.get('/api/stats/reportes-aux/tardanzas/detalle', requireAdmin, cacheMiddleware(120), async (req, res) => {
  const docenteId = Number(req.query.docente_id);
  const { desde, hasta } = req.query;
  if (!Number.isFinite(docenteId) || docenteId <= 0) return res.status(400).json({ error: 'docente_id inválido' });
  if (!desde || !hasta) return res.status(400).json({ error: 'desde/hasta requeridos' });
  let conn;
  try {
    conn = await pool.getConnection();
    const [filas] = await conn.query(`
      SELECT DATE_FORMAT(ad.fecha,'%Y-%m-%d') AS fecha,
             ${SQL_SEMANA} AS semana,
             s.denominacion AS sede,
             CASE s.modalidad WHEN '1' THEN 'virtual' WHEN '2' THEN 'presencial' END AS modalidad,
             ar.denominacion AS area, t.denominacion AS turno,
             g.denominacion AS grupo, c.denominacion AS curso,
             CASE ad.estado WHEN '2' THEN 'tarde' WHEN '3' THEN 'falta' END AS estado,
             CONCAT(TIME_FORMAT(ad.hora_inicio,'%H:%i'),' - ',TIME_FORMAT(ad.hora_fin,'%H:%i')) AS horario,
             ad.horas_pago,
             (SELECT GROUP_CONCAT(DISTINCT CONCAT_WS(' ', uc.paterno, uc.materno, uc.name) SEPARATOR ', ')
                FROM coordinador_grupos cg JOIN users uc ON uc.id = cg.coordinador_id
               WHERE cg.grupos_id = ga.id) AS coordinador,
             (SELECT GROUP_CONCAT(DISTINCT CONCAT_WS(' ', ua.paterno, ua.materno, ua.name) SEPARATOR ', ')
                FROM auxiliar_grupos agx JOIN auxiliares aux ON aux.id = agx.auxiliares_id
                JOIN users ua ON ua.id = aux.users_id WHERE agx.grupo_aulas_id = ga.id) AS auxiliar,
             ad.observacion
      FROM asistencia_docentes ad
      JOIN carga_academicas ca ON ca.id = ad.carga_academicas_id
      JOIN cursos c  ON c.id  = ca.cursos_id
      JOIN grupo_aulas ga ON ga.id = ca.grupo_aulas_id
      JOIN grupos g  ON g.id  = ga.grupos_id
      JOIN areas ar  ON ar.id = ga.areas_id
      JOIN turnos t  ON t.id  = ga.turnos_id
      JOIN aulas au  ON au.id = ga.aulas_id
      JOIN locales l ON l.id  = au.locales_id
      JOIN sedes s   ON s.id  = l.sedes_id
      WHERE ad.docentes_id = ? AND ad.estado IN ('2','3') AND ad.fecha BETWEEN ? AND ?
      ORDER BY ad.fecha, ad.hora_inicio
    `, [docenteId, desde, hasta]);
    conn.release();
    res.json({ filas });
  } catch (e) {
    if (conn) conn.release();
    console.error('Error tardanzas detalle:', e);
    res.status(500).json({ error: 'Error al obtener el detalle' });
  }
});

// Excel del resumen de tardanzas.
app.get('/api/stats/reportes-aux/tardanzas/excel', requireAdmin, async (req, res) => {
  let conn;
  try {
    const { filas, desde, hasta, semana_label } = await fetchTardanzasResumen(req);
    const semTxt = semana_label ? ` · ${semana_label}` : '';

    // Detalle (todas las tardanzas/faltas del rango con sus filtros) para la 2da hoja.
    const f = tardanzasFiltros(req);
    conn = await pool.getConnection();
    const [detalle] = await conn.query(`
      SELECT CONCAT_WS(' ', d.paterno, d.materno, d.nombres) AS docente, d.nro_documento AS dni,
             DATE_FORMAT(ad.fecha,'%d/%m/%Y') AS fecha,
             ${SQL_SEMANA} AS semana,
             CASE ad.estado WHEN '2' THEN 'tarde' WHEN '3' THEN 'falta' END AS estado,
             CASE s.modalidad WHEN '1' THEN 'virtual' WHEN '2' THEN 'presencial' END AS modalidad,
             s.denominacion AS sede, ar.denominacion AS area, t.denominacion AS turno,
             g.denominacion AS grupo, c.denominacion AS curso,
             CONCAT(TIME_FORMAT(ad.hora_inicio,'%H:%i'),' - ',TIME_FORMAT(ad.hora_fin,'%H:%i')) AS horario,
             ad.horas_pago,
             (SELECT GROUP_CONCAT(DISTINCT CONCAT_WS(' ', uc.paterno, uc.materno, uc.name) SEPARATOR ', ')
                FROM coordinador_grupos cg JOIN users uc ON uc.id = cg.coordinador_id
               WHERE cg.grupos_id = ga.id) AS coordinador,
             (SELECT GROUP_CONCAT(DISTINCT CONCAT_WS(' ', ua.paterno, ua.materno, ua.name) SEPARATOR ', ')
                FROM auxiliar_grupos agx JOIN auxiliares aux ON aux.id = agx.auxiliares_id
                JOIN users ua ON ua.id = aux.users_id WHERE agx.grupo_aulas_id = ga.id) AS auxiliar,
             ad.observacion
      FROM asistencia_docentes ad
      JOIN docentes d ON d.id = ad.docentes_id
      JOIN carga_academicas ca ON ca.id = ad.carga_academicas_id
      JOIN cursos c  ON c.id  = ca.cursos_id
      JOIN grupo_aulas ga ON ga.id = ca.grupo_aulas_id
      JOIN grupos g  ON g.id  = ga.grupos_id
      JOIN areas ar  ON ar.id = ga.areas_id
      JOIN turnos t  ON t.id  = ga.turnos_id
      JOIN aulas au  ON au.id = ga.aulas_id
      JOIN locales l ON l.id  = au.locales_id
      JOIN sedes s   ON s.id  = l.sedes_id
      WHERE ad.estado IN ('2','3') AND ad.fecha BETWEEN ? AND ? ${f.whereStr}
      ORDER BY docente, ad.fecha, ad.hora_inicio
    `, [desde, hasta, ...f.params]);
    conn.release(); conn = null;

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CEPREUNA Stats';
    const thin = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    const titulo = (ws, txt, lastCol) => {
      ws.mergeCells(1, 1, 1, lastCol);
      ws.getCell(1, 1).value = txt;
      ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
      ws.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
      ws.getCell(1, 1).alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getRow(1).height = 22;
    };
    const headerRow = (ws, headers) => {
      const hr = ws.getRow(3); hr.values = headers;
      hr.eachCell(c => { c.font = { bold: true, size: 9 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } }; c.alignment = { horizontal: 'center', wrapText: true }; c.border = thin; });
    };

    // ===== Hoja 1: Resumen =====
    const ws = wb.addWorksheet('Resumen');
    const headers = ['#', 'DNI', 'Docente', 'Sesiones', 'Presentes', 'Tardanzas', 'Faltas',
      'Tard. presencial', 'Tard. virtual', 'Hrs desc. presencial', 'Hrs desc. virtual',
      'Horas descuento', 'Horas pago presencial', 'Horas pago virtual'];
    titulo(ws, `Tardanzas y faltas docentes (resumen) · ${desde} a ${hasta}${semTxt}`, headers.length);
    headerRow(ws, headers);
    filas.forEach((r, i) => {
      const row = ws.getRow(4 + i);
      row.values = [i + 1, r.dni, r.docente, Number(r.sesiones_totales), Number(r.presentes), Number(r.tardanzas_total), Number(r.faltas),
        Number(r.tardanzas_presencial), Number(r.tardanzas_virtual), Number(r.hrs_desc_presencial), Number(r.hrs_desc_virtual),
        Number(r.horas_descuento_total), Number(r.horas_pago_presencial), Number(r.horas_pago_virtual)];
      row.eachCell(c => { c.font = { size: 9 }; c.border = thin; });
    });
    ws.columns = headers.map((h, i) => ({ width: i === 2 ? 30 : i === 1 ? 11 : 13 }));
    ws.views = [{ state: 'frozen', ySplit: 3 }];

    // ===== Hoja 2: Detalle =====
    const wd = wb.addWorksheet('Detalle');
    const dh = ['#', 'DNI', 'Docente', 'Fecha', 'Semana', 'Estado', 'Modalidad', 'Sede', 'Área', 'Turno', 'Grupo', 'Curso', 'Horario', 'Horas pago', 'Coordinador', 'Auxiliar', 'Observación'];
    titulo(wd, `Detalle de tardanzas y faltas por fecha · ${desde} a ${hasta}${semTxt}`, dh.length);
    headerRow(wd, dh);
    detalle.forEach((r, i) => {
      const row = wd.getRow(4 + i);
      row.values = [i + 1, r.dni, r.docente, r.fecha, `Sem ${r.semana}`, r.estado, r.modalidad, r.sede, r.area, r.turno, r.grupo, r.curso, r.horario,
        Number(r.horas_pago || 0), r.coordinador || '', r.auxiliar || '', r.observacion || ''];
      row.eachCell(c => { c.font = { size: 9 }; c.border = thin; });
    });
    wd.columns = dh.map((h, i) => ({ width: [4, 11, 28, 11, 8, 8, 11, 16, 14, 10, 12, 22, 14, 11, 26, 26, 30][i] || 12 }));
    wd.views = [{ state: 'frozen', ySplit: 3, xSplit: 3 }];

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="tardanzas-docentes_${desde}_a_${hasta}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    if (conn) conn.release();
    console.error('Error tardanzas excel:', e);
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'Error al generar el Excel' });
  }
});

// ============ HABILITADOS (con restricción por rol/grupos) ============
// Versión protegida de los reportes de matrículas/habilitados para el panel de
// stats: admin ve todos; coordinador/auxiliar solo sus grupos (req.user.grupos).
// Reusa la lógica de /api/matriculas/* (habilitado='1', habilitado_estado='1'=sincronizado).
function habFiltroGrupos(req, alias = 'm') {
  const g = req.user.grupos;
  if (!Array.isArray(g)) return { where: '', params: [], bloqueado: false }; // admin
  if (g.length === 0) return { where: '', params: [], bloqueado: true };       // sin grupos → nada
  return { where: `AND ${alias}.grupo_aulas_id IN (${g.map(() => '?').join(',')})`, params: g, bloqueado: false };
}

// Deuda real de un estudiante (validado contra inscripcion_pagos):
//   cargos = monto + mora asignada + S/30 estimada por cuota vencida (cronograma_pagos)
//            impaga y sin mora asignada (la mora se registra recién al pagar)
//   abonos = todo lo recibido en inscripcion_pagos del periodo (incluye pagos de mora;
//            tarifa_estudiantes.pagado solo refleja el principal)
//   deuda  = GREATEST(cargos - abonos, 0)
const HAB_CARGOS_SUBQ = `(
  SELECT te.estudiantes_id,
         SUM(te.monto + COALESCE(te.mora,0)
             + CASE WHEN te.pagado < te.monto AND COALESCE(te.mora,0) = 0
                     AND EXISTS (SELECT 1 FROM cronograma_pagos cp
                                 WHERE cp.periodos_id = 1 AND cp.nro_cuota = te.nro_cuota AND cp.fin < CURDATE())
                    THEN 30 ELSE 0 END) AS cargos,
         MIN(te.monto) AS min_monto
  FROM tarifa_estudiantes te GROUP BY te.estudiantes_id)`;
const HAB_ABONOS_SUBQ = `(
  SELECT i.estudiantes_id, SUM(ip.monto) AS abonos
  FROM inscripcion_pagos ip JOIN inscripciones i ON i.id = ip.inscripciones_id
  WHERE i.periodos_id = 1 GROUP BY i.estudiantes_id)`;

const habilitadosResumenHandler = async (req, res) => {
  const f = habFiltroGrupos(req);
  if (f.bloqueado) return res.json({ totales: { total_inscritos: 0, total_habilitados: 0, total_sincronizados: 0 }, sedes: [], areas: [] });
  let conn;
  try {
    conn = await pool.getConnection();
    const [[totales]] = await conn.query(`
      SELECT COUNT(DISTINCT m.estudiantes_id) AS total_inscritos,
             SUM(m.habilitado='1') AS total_habilitados,
             SUM(m.habilitado='1' AND m.habilitado_estado='1') AS total_sincronizados
      FROM matriculas m WHERE m.periodos_id=1 ${f.where}`, f.params);
    const [sedes] = await conn.query(`
      SELECT s.denominacion AS sede,
             COUNT(DISTINCT m.estudiantes_id) AS total_inscritos,
             SUM(m.habilitado='1') AS total_habilitados,
             SUM(m.habilitado='1' AND m.habilitado_estado='1') AS total_sincronizados
      FROM matriculas m
      JOIN grupo_aulas ga ON ga.id=m.grupo_aulas_id
      JOIN aulas au ON au.id=ga.aulas_id JOIN locales l ON l.id=au.locales_id JOIN sedes s ON s.id=l.sedes_id
      WHERE m.periodos_id=1 ${f.where}
      GROUP BY s.id, s.denominacion ORDER BY total_inscritos DESC`, f.params);
    const [areas] = await conn.query(`
      SELECT a.denominacion AS area,
             COUNT(DISTINCT m.estudiantes_id) AS total_estudiantes,
             SUM(m.habilitado='1' AND m.habilitado_estado='1') AS total_sincronizados,
             ROUND(SUM(m.habilitado='1' AND m.habilitado_estado='1')*100.0/NULLIF(COUNT(DISTINCT m.estudiantes_id),0),2) AS porcentaje_sincronizados
      FROM matriculas m
      JOIN grupo_aulas ga ON ga.id=m.grupo_aulas_id JOIN areas a ON a.id=ga.areas_id
      WHERE m.periodos_id=1 ${f.where}
      GROUP BY a.id, a.denominacion ORDER BY total_estudiantes DESC`, f.params);
    conn.release();
    const num = (rows, keys) => rows.map(r => { const o = { ...r }; keys.forEach(k => o[k] = parseInt(o[k]) || 0); return o; });
    res.json({
      totales: { total_inscritos: parseInt(totales.total_inscritos) || 0, total_habilitados: parseInt(totales.total_habilitados) || 0, total_sincronizados: parseInt(totales.total_sincronizados) || 0 },
      sedes: num(sedes, ['total_inscritos', 'total_habilitados', 'total_sincronizados']),
      areas: areas.map(r => ({ area: r.area, total_estudiantes: parseInt(r.total_estudiantes) || 0, total_sincronizados: parseInt(r.total_sincronizados) || 0, porcentaje_sincronizados: parseFloat(r.porcentaje_sincronizados) || 0 }))
    });
  } catch (e) { if (conn) conn.release(); console.error('Error habilitados resumen:', e); res.status(500).json({ error: 'Error al obtener el resumen' }); }
};
app.get('/api/stats/habilitados/resumen', requireStatsAuth, cacheMiddleware(120), habilitadosResumenHandler);
// Versión "en vivo" (sin caché) para el tablero /stats/habilitados-stats.
app.get('/api/stats/habilitados/resumen-live', requireStatsAuth, habilitadosResumenHandler);

app.get('/api/stats/habilitados/con-deuda', requireStatsAuth, async (req, res) => {
  const f = habFiltroGrupos(req);
  if (f.bloqueado) return res.json({ estudiantes: [], total: 0 });
  const q = String(req.query.q || '').trim();
  const extra = q ? 'AND e.nro_documento LIKE ?' : '';
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`
      SELECT e.nro_documento AS dni, CONCAT_WS(' ', e.paterno, e.materno, e.nombres) AS apellidos_nombres,
             s.denominacion AS sede, a.denominacion AS area, t.denominacion AS turno, g.denominacion AS grupo,
             GREATEST(MAX(COALESCE(cg.cargos,0)) - MAX(COALESCE(ab.abonos,0)), 0) AS deuda_total,
             (SELECT CONCAT_WS(' ', u.paterno, u.materno, u.name)
              FROM audits au2 LEFT JOIN users u ON u.id = au2.user_id
              WHERE au2.auditable_type = ? AND au2.auditable_id = m.id
                AND au2.event = 'updated' AND au2.new_values LIKE '%"habilitado":"1"%'
              ORDER BY au2.id DESC LIMIT 1) AS habilitado_por
      FROM estudiantes e
      JOIN inscripciones i ON e.id=i.estudiantes_id AND i.periodos_id=1
      JOIN matriculas m ON e.id=m.estudiantes_id AND m.periodos_id=1
      JOIN ${HAB_CARGOS_SUBQ} cg ON cg.estudiantes_id = e.id
      LEFT JOIN ${HAB_ABONOS_SUBQ} ab ON ab.estudiantes_id = e.id
      JOIN sedes s ON i.sedes_id=s.id
      JOIN grupo_aulas ga ON m.grupo_aulas_id=ga.id JOIN grupos g ON ga.grupos_id=g.id
      JOIN areas a ON ga.areas_id=a.id JOIN turnos t ON ga.turnos_id=t.id
      WHERE m.habilitado='1' ${f.where} ${extra}
      GROUP BY e.id, e.nro_documento, e.paterno, e.materno, e.nombres, m.id, s.denominacion, a.denominacion, t.denominacion, g.denominacion
      HAVING deuda_total > 0.5
      ORDER BY deuda_total DESC, e.paterno, e.materno, e.nombres`, ['App\\Models\\Matricula', ...f.params, ...(q ? [`%${q}%`] : [])]);
    conn.release();
    res.json({ estudiantes: rows.map(r => ({ dni: r.dni, apellidos_nombres: r.apellidos_nombres, sede: r.sede, area: r.area, turno: r.turno, grupo: r.grupo, deuda_total: parseFloat(r.deuda_total) || 0, habilitado_por: r.habilitado_por || null })), total: rows.length });
  } catch (e) { if (conn) conn.release(); console.error('Error habilitados con-deuda:', e); res.status(500).json({ error: 'Error al obtener habilitados con deuda' }); }
});

app.get('/api/stats/habilitados/pendientes', requireStatsAuth, cacheMiddleware(120), async (req, res) => {
  const f = habFiltroGrupos(req);
  if (f.bloqueado) return res.json({ data: [], total_general: 0 });
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`
      SELECT s.denominacion AS sede, a.denominacion AS area, t.denominacion AS turno, g.denominacion AS grupo,
             COUNT(*) AS total_no_habilitados_sin_deuda
      FROM (
        -- pagó completo: cargos (incl. mora) cubiertos por abonos Y tarifa completa (sin cuota en monto=0)
        SELECT e.id, ga.aulas_id AS aulas_id, ga.areas_id AS area_id, ga.turnos_id AS turno_id, ga.grupos_id AS grupo_id
        FROM estudiantes e
        JOIN matriculas m ON e.id=m.estudiantes_id AND m.periodos_id=1
        JOIN ${HAB_CARGOS_SUBQ} cg ON cg.estudiantes_id = e.id
        LEFT JOIN ${HAB_ABONOS_SUBQ} ab ON ab.estudiantes_id = e.id
        JOIN grupo_aulas ga ON m.grupo_aulas_id=ga.id
        WHERE m.habilitado='0' ${f.where}
          AND cg.min_monto > 0
          AND (cg.cargos - COALESCE(ab.abonos,0)) <= 0.5
      ) x
      JOIN aulas au ON au.id=x.aulas_id JOIN locales l ON l.id=au.locales_id JOIN sedes s ON s.id=l.sedes_id
      JOIN areas a ON a.id=x.area_id JOIN turnos t ON t.id=x.turno_id JOIN grupos g ON g.id=x.grupo_id
      GROUP BY s.id, s.denominacion, a.id, a.denominacion, t.id, t.denominacion, g.id, g.denominacion
      ORDER BY s.denominacion, a.denominacion, t.denominacion, g.denominacion`, f.params);
    conn.release();
    const data = rows.map(r => ({ sede: r.sede, area: r.area, turno: r.turno, grupo: r.grupo, total_no_habilitados_sin_deuda: parseInt(r.total_no_habilitados_sin_deuda) || 0 }));
    res.json({ data, total_general: data.reduce((s, r) => s + r.total_no_habilitados_sin_deuda, 0) });
  } catch (e) { if (conn) conn.release(); console.error('Error habilitados pendientes:', e); res.status(500).json({ error: 'Error al obtener pendientes' }); }
});

// Detalle "pagaron completo" de un grupo (listos para habilitar).
app.get('/api/stats/habilitados/pendientes/detalle', requireStatsAuth, async (req, res) => {
  const { sede, area, turno, grupo } = req.query;
  if (!sede || !area || !turno || !grupo) return res.status(400).json({ error: 'Parámetros requeridos: sede, area, turno, grupo' });
  const f = habFiltroGrupos(req);
  if (f.bloqueado) return res.json({ estudiantes: [], total: 0 });
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`
      SELECT e.nro_documento AS dni, CONCAT_WS(' ', e.paterno, e.materno, e.nombres) AS apellidos_nombres,
             MAX(cg.cargos) AS total_tarifa, MAX(COALESCE(ab.abonos,0)) AS total_pagado,
             GREATEST(MAX(cg.cargos) - MAX(COALESCE(ab.abonos,0)), 0) AS deuda_total
      FROM estudiantes e
      JOIN matriculas m ON e.id=m.estudiantes_id AND m.periodos_id=1
      JOIN ${HAB_CARGOS_SUBQ} cg ON cg.estudiantes_id = e.id
      LEFT JOIN ${HAB_ABONOS_SUBQ} ab ON ab.estudiantes_id = e.id
      JOIN grupo_aulas ga ON m.grupo_aulas_id=ga.id JOIN grupos g ON ga.grupos_id=g.id
      JOIN areas a ON ga.areas_id=a.id JOIN turnos t ON ga.turnos_id=t.id
      JOIN aulas au ON ga.aulas_id=au.id JOIN locales l ON au.locales_id=l.id JOIN sedes s ON l.sedes_id=s.id
      WHERE m.habilitado='0' AND s.denominacion=? AND a.denominacion=? AND t.denominacion=? AND g.denominacion=? ${f.where}
      GROUP BY e.id, e.nro_documento, e.paterno, e.materno, e.nombres
      -- pagó completo: cargos (incl. mora) cubiertos por abonos Y tarifa completa
      HAVING MAX(cg.min_monto) > 0 AND (MAX(cg.cargos) - MAX(COALESCE(ab.abonos,0))) <= 0.5
      ORDER BY e.paterno, e.materno, e.nombres`, [sede, area, turno, grupo, ...f.params]);
    conn.release();
    res.json({ estudiantes: rows.map(r => ({ dni: r.dni, apellidos_nombres: r.apellidos_nombres, total_tarifa: parseFloat(r.total_tarifa) || 0, total_pagado: parseFloat(r.total_pagado) || 0, deuda_total: parseFloat(r.deuda_total) || 0 })), total: rows.length });
  } catch (e) { if (conn) conn.release(); console.error('Error habilitados detalle:', e); res.status(500).json({ error: 'Error al obtener el detalle' }); }
});

// Buscar estudiante por DNI (con verificación de grupo para no-admin).
app.get('/api/stats/habilitados/buscar/:dni', requireStatsAuth, async (req, res) => {
  const dni = String(req.params.dni || '').trim();
  if (!/^\d{6,12}$/.test(dni)) return res.status(400).json({ error: 'DNI inválido' });
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`
      SELECT m.id AS matricula_id, m.grupo_aulas_id, e.nro_documento AS dni,
             CONCAT_WS(' ', e.paterno, e.materno, e.nombres) AS apellidos_nombres,
             m.habilitado, m.habilitado_estado,
             s.denominacion AS sede, a.denominacion AS area, t.denominacion AS turno, g.denominacion AS grupo,
             GREATEST(COALESCE((SELECT cg.cargos FROM ${HAB_CARGOS_SUBQ} cg WHERE cg.estudiantes_id = e.id), 0)
                      - COALESCE((SELECT ab.abonos FROM ${HAB_ABONOS_SUBQ} ab WHERE ab.estudiantes_id = e.id), 0), 0) AS deuda_total
      FROM estudiantes e
      JOIN matriculas m ON e.id=m.estudiantes_id AND m.periodos_id=1
      LEFT JOIN grupo_aulas ga ON m.grupo_aulas_id=ga.id LEFT JOIN grupos g ON ga.grupos_id=g.id
      LEFT JOIN areas a ON ga.areas_id=a.id LEFT JOIN turnos t ON ga.turnos_id=t.id
      LEFT JOIN aulas au ON ga.aulas_id=au.id LEFT JOIN locales l ON au.locales_id=l.id LEFT JOIN sedes s ON l.sedes_id=s.id
      WHERE e.nro_documento=? LIMIT 1`, [dni]);
    if (!rows.length) { conn.release(); return res.status(404).json({ error: 'No se encontró estudiante con ese DNI', dni }); }
    const r = rows[0];
    const permitidos = req.user.grupos;
    if (Array.isArray(permitidos) && !permitidos.map(Number).includes(Number(r.grupo_aulas_id))) {
      conn.release();
      return res.status(403).json({ error: 'Sin acceso a este alumno (otro grupo)' });
    }
    // Historial auditado del campo `habilitado` (quién habilitó / deshabilitó y cuándo).
    // Nota: solo existe cuando la (des)habilitación pasó por el modelo auditado de Laravel.
    const [aud] = await conn.query(`
      SELECT a.new_values, DATE_FORMAT(a.created_at, '%Y-%m-%dT%H:%i:%s-05:00') AS created_at, u.name, u.paterno, u.materno
      FROM audits a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.auditable_type LIKE '%Matricula' AND a.auditable_id = ? AND a.event = 'updated'
        AND a.new_values LIKE '%"habilitado":%'
      ORDER BY a.id ASC`, [r.matricula_id]);
    conn.release();
    const historial = aud.map(row => {
      let valor = null;
      try { valor = JSON.parse(row.new_values)?.habilitado; } catch { /* ignore */ }
      const por = [row.paterno, row.materno, row.name].filter(Boolean).join(' ').trim() || 'Usuario desconocido';
      return { evento: valor === '1' ? 'habilitado' : 'deshabilitado', por, fecha: row.created_at };
    });
    const habilitacion = historial.length ? historial[historial.length - 1] : null; // último cambio
    res.json({
      matricula_id: r.matricula_id, dni: r.dni, apellidos_nombres: r.apellidos_nombres,
      habilitado: r.habilitado === '1', sincronizado: r.habilitado === '1' && r.habilitado_estado === '1',
      sede: r.sede, area: r.area, turno: r.turno, grupo: r.grupo, deuda_total: parseFloat(r.deuda_total) || 0,
      habilitacion, historial
    });
  } catch (e) { if (conn) conn.release(); console.error('Error habilitados buscar:', e); res.status(500).json({ error: 'Error al buscar estudiante' }); }
});

// Constancia: genera el token (API externa) y devuelve la URL del PDF.
// Ranking de quiénes están habilitando (auditoría; solo admin — panel reportes-aux).
app.get('/api/stats/reportes-aux/habilitaciones/ranking', requireAdmin, cacheMiddleware(120), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`
      SELECT a.user_id,
             COALESCE(CONCAT_WS(' ', u.paterno, u.materno, u.name), '(sistema)') AS usuario,
             (SELECT GROUP_CONCAT(r.name SEPARATOR ', ') FROM model_has_roles mhr JOIN roles r ON r.id = mhr.role_id
              WHERE mhr.model_id = u.id AND mhr.model_type LIKE '%User') AS rol,
             SUM(a.new_values LIKE '%"habilitado":"1"%') AS habilitaciones,
             SUM(a.new_values LIKE '%"habilitado":"0"%') AS deshabilitaciones,
             DATE_FORMAT(MAX(a.created_at), '%Y-%m-%dT%H:%i:%s-05:00') AS ultima
      FROM audits a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.auditable_type LIKE '%Matricula' AND a.event = 'updated'
        AND (a.new_values LIKE '%"habilitado":"1"%' OR a.new_values LIKE '%"habilitado":"0"%')
      GROUP BY a.user_id, usuario
      ORDER BY habilitaciones DESC, deshabilitaciones DESC`);
    conn.release();
    res.json({
      ranking: rows.map(r => ({
        usuario: r.usuario, rol: r.rol || '—',
        habilitaciones: parseInt(r.habilitaciones) || 0,
        deshabilitaciones: parseInt(r.deshabilitaciones) || 0,
        ultima: r.ultima
      }))
    });
  } catch (e) { if (conn) conn.release(); console.error('Error habilitados ranking:', e); res.status(500).json({ error: 'Error al obtener el ranking' }); }
});

app.get('/api/stats/habilitados/constancia/:matricula_id', requireStatsAuth, async (req, res) => {
  const matriculaId = Number(req.params.matricula_id);
  if (!Number.isFinite(matriculaId) || matriculaId <= 0) return res.status(400).json({ error: 'ID de matrícula inválido' });
  let conn;
  try {
    conn = await pool.getConnection();
    const [[m]] = await conn.query('SELECT grupo_aulas_id, habilitado, habilitado_estado FROM matriculas WHERE id=? AND periodos_id=1', [matriculaId]);
    conn.release(); conn = null;
    if (!m) return res.status(404).json({ error: 'Matrícula no encontrada' });
    // Verificación de grupo para no-admin.
    const permitidos = req.user.grupos;
    if (Array.isArray(permitidos) && !permitidos.map(Number).includes(Number(m.grupo_aulas_id))) {
      return res.status(403).json({ error: 'Sin acceso a esta constancia' });
    }
    // Solo se emite constancia si está habilitado Y sincronizado.
    if (m.habilitado !== '1' || m.habilitado_estado !== '1') {
      return res.status(409).json({ error: 'El estudiante debe estar habilitado y sincronizado para emitir la constancia' });
    }
    const r = await fetch(`https://sistemas.cepreuna.edu.pe/api/perfil/encrypt/${matriculaId}`);
    if (!r.ok) throw new Error(`token ${r.status}`);
    const token = (await r.text()).trim();
    res.json({ token, pdf_url: `https://sistemas.cepreuna.edu.pe/dga/estudiantes/pdf-constancia/${token}`, matricula_id: matriculaId });
  } catch (e) { if (conn) conn.release(); console.error('Error constancia:', e); res.status(502).json({ error: 'No se pudo generar la constancia' }); }
});

// ============ HABILITACIONES · AUXILIARES (gráficas reportes-aux) ============
// Deuda por estudiante = principal impago + mora SOLO de cuotas sin pagar.
// Deuda real (misma regla que /stats/habilitados): cargos con mora − abonos de inscripcion_pagos.
const HAB_DEUDA_SUBQ = `(SELECT cg.estudiantes_id, GREATEST(cg.cargos - COALESCE(ab.abonos,0), 0) AS deuda
  FROM ${HAB_CARGOS_SUBQ} cg LEFT JOIN ${HAB_ABONOS_SUBQ} ab ON ab.estudiantes_id = cg.estudiantes_id)`;

// Estado (habilitados/sincronizados) y deudores por auxiliar.
app.get('/api/stats/reportes-aux/habilitaciones/auxiliares', requireAdmin, cacheMiddleware(120), async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`
      SELECT u.id AS users_id, CONCAT_WS(' ', u.paterno, u.materno, u.name) AS auxiliar, u.dni AS dni_auxiliar,
             COUNT(DISTINCT m.estudiantes_id) AS asignados,
             COUNT(DISTINCT CASE WHEN m.habilitado='1' THEN m.estudiantes_id END) AS habilitados,
             COUNT(DISTINCT CASE WHEN m.habilitado_estado='1' THEN m.estudiantes_id END) AS sincronizados,
             COUNT(DISTINCT CASE WHEN d.deuda > 0.5 THEN m.estudiantes_id END) AS deudores
      FROM auxiliares a
      JOIN users u ON u.id = a.users_id
      JOIN auxiliar_grupos ag ON ag.auxiliares_id = a.id
      JOIN matriculas m ON m.grupo_aulas_id = ag.grupo_aulas_id AND m.periodos_id = 1 AND m.estado = '0'
      LEFT JOIN ${HAB_DEUDA_SUBQ} d ON d.estudiantes_id = m.estudiantes_id
      GROUP BY u.id, u.paterno, u.materno, u.name, u.dni
      ORDER BY deudores DESC`);
    conn.release();
    const pct = (a, b) => b > 0 ? Math.round(1000 * a / b) / 10 : 0;
    const auxiliares = rows.map(r => {
      const asignados = parseInt(r.asignados) || 0;
      const habilitados = parseInt(r.habilitados) || 0;
      const sincronizados = parseInt(r.sincronizados) || 0;
      const deudores = parseInt(r.deudores) || 0;
      return {
        users_id: r.users_id, auxiliar: r.auxiliar, dni_auxiliar: r.dni_auxiliar, asignados, habilitados, sincronizados, deudores,
        al_dia: asignados - deudores,
        pct_habilitados: pct(habilitados, asignados),
        pct_sincronizados: pct(sincronizados, asignados),
        pct_deudores: pct(deudores, asignados)
      };
    });
    const tot = auxiliares.reduce((s, r) => ({
      asignados: s.asignados + r.asignados, habilitados: s.habilitados + r.habilitados,
      sincronizados: s.sincronizados + r.sincronizados, deudores: s.deudores + r.deudores
    }), { asignados: 0, habilitados: 0, sincronizados: 0, deudores: 0 });
    res.json({ auxiliares, totales: tot });
  } catch (e) { if (conn) conn.release(); console.error('Error habilitaciones auxiliares:', e); res.status(500).json({ error: 'Error al obtener el reporte' }); }
});

// Habilitaciones/deshabilitaciones por día (audits, hora de Lima). Default 01-15 jul 2026.
app.get('/api/stats/reportes-aux/habilitaciones/por-dia', requireAdmin, cacheMiddleware(120), async (req, res) => {
  const rx = /^\d{4}-\d{2}-\d{2}$/;
  const desde = rx.test(String(req.query.desde || '')) ? req.query.desde : '2026-07-01';
  const hasta = rx.test(String(req.query.hasta || '')) ? req.query.hasta : '2026-07-15';
  const aux = Number(req.query.aux); // users_id del auxiliar (opcional)
  const params = [desde, hasta];
  let filtroAux = '';
  if (Number.isFinite(aux) && aux > 0) {
    filtroAux = `AND auditable_id IN (
      SELECT m.id FROM matriculas m
      JOIN auxiliar_grupos ag ON ag.grupo_aulas_id = m.grupo_aulas_id
      JOIN auxiliares ax ON ax.id = ag.auxiliares_id
      WHERE ax.users_id = ? AND m.periodos_id = 1)`;
    params.push(aux);
  }
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS dia,
             SUM(new_values LIKE '%"habilitado":"1"%') AS habilitaciones,
             SUM(new_values LIKE '%"habilitado":"0"%') AS deshabilitaciones
      FROM audits
      WHERE auditable_type LIKE '%Matricula' AND event = 'updated'
        AND (new_values LIKE '%"habilitado":"1"%' OR new_values LIKE '%"habilitado":"0"%')
        AND DATE(created_at) BETWEEN ? AND ? ${filtroAux}
      GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d') ORDER BY dia`, params);
    conn.release();
    // Rellenar días faltantes del rango con 0 (clave local YYYY-MM-DD, sin líos de zona).
    const fmt = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const mapa = {};
    rows.forEach(r => { mapa[r.dia] = { hab: parseInt(r.habilitaciones) || 0, des: parseInt(r.deshabilitaciones) || 0 }; });
    const dias = [];
    let acumulado = 0;
    const d0 = new Date(desde + 'T00:00:00'), d1 = new Date(hasta + 'T00:00:00');
    for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) {
      const key = fmt(d);
      const v = mapa[key] || { hab: 0, des: 0 };
      acumulado += v.hab - v.des;
      dias.push({ dia: key, habilitaciones: v.hab, deshabilitaciones: v.des, neto_acumulado: acumulado });
    }
    res.json({ dias, desde, hasta });
  } catch (e) { if (conn) conn.release(); console.error('Error habilitaciones por-dia:', e); res.status(500).json({ error: 'Error al obtener el reporte' }); }
});

// Página del panel.
app.get('/stats/reportes-aux/habilitaciones', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'stats', 'reportes-aux', 'habilitaciones', 'index.html'));
});

// ============ ENDPOINT DE AUTENTICACIÓN ============

// Endpoint para autenticar participantes
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { dni } = req.body;

    // Validar DNI
    if (!dni || !/^\d{8}$/.test(dni)) {
      return res.status(400).json({
        success: false,
        error: 'DNI inválido. Debe tener 8 dígitos'
      });
    }

    // Validar contra la lista de docentes aptos del periodo actual.
    const connection = await pool.getConnection();
    let docente = null;
    let area = null;
    let inscrito = false; // ¿siguió el curso? (solo los inscritos pueden ver el certificado)
    try {
      const [rows] = await connection.query(
        `SELECT d.nombres, d.paterno, d.materno, d.nro_documento, d.email, d.celular
         FROM docente_aptos da
         JOIN docentes d ON d.id = da.docentes_id
         WHERE da.periodos_id = 1 AND d.nro_documento = ?
         LIMIT 1`,
        [dni]
      );
      docente = rows[0] || null;

      // Inscripción al curso: define el área y el acceso al certificado.
      if (docente) {
        const [insc] = await connection.query(
          `SELECT area FROM inscripcion_curso_tallers WHERE nro_documento = ? LIMIT 1`,
          [dni]
        );
        inscrito = insc.length > 0;
        if (inscrito && insc[0].area != null) area = parseInt(insc[0].area);
      } else {
        // No es docente apto del periodo, pero puede estar inscrito al curso-taller
        // (hay inscritos que no figuran en `docentes`): se les permite entrar para
        // que puedan descargar su certificado del curso.
        const [insc] = await connection.query(
          `SELECT nombres, paterno, materno, nro_documento, celular, email, area
           FROM inscripcion_curso_tallers WHERE nro_documento = ? LIMIT 1`,
          [dni]
        );
        if (insc.length) {
          const r = insc[0];
          docente = { nombres: r.nombres, paterno: r.paterno, materno: r.materno, nro_documento: r.nro_documento, email: r.email, celular: r.celular };
          inscrito = true;
          if (r.area != null) area = parseInt(r.area);
        }
      }
    } finally {
      connection.release();
    }

    if (!docente) {
      return res.status(404).json({
        success: false,
        error: 'No se encontró un docente apto con este DNI'
      });
    }

    res.json({
      success: true,
      data: {
        nombres: docente.nombres,
        paterno: docente.paterno,
        materno: docente.materno,
        nombre: `${docente.paterno || ''} ${docente.materno || ''}, ${docente.nombres || ''}`.trim().replace(/^,\s*/, ''),
        nro_documento: String(docente.nro_documento).trim(),
        area: area,
        inscrito: inscrito,
        email: docente.email || '',
        telefono: docente.celular || ''
      }
    });

  } catch (error) {
    console.error('Error en autenticación:', error);
    res.status(500).json({
      success: false,
      error: 'Error al procesar la solicitud',
      message: error.message
    });
  }
});

// Mapa DNI -> mensaje de informe (semanas 1-8, ciclo marzo-julio 2026).
// Se carga una vez al iniciar; el JSON vive en /data (no servido estáticamente).
let informesDocentes = {};
try {
  informesDocentes = require('./data/informes-docentes-2026.json');
  console.log(`📄 Informes docentes cargados: ${Object.keys(informesDocentes).length}`);
} catch (e) {
  console.warn('⚠️  No se pudo cargar data/informes-docentes-2026.json:', e.message);
}

// Devuelve el mensaje de informe correspondiente a un DNI (o 404 si no existe).
app.get('/api/informe-docente/:dni', (req, res) => {
  const dni = String(req.params.dni || '').trim();

  if (!/^\d{7,8}$/.test(dni)) {
    return res.status(400).json({ success: false, error: 'DNI inválido' });
  }

  const mensaje = informesDocentes[dni];
  if (!mensaje) {
    return res.status(404).json({ success: false, error: 'Sin comunicado para este DNI' });
  }

  res.json({ success: true, mensaje });
});

// Segunda notificación: presentación de informes de las semanas 9 a 16.
// Mismo mecanismo que la de 1-8; el JSON vive en /data (no servido estáticamente).
let informesDocentes916 = {};
try {
  informesDocentes916 = require('./data/informes-docentes-9-16-2026.json');
  console.log(`📄 Informes docentes 9-16 cargados: ${Object.keys(informesDocentes916).length}`);
} catch (e) {
  console.warn('⚠️  No se pudo cargar data/informes-docentes-9-16-2026.json:', e.message);
}

// Devuelve el comunicado de semanas 9-16 para un DNI (o 404 si no existe).
app.get('/api/informe-docente-9-16/:dni', (req, res) => {
  const dni = String(req.params.dni || '').trim();

  if (!/^\d{7,8}$/.test(dni)) {
    return res.status(400).json({ success: false, error: 'DNI inválido' });
  }

  const mensaje = informesDocentes916[dni];
  if (!mensaje) {
    return res.status(404).json({ success: false, error: 'Sin comunicado para este DNI' });
  }

  res.json({ success: true, mensaje });
});

// Resultados del Simulacro de Examen de Admisión (C.U. 05 julio 2026).
// El JSON vive en /data (no servido estáticamente): la consulta devuelve SOLO
// el registro del DNI solicitado, nunca el listado completo. Así los datos de
// los demás estudiantes no quedan expuestos en el navegador ni descargables.
let resultadosSimulacro = {};
try {
  resultadosSimulacro = require('./data/simulacro-resultados-2026.json');
  console.log(`📄 Resultados simulacro cargados: ${Object.keys(resultadosSimulacro).length}`);
} catch (e) {
  console.warn('⚠️  No se pudo cargar data/simulacro-resultados-2026.json:', e.message);
}

// Devuelve el resultado del simulacro para un DNI (o 404 si no existe).
app.get('/api/simulacro/resultado/:dni', (req, res) => {
  const dni = String(req.params.dni || '').trim();

  if (!/^\d{8}$/.test(dni)) {
    return res.status(400).json({ success: false, error: 'DNI inválido. Debe tener 8 dígitos.' });
  }

  const r = resultadosSimulacro[dni];
  if (!r) {
    return res.status(404).json({ success: false, error: 'No se encontró un resultado para este DNI.' });
  }

  res.json({
    success: true,
    data: {
      nombre: r.n,
      area: r.a,
      puntaje: r.p,          // null si el estudiante no rindió el examen
      rindio: r.p !== null,
    }
  });
});

// Endpoint para login de administradores (Dashboard Stats)
app.post('/api/stats/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  let connection;
  try {
    connection = await pool.getConnection();

    // Buscar usuario por email
    const [users] = await connection.query(
      'SELECT id, name, email, password FROM users WHERE email = ? AND estado = "1" LIMIT 1',
      [email]
    );

    if (users.length === 0) {
      connection.release();
      return res.status(401).json({ error: 'Usuario no encontrado o inactivo' });
    }

    const user = users[0];

    // Convertir hash de PHP ($2y$) a formato Node.js ($2a$)
    // Son funcionalmente idénticos, pero bcryptjs requiere $2a$ o $2b$
    const normalizedHash = user.password.replace(/^\$2y\$/, '$2a$');
    const isMatch = await bcrypt.compare(password, normalizedHash);

    if (!isMatch) {
      connection.release();
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    // Buscar rol asignado al usuario (Spatie permission). Tomamos el primero del guard 'web'.
    const [roleRows] = await connection.query(`
      SELECT r.id, r.name
      FROM model_has_roles mhr
      JOIN roles r ON r.id = mhr.role_id
      WHERE mhr.model_id = ?
        AND mhr.model_type LIKE '%User%'
        AND r.guard_name = 'web'
      ORDER BY r.id
      LIMIT 1
    `, [user.id]);
    const role = roleRows[0]?.name || null;

    // Resolver grupos permitidos según rol
    const grupos = await calcularGruposPermitidos(connection, user.id, role);

    connection.release();

    if (!role) {
      return res.status(403).json({ error: 'Usuario sin rol asignado' });
    }

    // Firmar JWT
    const token = jwt.sign(
      { sub: user.id, role, grupos },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role,
        grupos_count: grupos === null ? null : grupos.length,
      }
    });

  } catch (error) {
    if (connection) connection.release();
    console.error('Error en login stats:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint de salud
app.get('/health', (req, res) => {
  res.json({
    status: JWT_SECRET_MISSING ? 'DEGRADED' : 'OK',
    jwtSecretConfigured: !JWT_SECRET_MISSING,
    timestamp: new Date().toISOString()
  });
});

// ===== Descarga de modelos de informe (.docx) =====
// Short URLs que descargan el modelo de informe. Se proxean a través de
// nuestro dominio (en vez de redirigir a docs.google.com) para que en móvil
// la app de Google Docs no intercepte el enlace y lo abra en modo "vista":
// el servidor baja el .docx de Google y lo reenvía como descarga forzada.
const INFORME_DOCS = {
  'informe-admin-1': '1dgButtgOJHWTbob6gQM4ao-TWYOj1Wf5',
  'informe-admin-2': '1CI80lBbi6P1OLNv3rgxSOZitx0TzsuPL',
  'informe-docente-unap': '1WCwDK3RpGIJk7Px5KXuOUk2IKDa0_kYm',
  'informe-docente-particular': '1yscb5vWaY_bImLPrRw0vQO1w56KWmzkp',
  'informe-docente-particular-seminario': '1dxbodIDAk4O-Za0bCjB9e0zEN_TYo9No',
};

app.get(
  Object.keys(INFORME_DOCS).map(slug => `/${slug}`),
  async (req, res) => {
    const slug = req.path.replace(/^\//, '');
    const docId = INFORME_DOCS[slug];
    const googleUrl = `https://docs.google.com/document/d/${docId}/export?format=docx`;

    try {
      const upstream = await fetch(googleUrl);
      if (!upstream.ok) throw new Error(`Google respondió ${upstream.status}`);

      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${slug}.docx"`);
      res.setHeader('Content-Length', buffer.length);
      // No cachear: el modelo puede editarse y debe llegar siempre actualizado.
      res.setHeader('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (error) {
      console.error(`Error al descargar informe "${slug}":`, error.message);
      // Fallback: si falla el proxy, redirigir directo a Google (al menos abre).
      res.redirect(302, googleUrl);
    }
  }
);

// ===== Descarga de archivos de Drive (PDFs y similares) =====
// Mismo patrón que INFORME_DOCS pero para archivos subidos a Drive (no Google Docs).
// Usa el endpoint `uc?export=download` y propaga el Content-Type real de Google
// para que funcione tanto con PDF como con otros formatos.
const INFORME_DRIVE_FILES = {
  'cci-una-puno': '15b6R1LiCtFe_RYDcFWeZH6wp7XiC-Ra0',
  'dj-unap':      '1RHxX4lI41oAcAoCMLtjAq10DyUfAgybe',
};

app.get(
  Object.keys(INFORME_DRIVE_FILES).map(slug => `/${slug}`),
  async (req, res) => {
    const slug = req.path.replace(/^\//, '');
    const fileId = INFORME_DRIVE_FILES[slug];
    // `confirm=t` salta la página de "virus scan warning" para archivos > 100 MB.
    const googleUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

    try {
      const upstream = await fetch(googleUrl, { redirect: 'follow' });
      if (!upstream.ok) throw new Error(`Google respondió ${upstream.status}`);

      const buffer = Buffer.from(await upstream.arrayBuffer());
      const upstreamType = upstream.headers.get('content-type') || '';

      // Si Google devolvió HTML, significa que mostró la página de confirmación —
      // tratarlo como error para que caiga al fallback de redirect.
      if (upstreamType.includes('text/html')) {
        throw new Error('Drive devolvió HTML (página de confirmación)');
      }

      // Detectar tipo real por firma (magic bytes), porque Drive a menudo
      // responde `application/octet-stream` aunque el archivo sea un PDF.
      const isPdf = buffer.length >= 4 && buffer.slice(0, 4).toString('latin1') === '%PDF';
      const contentType = isPdf ? 'application/pdf' : (upstreamType || 'application/octet-stream');
      const ext = isPdf ? 'pdf'
        : (upstreamType.split(';')[0].split('/').pop() || '').replace(/[^a-z0-9]/gi, '') || 'bin';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${slug}.${ext}"`);
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (error) {
      console.error(`Error al descargar archivo Drive "${slug}":`, error.message);
      // Fallback: vista del archivo en Drive (mejor que un 500).
      res.redirect(302, `https://drive.google.com/file/d/${fileId}/view`);
    }
  }
);

// Servir index.html en la raíz
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Rutas sin .html (URLs limpias)
app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/dashboard.html');
});

app.get('/curso', (req, res) => {
  res.sendFile(__dirname + '/curso.html');
});

app.get('/videos', (req, res) => {
  res.sendFile(__dirname + '/videos.html');
});

app.get('/materiales', (req, res) => {
  res.sendFile(__dirname + '/materiales.html');
});

app.get('/certificado', (req, res) => {
  res.sendFile(__dirname + '/certificado.html');
});

app.get('/simulacro', (req, res) => {
  res.sendFile(__dirname + '/simulacro.html');
});

// Endpoint para servir la imagen del certificado
app.get('/certificado-2026-curso.png', (req, res) => {
  const path = require('path');
  const imagePath = path.join(__dirname, 'certificado-2026-curso.png');
  res.sendFile(imagePath);
});

// Mantener compatibilidad con URLs antiguas (redireccionar)
app.get('/dashboard.html', (req, res) => {
  res.redirect(301, '/dashboard');
});

app.get('/curso.html', (req, res) => {
  res.redirect(301, '/curso');
});

app.get('/videos.html', (req, res) => {
  res.redirect(301, '/videos');
});

app.get('/materiales.html', (req, res) => {
  res.redirect(301, '/materiales');
});

app.get('/certificado.html', (req, res) => {
  res.redirect(301, '/certificado');
});

app.get('/simulacro.html', (req, res) => {
  res.redirect(301, '/simulacro');
});

// Ruta para panel de estadísticas
app.get('/stats', (req, res) => {
  res.sendFile(__dirname + '/stats/index.html');
});

// Ruta para página de reportes
app.get('/stats/reportes', (req, res) => {
  res.sendFile(__dirname + '/stats/reportes/index.html');
});

// Iniciar servidor (solo en desarrollo local)
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  });
}

// Exportar para Vercel
module.exports = app;
