// Configuración — todas las llamadas externas pasan por el backend propio.
const RUC_API_URL = '/api/forms-admin/ruc';            // Proxy apisperu (token JWT en servidor)
const CHECK_DNI_URL = '/api/forms-admin/check-dni';    // Proxy Apps Script (GET)
const SUBMIT_URL = '/api/forms-admin/submit';          // Proxy Apps Script (POST)

// Variables para almacenar datos del RUC
let rucActivo = 'No';
let rucHabido = 'No';

// Objetos con las tallas por sexo
const tallas = {
    femenino: {
        casaca: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'],
        pantalon: ['S', 'M(B)', 'L', 'XL', 'XXL', 'XXXL']
    },
    masculino: {
        casaca: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'],
        pantalon: ['S', 'M(B)', 'L', 'XL', 'XXL', 'XXXL']
    }
};

// Función para actualizar las opciones de tallas según el sexo
function actualizarTallas() {
    const sexo = document.querySelector('input[name="sexo"]:checked')?.value;
    const casacaSelect = document.getElementById('talla_casaca');
    const pantalonSelect = document.getElementById('talla_pantalon');
    const guiaFemenino = document.getElementById('guia-femenino');
    const guiaMasculino = document.getElementById('guia-masculino');
    const tallasTitle = document.getElementById('tallas-title');

    // Limpiar selects
    casacaSelect.innerHTML = '<option value="">Seleccione su talla</option>';
    pantalonSelect.innerHTML = '<option value="">Seleccione su talla</option>';

    // Ocultar todas las guías
    guiaFemenino.style.display = 'none';
    guiaMasculino.style.display = 'none';

    if (sexo === 'F') {
        // Actualizar título para mujer
        if (tallasTitle) {
            tallasTitle.textContent = 'Tallas de Vestimenta (MUJER)';
        }

        // Llenar opciones para femenino
        tallas.femenino.casaca.forEach(talla => {
            casacaSelect.innerHTML += `<option value="C-${talla}">${talla}</option>`;
        });
        tallas.femenino.pantalon.forEach(talla => {
            pantalonSelect.innerHTML += `<option value="P-${talla}">${talla}</option>`;
        });
        guiaFemenino.style.display = 'block';
    } else if (sexo === 'M') {
        // Actualizar título para varón
        if (tallasTitle) {
            tallasTitle.textContent = 'Tallas de Vestimenta (VARÓN)';
        }

        // Llenar opciones para masculino
        tallas.masculino.casaca.forEach(talla => {
            casacaSelect.innerHTML += `<option value="C-${talla}">${talla}</option>`;
        });
        tallas.masculino.pantalon.forEach(talla => {
            pantalonSelect.innerHTML += `<option value="P-${talla}">${talla}</option>`;
        });
        guiaMasculino.style.display = 'block';
    } else {
        // Restaurar título por defecto si no hay sexo seleccionado
        if (tallasTitle) {
            tallasTitle.textContent = 'Tallas de Vestimenta';
        }
    }
}

// Agrega este event listener para los radio buttons de sexo
document.querySelectorAll('input[name="sexo"]').forEach(radio => {
    radio.addEventListener('change', actualizarTallas);
});

// También llama a la función al cargar la página si ya hay un sexo seleccionado
document.addEventListener('DOMContentLoaded', function() {
    const sexoSeleccionado = document.querySelector('input[name="sexo"]:checked');
    if (sexoSeleccionado) {
        actualizarTallas();
    }
});

// Función para mostrar mensajes en el frontend (estilos en styles.css)
function mostrarMensaje(tipo, mensaje) {
    const tiposValidos = ['exito', 'error', 'info'];
    const clase = tiposValidos.includes(tipo) ? tipo : 'info';

    const mensajeDiv = document.createElement('div');
    mensajeDiv.id = 'mensaje-flotante';
    mensajeDiv.className = `mensaje-flotante mensaje-${clase}`;
    mensajeDiv.textContent = mensaje;

    document.body.appendChild(mensajeDiv);

    setTimeout(() => {
        mensajeDiv.style.animation = 'fadeOut 0.5s';
        setTimeout(() => {
            if (mensajeDiv.parentNode) mensajeDiv.parentNode.removeChild(mensajeDiv);
        }, 500);
    }, 5000);
}

