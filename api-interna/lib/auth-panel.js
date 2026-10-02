'use strict';

/**
 * Validación de credenciales del panel /stats contra la base institucional.
 *
 * Vive junto al reporte porque lo necesita el mismo servicio: desde que la base
 * antigua se dio de baja, los usuarios del panel solo existen en la base
 * multiciclo, que está en la red interna.
 *
 * Aquí solo se COMPRUEBA la contraseña y se devuelve el perfil. El JWT lo firma
 * el servidor principal con su propio secreto, que nunca sale de Vercel: así
 * este servicio no puede emitir sesiones por su cuenta.
 *
 * Solo lectura: las tres consultas son fijas y parametrizadas.
 */

const bcrypt = require('bcryptjs');
const { conReintento } = require('./reintento');

// Roles con acceso global al panel. Debe coincidir con ADMIN_ROLES del servidor.
const ADMIN_ROLES = ['Administrador', 'Super Admin', 'Oficina de Administración'];
const esAdmin = (rol) => ADMIN_ROLES.includes(rol);

/**
 * Grupos que el usuario puede ver. `null` = todos (administradores).
 * Replica la lógica del servidor principal; ver allí las notas sobre los
 * nombres engañosos de `coordinador_grupos`.
 */
async function gruposPermitidos(conn, userId, rol) {
  if (!rol) return [];
  if (esAdmin(rol)) return null;

  if (rol.startsWith('Auxiliar')) {
    const [rows] = await conn.query(`
      SELECT ag.grupo_aulas_id
      FROM auxiliares a
      JOIN auxiliar_grupos ag ON ag.auxiliares_id = a.id
      WHERE a.users_id = ?`, [userId]);
    return rows.map(r => Number(r.grupo_aulas_id));
  }

  if (rol === 'Coordinador Auxiliar') {
    // coordinador_id → users.id ; grupos_id → grupo_aulas.id (nombres engañosos).
    const [rows] = await conn.query(`
      SELECT DISTINCT cg.grupos_id AS grupo_aulas_id
      FROM coordinador_grupos cg
      WHERE cg.coordinador_id = ?`, [userId]);
    return rows.map(r => Number(r.grupo_aulas_id));
  }

  return [];
}

/**
 * Comprueba email + contraseña. Devuelve el perfil o null si no son válidos.
 * No distingue entre "no existe" y "contraseña incorrecta" para no revelar
 * qué correos están dados de alta.
 */
async function validarCredenciales(pool, email, password) {
  return conReintento(() => validar(pool, email, password));
}

async function validar(pool, email, password) {
  const conn = await pool.getConnection();
  try {
    const [users] = await conn.query(
      `SELECT id, name, email, password FROM users WHERE email = ? AND estado = '1' LIMIT 1`,
      [email]);
    if (users.length === 0) return null;

    const user = users[0];
    // Los hashes vienen de PHP ($2y$); bcryptjs espera $2a$/$2b$. Son equivalentes.
    const hash = String(user.password).replace(/^\$2y\$/, '$2a$');
    if (!(await bcrypt.compare(password, hash))) return null;

    // Rol de Spatie: el primero del guard 'web'.
    const [roles] = await conn.query(`
      SELECT r.name
      FROM model_has_roles mhr
      JOIN roles r ON r.id = mhr.role_id
      WHERE mhr.model_id = ?
        AND mhr.model_type LIKE '%User%'
        AND r.guard_name = 'web'
      ORDER BY r.id
      LIMIT 1`, [user.id]);
    const rol = roles[0]?.name || null;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: rol,
      grupos: await gruposPermitidos(conn, user.id, rol)
    };
  } finally {
    conn.release();
  }
}

module.exports = { validarCredenciales };
