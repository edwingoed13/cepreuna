// Configuración de la aplicación
const CONFIG = {
    // URL del API Backend - Usa el mismo dominio para evitar CORS
    API_BASE: window.location.origin,
    API_LISTADO_CURSO: `${window.location.origin}/api/listado-curso/inscritos`,
    API_INSCRIPCIONES: 'https://prepagovalido.waready.org.pe/api/v1/inscripciones',

    // Otras configuraciones
    APP_NAME: 'CEPREUNA',
    APP_YEAR: '2026',

    // Configuración de certificados
    CERTIFICADO_DISPONIBLE: false, // Cambiar a true cuando estén disponibles

    // Configuración de asistencia mínima para certificado
    ASISTENCIA_MINIMA: 80,
};