// Consulta el DNI contra el backend propio (que a su vez proxya al Apps Script).
// Devuelve el objeto del backend o null si hubo error/timeout.
async function consultarDNI(dni, { timeoutMs = 10000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(`${CHECK_DNI_URL}/${encodeURIComponent(dni)}`, { signal: ctrl.signal });
        return await r.json();
    } catch (err) {
        console.error('Error consultando DNI:', err);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Vista previa de la imagen
function previewImage(input) {
    const preview = document.getElementById('preview');
    const file = input.files[0];
    
    if (file) {
        if (file.size > 2 * 1024 * 1024) {
            mostrarMensaje('error', 'La imagen es demasiado grande (máximo 2MB)');
            input.value = '';
            preview.style.display = 'none';
            return;
        }
        
        const reader = new FileReader();
        reader.onload = function(e) {
            preview.src = e.target.result;
            preview.style.display = 'block';
        }
        reader.readAsDataURL(file);
    } else {
        preview.style.display = 'none';
    }
}

// Mostrar vista previa de imagen existente desde URL
function mostrarImagenExistente(imageUrl) {
    if (!imageUrl) return;
    
    const fileUploadArea = document.querySelector('.file-upload');
    
    // Crear contenedor para la imagen existente
    const existingImageContainer = document.createElement('div');
    existingImageContainer.id = 'existing-image-container';
    existingImageContainer.className = 'existing-image-preview';
    
    // Renderizar siempre como <img> (el thumbnail de Drive es embebible
    // cross-origin; los iframes los bloquea la CSP frame-ancestors de Drive).
    const displayUrl = convertToPreviewUrl(imageUrl);
    existingImageContainer.innerHTML = `
        <div class="existing-image-header">
            <strong>Foto actual registrada</strong>
            <button type="button" class="btn-remove-preview" onclick="ocultarImagenExistente()">×</button>
        </div>
        <div class="image-container" style="text-align: center;">
            <img src="${displayUrl}" alt="Foto existente" class="existing-image" referrerpolicy="no-referrer"
                 style="max-width: 250px; max-height: 250px; border-radius: 8px; display: none; margin: 10px auto; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <div class="image-placeholder" style="display: none; width: 250px; height: 250px; margin: 10px auto; border: 2px dashed #ddd; border-radius: 8px; background: #f8f9fa; align-items: center; justify-content: center; flex-direction: column; cursor: pointer;">
                <div style="font-size: 48px;">📷</div>
                <div><strong>Foto no disponible</strong><br><small>Click para ver original</small></div>
            </div>
        </div>
        <div class="photo-actions" style="text-align: center; margin-top: 10px;">
            <button type="button" class="btn-view-photo" onclick="window.open('${imageUrl}', '_blank')"
                    style="background: #2563eb; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">
                Ver foto original
            </button>
        </div>
        <p class="update-note"><small>Puedes subir una nueva imagen para reemplazar la actual</small></p>
    `;

    setTimeout(() => {
        const img = existingImageContainer.querySelector('.existing-image');
        const placeholder = existingImageContainer.querySelector('.image-placeholder');
        if (img && placeholder) {
            img.onload = function() {
                this.style.display = 'block';
                placeholder.style.display = 'none';
            };
            img.onerror = function() {
                this.style.display = 'none';
                placeholder.style.display = 'flex';
                placeholder.onclick = () => window.open(imageUrl, '_blank');
            };
        }
    }, 50);
    
    // Remover contenedor existente si ya existe
    const existingContainer = document.getElementById('existing-image-container');
    if (existingContainer) {
        existingContainer.remove();
    }
    
    // Insertar antes del área de subida de archivos
    fileUploadArea.parentNode.insertBefore(existingImageContainer, fileUploadArea);
}

// Ocultar vista previa de imagen existente
function ocultarImagenExistente() {
    const container = document.getElementById('existing-image-container');
    if (container) {
        container.remove();
    }
}

// Convertir imagen a Base64
async function procesarImagen(file) {
    return new Promise((resolve, reject) => {
        if (!file) resolve(null);
        
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve({
            base64: reader.result,
            type: file.type
        });
        reader.onerror = error => reject(error);
    });
}

// Validar que solo se ingresen números
function validarSoloNumeros(input) {
    input.value = input.value.replace(/[^0-9]/g, '');
}

// Validar longitud de campo
function validarLongitud(input, longitud) {
    const errorElement = document.getElementById(`${input.id}-error`);
    
    if (input.value.length > longitud) {
        input.value = input.value.slice(0, longitud);
    }
    
    if (input.value.length !== longitud && input.value.length > 0) {
        errorElement.textContent = `Debe tener exactamente ${longitud} dígitos`;
    } else {
        errorElement.textContent = '';
    }
}

// Variables globales para manejar actualización
let isUpdateMode = false;
let existingUserData = null;
let originalFormData = {}; // Para comparar cambios

// Validar DNI duplicado usando JSONP
async function validarDNI(dni) {
    const statusElement = document.getElementById('dni-status');
    const errorElement = document.getElementById('dni-error');

    if (dni.length !== 8) {
        statusElement.textContent = '';
        isUpdateMode = false;
        existingUserData = null;
        return true;
    }

    statusElement.textContent = 'Validando DNI...';
    statusElement.className = 'dni-status validando';

    const result = await consultarDNI(dni);

    if (!result) {
        statusElement.textContent = 'Error al validar DNI';
        statusElement.className = 'dni-status error';
        return true;
    }

    if (!result.success && result.error === 'DNI_ALREADY_EXISTS') {
        statusElement.innerHTML = `
            <div>${result.message}</div>
            <div style="margin-top: 5px;">
                <button id="btn-cargar-datos" onclick="cargarDatosExistentes()" style="background: #007bff; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; margin-right: 5px;">
                    Cargar Datos
                </button>
                <button id="btn-limpiar-formulario" onclick="limpiarFormulario()" style="background: #28a745; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer;">
                    Nuevo Registro
                </button>
            </div>
        `;
        statusElement.className = 'dni-status duplicado';
        errorElement.textContent = `Registrado como: ${result.existingData.nombres} ${result.existingData.apellidos}`;
        existingUserData = result.existingData;
        return false;
    }

    if (result.success) {
        statusElement.textContent = 'DNI disponible';
        statusElement.className = 'dni-status disponible';
        errorElement.textContent = '';
        isUpdateMode = false;
        existingUserData = null;
        return true;
    }

    statusElement.textContent = 'Error al validar DNI';
    statusElement.className = 'dni-status error';
    console.error('Error al validar DNI:', result);
    return true;
}

// Cargar datos existentes en el formulario
function cargarDatosExistentes() {
    if (!existingUserData) return;
    
    const data = existingUserData;
    
    // Llenar campos básicos
    document.getElementById('nombres').value = data.nombres || '';
    document.getElementById('apellido_paterno').value = data.apellido_paterno || '';
    document.getElementById('apellido_materno').value = data.apellido_materno || '';
    
    // Seleccionar sexo
    const sexoRadio = document.querySelector(`input[name="sexo"][value="${data.sexo}"]`);
    if (sexoRadio) {
        sexoRadio.checked = true;
        actualizarTallas(); // Actualizar las opciones de tallas
    }
    
    // Otros campos (arreglar formato de fecha)
    if (data.fecha_nacimiento) {
        
        let fechaNacimiento = data.fecha_nacimiento;
        
        if (fechaNacimiento instanceof Date) {
            // Si es objeto Date
            fechaNacimiento = fechaNacimiento.toISOString().split('T')[0];
        } else if (typeof fechaNacimiento === 'string') {
            // Limpiar la fecha
            fechaNacimiento = fechaNacimiento.trim();
            
            if (fechaNacimiento.includes('/')) {
                // Formato DD/MM/YYYY a YYYY-MM-DD
                const partes = fechaNacimiento.split('/');
                if (partes.length === 3) {
                    fechaNacimiento = `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
                }
            } else if (fechaNacimiento.match(/^\d{4}-\d{2}-\d{2}$/)) {
                // Ya está en formato YYYY-MM-DD, no hacer nada
                fechaNacimiento = fechaNacimiento;
            } else if (fechaNacimiento.includes('T')) {
                // Formato ISO con tiempo, tomar solo la fecha
                fechaNacimiento = fechaNacimiento.split('T')[0];
            }
        }
        
        document.getElementById('fecha_nacimiento').value = fechaNacimiento;
    }
    document.getElementById('email').value = data.email || '';
    document.getElementById('celular').value = data.celular || '';
    document.getElementById('direccion').value = data.direccion || '';
    document.getElementById('ruc').value = data.ruc || '';
    
    // Campos laborales
    document.getElementById('sede').value = data.sede || '';
    document.getElementById('turno').value = data.turno || '';
    document.getElementById('area').value = data.area || '';
    document.getElementById('cargo').value = data.cargo || '';
    
    // Datos bancarios
    document.getElementById('banco').value = data.banco || '';
    document.getElementById('cci').value = data.cci || '';
    
    // Padre de familia
    const padreRadio = document.querySelector(`input[name="padre_familia"][value="${data.padre_familia}"]`);
    if (padreRadio) padreRadio.checked = true;
    
    // Actualizar variables de RUC si están disponibles
    if (data.ruc_activo) rucActivo = data.ruc_activo;
    if (data.ruc_habido) rucHabido = data.ruc_habido;
    
    // Tallas (después de actualizar las opciones)
    setTimeout(() => {
        document.getElementById('talla_casaca').value = data.talla_casaca || '';
        document.getElementById('talla_pantalon').value = data.talla_pantalon || '';
        
        // IMPORTANTE: Guardar datos originales DESPUÉS de que todo esté cargado
        let fechaParaComparar = data.fecha_nacimiento;
        if (fechaParaComparar instanceof Date) {
            fechaParaComparar = fechaParaComparar.toISOString().split('T')[0];
        } else if (typeof fechaParaComparar === 'string') {
            fechaParaComparar = fechaParaComparar.trim();
            if (fechaParaComparar.includes('/')) {
                const partes = fechaParaComparar.split('/');
                if (partes.length === 3) {
                    fechaParaComparar = `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
                }
            } else if (fechaParaComparar.includes('T')) {
                fechaParaComparar = fechaParaComparar.split('T')[0];
            }
        }
        
        originalFormData = {
            nombres: data.nombres || '',
            apellido_paterno: data.apellido_paterno || '',
            apellido_materno: data.apellido_materno || '',
            sexo: data.sexo || '',
            fecha_nacimiento: fechaParaComparar || '',
            email: data.email || '',
            celular: data.celular || '',
            direccion: data.direccion || '',
            ruc: data.ruc || '',
            sede: data.sede || '',
            turno: data.turno || '',
            area: data.area || '',
            cargo: data.cargo || '',
            banco: data.banco || '',
            cci: data.cci || '',
            padre_familia: data.padre_familia || 'No',
            talla_casaca: data.talla_casaca || '',
            talla_pantalon: data.talla_pantalon || ''
        };
        
    }, 200); // Aumentar tiempo para asegurar que todo esté cargado
    
    // Cambiar a modo actualización
    isUpdateMode = true;
    
    // Actualizar el estado visual
    const statusElement = document.getElementById('dni-status');
    statusElement.innerHTML = 'Modo actualización - Puede modificar y enviar';
    statusElement.className = 'dni-status actualizando';
    
    // Cambiar texto del botón
    const submitBtn = document.querySelector('button[type="submit"]');
    submitBtn.textContent = 'Actualizar Registro';
    
    // Actualizar sección de foto
    const photoTitle = document.getElementById('photo-section-title');
    if (photoTitle) {
        photoTitle.innerHTML = 'Actualizar Foto <span class="text-sm text-gray-500 font-normal">(Opcional)</span>';
    }

    // IMPORTANTE: Quitar el atributo required del campo foto
    const fotoInput = document.getElementById('foto');
    if (fotoInput) {
        fotoInput.removeAttribute('required');
    }

    // Actualizar textos del área de carga
    const uploadText = document.getElementById('upload-text');
    if (uploadText) {
        uploadText.textContent = 'Haz clic para cambiar tu foto';
    }

    const uploadHint = document.getElementById('upload-hint');
    if (uploadHint) {
        uploadHint.innerHTML = 'Opcional - Solo si deseas actualizar la foto actual';
    }

    // Mostrar foto existente si existe
    if (data.fotoUrl && data.fotoUrl.trim() !== '') {
        const existingPhotoContainer = document.getElementById('existing-photo-container');
        const currentPhoto = document.getElementById('current-photo');

        if (existingPhotoContainer && currentPhoto) {
            existingPhotoContainer.classList.remove('hidden');

            // Manejar URLs de Google Drive
            if (data.fotoUrl.includes('drive.google.com')) {
                const fileId = data.fotoUrl.match(/\/file\/d\/([a-zA-Z0-9-_]+)/);
                if (fileId) {
                    currentPhoto.src = `https://drive.google.com/thumbnail?id=${fileId[1]}&sz=w400`;
                }
            } else {
                currentPhoto.src = data.fotoUrl;
            }

            // Manejar error de carga de imagen
            currentPhoto.onerror = function() {
                this.style.display = 'none';
                const errorMsg = document.createElement('p');
                errorMsg.className = 'text-sm text-gray-500 text-center';
                errorMsg.textContent = 'No se pudo cargar la imagen actual';
                this.parentNode.insertBefore(errorMsg, this.nextSibling);
            };
        }
    }
    
    mostrarMensaje('exito', 'Datos cargados para actualización. Puede modificar los campos necesarios.');
}

// Reset completo del formulario y de las variables de modo. Usada por:
// - limpiarFormulario() (botón "Nuevo Registro" cuando el DNI ya existe)
// - procesarEnvioFormulario() (tras envío exitoso)
// - handler btn-volver-verificacion (volver a la pantalla inicial)
function resetFormulario() {
    document.getElementById('registroForm').reset();
    document.getElementById('preview').style.display = 'none';
    document.getElementById('ruc-info').style.display = 'none';

    const dniStatus = document.getElementById('dni-status');
    if (dniStatus) {
        dniStatus.textContent = '';
        dniStatus.className = 'dni-status';
    }
    const dniError = document.getElementById('dni-error');
    if (dniError) dniError.textContent = '';

    ocultarImagenExistente();

    isUpdateMode = false;
    existingUserData = null;
    originalFormData = {};
    rucActivo = 'No';
    rucHabido = 'No';

    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Enviar Formulario';

    const fotoLabel = document.querySelector('label[for="foto"]');
    if (fotoLabel) fotoLabel.innerHTML = 'Foto personal para credencial <span class="required"></span>';

    const fotoInput = document.getElementById('foto');
    if (fotoInput) fotoInput.setAttribute('required', '');

    const uploadText = document.getElementById('upload-text');
    if (uploadText) uploadText.textContent = 'Haz clic para subir tu foto';

    const uploadHint = document.getElementById('upload-hint');
    if (uploadHint) uploadHint.textContent = 'Formatos aceptados: JPG, PNG (Máx. 2 MB)';
}

// Limpiar formulario y salir del modo actualización
function limpiarFormulario() {
    resetFormulario();
    mostrarMensaje('exito', 'Formulario limpiado. Puede crear un nuevo registro.');
}

// Consultar API de RUC
async function consultarRUC(ruc) {
    const loadingElement = document.getElementById('ruc-loading');
    const errorElement = document.getElementById('ruc-error');
    const infoElement = document.getElementById('ruc-info');
    const activoElement = document.getElementById('ruc-activo');
    const habidoElement = document.getElementById('ruc-habido');
    
    loadingElement.style.display = 'block';
    errorElement.textContent = '';
    infoElement.style.display = 'none';
    
    try {
        const response = await fetch(`${RUC_API_URL}/${ruc}`);
        const data = await response.json();
        
        if (data.razonSocial) {
            rucActivo = data.estado === 'ACTIVO' ? 'Si' : 'No';
            rucHabido = data.condicion === 'HABIDO' ? 'Si' : 'No';
            
            infoElement.style.display = 'block';
            activoElement.innerHTML = `<strong>Activo:</strong> ${rucActivo}`;
            habidoElement.innerHTML = `<strong>Habido:</strong> ${rucHabido}`;
        } else {
            errorElement.textContent = 'No se encontraron datos para este RUC';
        }
    } catch (error) {
        errorElement.textContent = 'Error al consultar el RUC. Intente nuevamente.';
        console.error('Error al consultar RUC:', error);
    } finally {
        loadingElement.style.display = 'none';
    }
}

// Enviar datos al backend propio, que a su vez los reenvía al Apps Script.
// A diferencia del antiguo mode:'no-cors', ahora sí podemos leer la respuesta real.
async function enviarFormulario(formData) {
    try {
        const response = await fetch(SUBMIT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            return { success: false, error: data.error || `HTTP ${response.status}` };
        }
        // El Apps Script devuelve { success, ... } — respetamos su shape si viene.
        if (typeof data.success === 'boolean') return data;
        return { success: true, ...data };
    } catch (error) {
        console.error('Error enviando formulario:', error);
        return { success: false, error: 'Error de conexión' };
    }
}

// Función para crear y mostrar modal de confirmación de tallas
function mostrarModalConfirmacionTallas(tallaCasaca, tallaPantalon, callback) {
    // Determinar si es actualización o nuevo registro
    const esActualizacion = isUpdateMode;
    const titulo = esActualizacion ? 'Confirmar Actualización de Tallas' : 'Confirmar Tallas Seleccionadas';
    const textoBoton = esActualizacion ? 'Confirmar y Actualizar' : 'Confirmar y Enviar';
    
    // Determinar el sexo para mostrar DAMAS o VARONES
    const sexo = document.querySelector('input[name="sexo"]:checked')?.value;
    const tipoTalla = sexo === 'F' ? 'DAMAS' : 'VARONES';
    
    // Crear modal
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>${titulo}</h3>
                <div class="tipo-talla-badge">${tipoTalla}</div>
            </div>
            <div class="modal-body">
                <p>Por favor, confirme las tallas seleccionadas para <strong>${tipoTalla}</strong>:</p>
                <div class="tallas-confirmacion">
                    <div class="talla-item">
                        <strong>Talla de Casaca:</strong>
                        <span class="talla-value">${tallaCasaca.replace('C-', '')}</span>
                    </div>
                    <div class="talla-item">
                        <strong>Talla de Pantalón:</strong>
                        <span class="talla-value">${tallaPantalon.replace('P-', '')}</span>
                    </div>
                </div>
                <p class="modal-note">Es importante verificar sus tallas antes de confirmar</p>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn-modal btn-cancel" onclick="cerrarModalTallas()">Modificar</button>
                <button type="button" class="btn-modal btn-confirm" id="btn-confirmar-tallas">${textoBoton}</button>
            </div>
        </div>
    `;
    
    // Estilos del modal definidos en styles.css (.modal-overlay, .modal-content, etc.)

    // Agregar modal al DOM
    document.body.appendChild(modal);
    
    // Configurar botón de confirmación
    const btnConfirmar = document.getElementById('btn-confirmar-tallas');
    
    btnConfirmar.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        // Eliminar modal del DOM inmediatamente
        modal.remove();
        
        // Ejecutar callback
        if (callback) {
            callback();
        }
    });
}

// Función para cerrar el modal de tallas
function cerrarModalTallas() {
    const modal = document.querySelector('.modal-overlay');
    if (modal) {
        modal.remove();
    }
}

// Manejador de envío del formulario
document.getElementById('registroForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    
    // 1. Mostrar confirmación si es modo actualización
    if (isUpdateMode) {
        const confirmacion = await showConfirmationModal();
        
        if (!confirmacion) {
            mostrarMensaje('info', 'Actualización cancelada. Puede revisar los datos antes de enviar.');
            return;
        }
    }
    
    // 2. Validaciones
    let isValid = true;
    
    // Validar DNI (8 dígitos)
    const dni = document.getElementById('dni');
    if (dni.value.length !== 8) {
        document.getElementById('dni-error').textContent = 'El DNI debe tener 8 dígitos';
        isValid = false;
    } else if (!isUpdateMode) {
        // Solo validar duplicados si NO estamos en modo actualización
        const dniDisponible = await validarDNI(dni.value);
        if (!dniDisponible) {
            mostrarMensaje('error', 'No se puede registrar: DNI ya existe en el sistema');
            isValid = false;
        }
    }
    
    // Validar celular (9 dígitos)
    const celular = document.getElementById('celular');
    if (celular.value.length !== 9) {
        document.getElementById('celular-error').textContent = 'El celular debe tener 9 dígitos';
        isValid = false;
    }
    
    // Validar RUC (11 dígitos)
    const ruc = document.getElementById('ruc');
    if (ruc.value.length !== 11) {
        document.getElementById('ruc-error').textContent = 'El RUC debe tener 11 dígitos';
        isValid = false;
    }
    
    // Validar CCI (20 dígitos)
    const cci = document.getElementById('cci');
    if (cci.value.length !== 20) {
        document.getElementById('cci-error').textContent = 'El CCI debe tener 20 dígitos';
        isValid = false;
    }
    
    // Validar cargo (obligatorio)
    const cargo = document.getElementById('cargo').value;
    if (!cargo || cargo.trim() === '') {
        mostrarMensaje('error', 'Por favor, ingrese su cargo');
        isValid = false;
    }
    
    // Validar foto (obligatorio solo para nuevo registro)
    const fotoInput = document.getElementById('foto');
    if (!isUpdateMode && !fotoInput.files[0]) {
        mostrarMensaje('error', 'Por favor, seleccione una foto para el nuevo registro');
        isValid = false;
    } else if (isUpdateMode && fotoInput.files[0]) {
        // Mostrar mensaje informativo si está actualizando la foto
    }
    
    if (!isValid) return;
    
    // Obtener tallas seleccionadas
    const tallaCasaca = document.getElementById('talla_casaca').value;
    const tallaPantalon = document.getElementById('talla_pantalon').value;
    
    // Validar que las tallas estén seleccionadas
    if (!tallaCasaca || !tallaPantalon) {
        mostrarMensaje('error', 'Por favor, seleccione las tallas de casaca y pantalón');
        return;
    }
    
    // Mostrar modal de confirmación de tallas
    const form = this;
    mostrarModalConfirmacionTallas(tallaCasaca, tallaPantalon, async function() {
        await procesarEnvioFormulario(form);
    });
});

// Función separada para procesar el envío del formulario
async function procesarEnvioFormulario(form) {
    // 2. Preparar envío
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';
    
    try {
        // Procesar imagen
        const fotoInput = document.getElementById('foto');
        const imagenData = await procesarImagen(fotoInput.files[0]);
        
        // Obtener valores de los campos
        const dni = document.getElementById('dni');
        const celular = document.getElementById('celular');
        const ruc = document.getElementById('ruc');
        const cci = document.getElementById('cci');
        const cargo = document.getElementById('cargo').value;
        
        // Construir objeto con TODOS los campos
        const formData = {
            nombres: document.getElementById('nombres').value,
            apellido_paterno: document.getElementById('apellido_paterno').value,
            apellido_materno: document.getElementById('apellido_materno').value,
            sexo: document.querySelector('input[name="sexo"]:checked')?.value || '',
            dni: dni.value,
            fecha_nacimiento: document.getElementById('fecha_nacimiento').value,
            email: document.getElementById('email').value,
            celular: celular.value,
            direccion: document.getElementById('direccion').value,
            ruc: ruc.value,
            ruc_activo: rucActivo,
            ruc_habido: rucHabido,
            sede: document.getElementById('sede').value || '', // Campo de texto
            turno: document.getElementById('turno').value || '', // Campo de texto
            area: document.getElementById('area').value || '', // Campo de texto
            cargo: cargo,
            banco: document.getElementById('banco').value,
            cci: cci.value,
            padre_familia: document.querySelector('input[name="padre_familia"]:checked')?.value || 'No',
            talla_casaca: document.getElementById('talla_casaca').value,
            talla_pantalon: document.getElementById('talla_pantalon').value,
            fotoBase64: imagenData?.base64 || '',
            fotoType: imagenData?.type || '',
            isUpdate: isUpdateMode // Flag para indicar si es actualización
        };

        
        // 3. Enviar datos
        const resultado = await enviarFormulario(formData);
        
        if (resultado.success) {
            const wasUpdateMode = isUpdateMode;
            const mensajeExito = wasUpdateMode ? 'Datos actualizados exitosamente' : 'Registro completado exitosamente';
            mostrarMensaje('exito', mensajeExito);

            resetFormulario();

            if (wasUpdateMode) {
                setTimeout(() => {
                    document.getElementById('dni-verification-screen').style.display = 'block';
                    document.getElementById('registroForm').style.display = 'none';
                }, 2000);
            }
        } else {
            throw new Error(resultado.error || 'Error al enviar el formulario');
        }
    } catch (error) {
        console.error('Error en el envío:', error);
        mostrarMensaje('error', 'Error: ' + error.message);
    } finally {
        submitBtn.disabled = false;
        // resetFormulario() ya dejó el texto por defecto; si seguimos en update mode (fallo), reponerlo
        submitBtn.textContent = isUpdateMode ? 'Actualizar Registro' : 'Enviar Formulario';
    }
}

// Event listeners para los campos de entrada
document.getElementById('dni').addEventListener('input', function() {
    validarSoloNumeros(this);
    validarLongitud(this, 8);
    
    // Validar DNI duplicado cuando tenga 8 dígitos
    if (this.value.length === 8) {
        validarDNI(this.value);
    } else {
        document.getElementById('dni-status').textContent = '';
        document.getElementById('dni-status').className = 'dni-status';
    }
});

document.getElementById('celular').addEventListener('input', function() {
    validarSoloNumeros(this);
    validarLongitud(this, 9);
});

document.getElementById('ruc').addEventListener('input', function() {
    validarSoloNumeros(this);
    validarLongitud(this, 11);
    if (this.value.length === 11) consultarRUC(this.value);
});

document.getElementById('cci').addEventListener('input', function() {
    validarSoloNumeros(this);
    validarLongitud(this, 20);
});

document.getElementById('foto').addEventListener('change', function() {
    previewImage(this);
});

// ==================== FUNCIONES PARA DETECTAR CAMBIOS Y MODAL ====================

// Mapeo de nombres amigables para los campos
const fieldLabels = {
    nombres: 'Nombres',
    apellido_paterno: 'Apellido Paterno',
    apellido_materno: 'Apellido Materno',
    sexo: 'Sexo',
    fecha_nacimiento: 'Fecha de Nacimiento',
    email: 'Email',
    celular: 'Celular',
    direccion: 'Dirección',
    ruc: 'RUC',
    sede: 'Sede',
    turno: 'Turno',
    area: 'Área',
    cargo: 'Cargo',
    banco: 'Banco',
    cci: 'CCI',
    padre_familia: 'Padre de Familia',
    talla_casaca: 'Talla Casaca',
    talla_pantalon: 'Talla Pantalón'
};

// Función para obtener datos actuales del formulario
function getCurrentFormData() {
    return {
        nombres: document.getElementById('nombres').value,
        apellido_paterno: document.getElementById('apellido_paterno').value,
        apellido_materno: document.getElementById('apellido_materno').value,
        sexo: document.querySelector('input[name="sexo"]:checked')?.value || '',
        fecha_nacimiento: document.getElementById('fecha_nacimiento').value,
        email: document.getElementById('email').value,
        celular: document.getElementById('celular').value,
        direccion: document.getElementById('direccion').value,
        ruc: document.getElementById('ruc').value,
        sede: document.getElementById('sede').value,
        turno: document.getElementById('turno').value,
        area: document.getElementById('area').value,
        cargo: document.getElementById('cargo').value,
        banco: document.getElementById('banco').value,
        cci: document.getElementById('cci').value,
        padre_familia: document.querySelector('input[name="padre_familia"]:checked')?.value || 'No',
        talla_casaca: document.getElementById('talla_casaca').value,
        talla_pantalon: document.getElementById('talla_pantalon').value
    };
}

// Función para normalizar valores para comparación
function normalizeValue(value) {
    if (value === null || value === undefined) return '';
    return value.toString().trim();
}

// Función para detectar cambios
function detectChanges() {
    const currentData = getCurrentFormData();
    const changes = [];
    
    for (const field in originalFormData) {
        const originalValue = normalizeValue(originalFormData[field]);
        const currentValue = normalizeValue(currentData[field]);
        
        // Solo agregar si realmente son diferentes
        if (originalValue !== currentValue) {
            changes.push({
                field: field,
                label: fieldLabels[field] || field,
                oldValue: originalValue,
                newValue: currentValue
            });
        }
    }
    
    return changes;
}

// Función para mostrar el modal de confirmación
function showConfirmationModal() {
    return new Promise((resolve) => {
        const changes = detectChanges();
        const fotoInput = document.getElementById('foto');
        const hasNewPhoto = fotoInput.files[0];
        
        // Si hay foto nueva, agregar a los cambios
        if (hasNewPhoto) {
            changes.push({
                field: 'foto',
                label: 'Foto',
                oldValue: 'Foto actual',
                newValue: 'Nueva foto seleccionada'
            });
        }
        
        if (changes.length === 0) {
            mostrarMensaje('info', 'No se detectaron cambios en los datos');
            resolve(false);
            return;
        }
        
        // Llenar el modal con los cambios (filtrar cambios válidos)
        const validChanges = changes.filter(change => change.oldValue !== change.newValue);
        
        if (validChanges.length === 0) {
            mostrarMensaje('info', 'No se detectaron cambios válidos en los datos');
            resolve(false);
            return;
        }
        
        const changesList = document.getElementById('changes-list');
        changesList.innerHTML = validChanges.map(change => `
            <div class="change-item">
                <div class="field-name">${change.label}:</div>
                <div class="change-values">
                    <span class="old-value">${change.oldValue || 'Sin datos'}</span>
                    <span class="new-value">${change.newValue || 'Sin datos'}</span>
                </div>
            </div>
        `).join('');
        
        // Mostrar fecha original
        document.getElementById('original-date').textContent = 
            new Date(existingUserData.fechaRegistro).toLocaleDateString();
        
        // Mostrar modal
        document.getElementById('confirmation-modal').style.display = 'flex';
        
        // Event listeners
        document.getElementById('cancel-update').onclick = () => {
            document.getElementById('confirmation-modal').style.display = 'none';
            resolve(false);
        };
        
        document.getElementById('confirm-update').onclick = () => {
            document.getElementById('confirmation-modal').style.display = 'none';
            resolve(true);
        };
        
        // Cerrar con ESC
        const handleKeyPress = (e) => {
            if (e.key === 'Escape') {
                document.getElementById('confirmation-modal').style.display = 'none';
                document.removeEventListener('keydown', handleKeyPress);
                resolve(false);
            }
        };
        document.addEventListener('keydown', handleKeyPress);
    });
}

// ==================== FUNCIONALIDAD PANTALLA DE VERIFICACIÓN ====================

// Variables para la pantalla de verificación
let currentUserData = null;

// Convierte una URL de Google Drive en un thumbnail embebible vía <img>.
// Evita iframes (Drive bloquea por CSP frame-ancestors). El thumbnail
// se sirve como imagen estática cross-origin, así que funciona.
function convertToPreviewUrl(url) {
    if (!url) return url;
    if (url.includes('drive.google.com')) {
        const m = url.match(/[-\w]{25,}/); // id de Drive embebido en la URL
        if (m) return `https://drive.google.com/thumbnail?id=${m[0]}&sz=w400`;
    }
    return url;
}

// Función para verificar DNI en pantalla inicial
async function verificarDNIInicial(dni) {
    const statusElement = document.getElementById('verification-status');

    if (dni.length !== 8) {
        statusElement.innerHTML = '<div style="color: #e74c3c;">El DNI debe tener 8 dígitos</div>';
        return null;
    }

    statusElement.innerHTML = '<div style="color: #3498db;">Verificando DNI...</div>';

    const result = await consultarDNI(dni);

    if (result === null) {
        statusElement.innerHTML = '<div style="color: #e74c3c;">Error o timeout al verificar DNI</div>';
        return null;
    }

    statusElement.innerHTML = '';
    return result;
}

// Función para mostrar información del usuario existente
function mostrarUsuarioExistente(userData) {
    currentUserData = userData;
    const userDetails = document.getElementById('user-details');
    const userPhoto = document.getElementById('existing-photo');
    
    // Limpiar placeholders y botones anteriores
    const existingPlaceholders = document.querySelectorAll('.photo-placeholder, .photo-button');
    existingPlaceholders.forEach(element => element.remove());
    
    userDetails.innerHTML = `
        <div><strong>Nombre:</strong> ${userData.nombres}</div>
        <div><strong>Apellidos:</strong> ${userData.apellido_paterno} ${userData.apellido_materno}</div>
        <div><strong>DNI:</strong> ${userData.dni}</div>
        <div><strong>Email:</strong> ${userData.email || 'No registrado'}</div>
        <div><strong>Celular:</strong> ${userData.celular || 'No registrado'}</div>
        <div><strong>Fecha de Registro:</strong> ${new Date(userData.fechaRegistro).toLocaleDateString()}</div>
    `;
    
    // Mostrar foto si existe
    if (userData.fotoUrl && userData.fotoUrl.trim() !== '') {
        // Unificado: <img> con thumbnail (funciona tanto para Drive como para URLs normales).
        // Antes usábamos iframe para Drive, pero Drive bloquea con CSP frame-ancestors.
        userPhoto.src = convertToPreviewUrl(userData.fotoUrl);
        userPhoto.setAttribute('referrerpolicy', 'no-referrer');
        userPhoto.onload = function() { this.classList.remove('hidden'); this.style.display = 'block'; };
        userPhoto.onerror = function() {
            this.style.display = 'none';
            const placeholder = document.createElement('div');
            placeholder.className = 'photo-placeholder';
            placeholder.style.cssText = 'text-align:center;padding:20px;border:2px dashed #d1d5db;border-radius:8px;background:#f9fafb;cursor:pointer;color:#6b7280;';
            placeholder.innerHTML = '📷 Foto no disponible<br><small>Click para abrir</small>';
            placeholder.onclick = () => window.open(userData.fotoUrl, '_blank');
            document.querySelector('.user-photo').appendChild(placeholder);
        };
    } else {
        userPhoto.style.display = 'none';
        
        // Mostrar placeholder si no hay foto
        const placeholder = document.createElement('div');
        placeholder.className = 'photo-placeholder';
        placeholder.innerHTML = 'Sin foto registrada';
        placeholder.style.cssText = `
            width: 150px; 
            height: 150px; 
            border: 2px dashed #ddd; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            color: #666; 
            border-radius: 8px;
            background: #f8f9fa;
            margin: 15px auto;
        `;
        document.querySelector('.user-photo').appendChild(placeholder);
    }
    
    document.getElementById('verification-result').style.display = 'block';
    document.getElementById('new-user-result').style.display = 'none';
}

// Función para mostrar usuario nuevo
function mostrarUsuarioNuevo() {
    currentUserData = null;
    document.getElementById('verification-result').style.display = 'none';
    document.getElementById('new-user-result').style.display = 'block';
}

// Event listeners para la pantalla de verificación

// Validar solo números en input de verificación
document.getElementById('dni-verificacion').addEventListener('input', function() {
    this.value = this.value.replace(/[^0-9]/g, '');
    if (this.value.length > 8) {
        this.value = this.value.slice(0, 8);
    }
});

// Verificar DNI al presionar Enter
document.getElementById('dni-verificacion').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        document.getElementById('btn-verificar-dni').click();
    }
});

// Botón verificar DNI
document.getElementById('btn-verificar-dni').addEventListener('click', async function() {
    const dni = document.getElementById('dni-verificacion').value;
    
    if (dni.length !== 8) {
        document.getElementById('verification-status').innerHTML = '<div style="color: #e74c3c;">Por favor ingrese 8 dígitos</div>';
        return;
    }
    
    const result = await verificarDNIInicial(dni);
    
    if (result && !result.success && result.error === 'DNI_ALREADY_EXISTS') {
        mostrarUsuarioExistente(result.existingData);
    } else if (result && result.success) {
        mostrarUsuarioNuevo();
    } else {
        document.getElementById('verification-status').innerHTML = '<div style="color: #e74c3c;">Error al verificar DNI</div>';
    }
});

// Botón actualizar datos
document.getElementById('btn-actualizar-datos').addEventListener('click', function() {
    if (!currentUserData) return;
    
    // Cambiar a modo actualización
    isUpdateMode = true;
    existingUserData = currentUserData;
    
    // Mostrar formulario
    document.getElementById('dni-verification-screen').style.display = 'none';
    document.getElementById('registroForm').style.display = 'block';
    
    // Prellenar DNI
    document.getElementById('dni').value = currentUserData.dni;
    
    // Cargar todos los datos
    cargarDatosExistentes();
});

// Botón ver datos (solo lectura)
document.getElementById('btn-ver-datos').addEventListener('click', function() {
    if (!currentUserData) return;
    
    // Cambiar a modo solo lectura
    isUpdateMode = false;
    existingUserData = currentUserData;
    
    // Mostrar formulario
    document.getElementById('dni-verification-screen').style.display = 'none';
    document.getElementById('registroForm').style.display = 'block';
    
    // Prellenar DNI
    document.getElementById('dni').value = currentUserData.dni;
    
    // Cargar todos los datos
    cargarDatosExistentes();
    
    // Deshabilitar todos los campos
    const inputs = document.querySelectorAll('#registroForm input, #registroForm select, #registroForm textarea');
    inputs.forEach(input => input.disabled = true);
    
    // Ocultar botón de envío
    document.querySelector('button[type="submit"]').style.display = 'none';
    
    mostrarMensaje('exito', 'Datos cargados en modo solo lectura.');
});

// Botón nuevo registro
document.getElementById('btn-nuevo-registro').addEventListener('click', function() {
    // Cambiar a modo registro nuevo
    isUpdateMode = false;
    existingUserData = null;
    currentUserData = null;
    
    // Mostrar formulario vacío
    document.getElementById('dni-verification-screen').style.display = 'none';
    document.getElementById('registroForm').style.display = 'block';
    
    // Prellenar el DNI verificado
    document.getElementById('dni').value = document.getElementById('dni-verificacion').value;
    
    // Asegurar que la foto sea obligatoria para nuevo registro
    const fotoInput = document.getElementById('foto');
    if (fotoInput) {
        fotoInput.setAttribute('required', '');
    }
    
    mostrarMensaje('exito', 'Puede proceder con el registro de nuevo usuario.');
});

// Botón volver a verificación
document.getElementById('btn-volver-verificacion').addEventListener('click', function() {
    resetFormulario();

    // Habilitar todos los campos
    const inputs = document.querySelectorAll('#registroForm input, #registroForm select, #registroForm textarea');
    inputs.forEach(input => input.disabled = false);

    // Mostrar botón de envío
    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.style.display = 'inline-block';

    // currentUserData no lo toca resetFormulario (es específico de esta pantalla)
    currentUserData = null;

    // Limpiar pantalla de verificación
    document.getElementById('dni-verificacion').value = '';
    document.getElementById('verification-status').innerHTML = '';
    document.getElementById('verification-result').style.display = 'none';
    document.getElementById('new-user-result').style.display = 'none';

    // Limpiar elementos de foto
    document.querySelectorAll('.photo-placeholder, .photo-button').forEach(el => el.remove());

    // Mostrar pantalla de verificación
    document.getElementById('dni-verification-screen').style.display = 'block';
    document.getElementById('registroForm').style.display = 'none';
});
