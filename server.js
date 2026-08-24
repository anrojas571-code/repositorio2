require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { Resend } = require('resend'); // SDK Oficial de Resend

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// Credenciales del administrador inicial
const ADMIN_DEFAULT = {
    usuario: 'Admin',
    clave: 'An12345*'
};

// Función auxiliar para obtener la API Key de Resend desde process.env
function obtenerApiKeyResend() {
    const rawPass = (
        process.env.RESEND_API_KEY ||
        process.env.EMAIL_PASS ||
        process.env.GMAIL_PASS ||
        process.env.SMTP_PASS ||
        process.env.MAIL_PASS ||
        process.env.USER_PASS ||
        ''
    ).trim();

    return rawPass.replace(/\s+/g, '');
}

// Función auxiliar para registrar entradas de auditoría organizadas en carpetas
function crearRegistroAuditoria(tipo, carpeta, cambios, editor = 'Usuario', resumen = '') {
    const ahora = new Date();
    const fecha = ahora.toLocaleDateString('es-ES', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
    const hora = ahora.toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    return {
        id: 'aud_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        tipo: tipo || 'perfil',
        carpeta: carpeta || '📁 Registro de Modificación',
        fecha: `${fecha} ${hora}`,
        editor: editor,
        resumen: resumen || `${cambios ? cambios.length : 0} campo(s) modificado(s)`,
        cambios: Array.isArray(cambios) ? cambios : []
    };
}

// Función auxiliar para enviar el correo de recuperación mediante la API HTTP de Resend
async function enviarCorreoRecuperacion(correoDestino, codigo) {
    console.log(`\n==================================================`);
    console.log(`[CÓDIGO DE RECUPERACIÓN GENERADO]`);
    console.log(`Para: ${correoDestino}`);
    console.log(`Código OTP (6 dígitos): ${codigo}`);
    console.log(`Válido durante: 15 minutos (900 segundos)`);
    console.log(`==================================================\n`);

    const apiKey = obtenerApiKeyResend();

    if (!apiKey) {
        console.warn(`[EMAIL ADVERTENCIA] No se envió el correo porque falta RESEND_API_KEY / EMAIL_PASS en Render.`);
        return { enviado: false, motivo: 'no_credentials', codigo };
    }

    const resend = new Resend(apiKey);

    // Dirección del remitente configurada con tu dominio personalizado verificado
    let remitenteFinal = process.env.EMAIL_FROM || 'Sistema <soporte@misistema.space>';

    console.log(`[EMAIL DISPARANDO VIA API HTTP] Enviando a ${correoDestino} desde ${remitenteFinal}...`);

    try {
        const data = await resend.emails.send({
            from: remitenteFinal,
            to: correoDestino,
            subject: '🔒 Código de Recuperación de Contraseña (6 dígitos)',
            text: `Tu código de recuperación es: ${codigo}. Este código vence en 15 minutos.\nRevisa también tu carpeta de Spam / Correo No Deseado.`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
                    <div style="text-align: center; margin-bottom: 16px;">
                        <h2 style="color: #4f46e5; font-size: 22px; margin: 0;">Recuperación de Contraseña</h2>
                        <p style="color: #64748b; font-size: 13px; margin-top: 4px;">Código de seguridad temporal</p>
                    </div>
                    <p style="color: #334155; font-size: 14px; line-height: 1.5;">Has solicitado restablecer tu contraseña. Utiliza el siguiente código numérico de 6 dígitos:</p>
                    <div style="background: #f8fafc; border: 2px dashed #4f46e5; border-radius: 12px; padding: 18px; text-align: center; margin: 20px 0;">
                        <span style="font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #0f172a;">${codigo}</span>
                    </div>
                    <p style="color: #ef4444; font-size: 13px; font-weight: 700; text-align: center; margin-bottom: 8px;">⏰ Este código caducará en exactamente 15 minutos.</p>
                    <p style="color: #94a3b8; font-size: 12px; text-align: center;">Si no fue solicitado por ti, puedes ignorar este mensaje o revisar la carpeta de <strong>Spam / Correo No Deseado</strong>.</p>
                </div>
            `
        });

        if (data.error) {
            console.error('[EMAIL ERROR RESEND API]', data.error);
            throw new Error(data.error.message);
        }

        console.log(`[EMAIL EXITO] ✅ Correo enviado exitosamente a ${correoDestino} (ID: ${data.data.id})`);
        return { enviado: true, messageId: data.data.id };
    } catch (err) {
        console.error('[EMAIL ERROR] ❌ Falló el envío del correo electrónico:', err.message);
        throw err;
    }
}

// Configuración de PostgreSQL si DATABASE_URL existe
let pool = null;
if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });
    console.log('Conectado a PostgreSQL mediante DATABASE_URL');

    // Crear tablas e insertar admin por defecto si no existe
    const initDb = async () => {
        try {
            // Tabla de usuarios
            await pool.query(`
                CREATE TABLE IF NOT EXISTS usuarios (
                    usuario VARCHAR(255) PRIMARY KEY,
                    clave TEXT NOT NULL,
                    correo TEXT,
                    telefono TEXT,
                    direccion TEXT,
                    fecha_registro TEXT,
                    contador_modificaciones INT DEFAULT 0,
                    rol VARCHAR(50) DEFAULT 'Cliente',
                    estado VARCHAR(50) DEFAULT 'Activo',
                    historial_ediciones JSONB DEFAULT '[]'::jsonb,
                    codigo_recuperacion TEXT,
                    codigo_expiracion BIGINT
                );
            `);

            // Asegurar que columnas nuevas existan si la tabla ya existía
            await pool.query(`
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS correo TEXT;
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefono TEXT;
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS direccion TEXT;
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS fecha_registro TEXT;
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS contador_modificaciones INT DEFAULT 0;
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rol VARCHAR(50) DEFAULT 'Cliente';
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS estado VARCHAR(50) DEFAULT 'Activo';
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS historial_ediciones JSONB DEFAULT '[]'::jsonb;
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS codigo_recuperacion TEXT;
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS codigo_expiracion BIGINT;
            `);

            // Tabla de administradores
            await pool.query(`
                CREATE TABLE IF NOT EXISTS administradores (
                    usuario VARCHAR(255) PRIMARY KEY,
                    clave TEXT NOT NULL,
                    rol VARCHAR(50) DEFAULT 'admin'
                );
            `);

            // Tabla de historial de descargas
            await pool.query(`
                CREATE TABLE IF NOT EXISTS descargas (
                    id SERIAL PRIMARY KEY,
                    formato VARCHAR(20) NOT NULL,
                    fecha TEXT NOT NULL,
                    hora TEXT NOT NULL
                );
            `);

            // Insertar o actualizar el admin por defecto
            await pool.query(`
                INSERT INTO administradores (usuario, clave) 
                VALUES ($1, $2)
                ON CONFLICT (usuario) DO UPDATE SET clave = EXCLUDED.clave;
            `, [ADMIN_DEFAULT.usuario, ADMIN_DEFAULT.clave]);

            console.log('Tablas listas en PostgreSQL');
        } catch (err) {
            console.error('Error al inicializar la base de datos en PostgreSQL:', err);
        }
    };
    initDb();
} else {
    console.log('DATABASE_URL no definida. Modo fallback a db.json local');
}

// Ruta dinámica para la carpeta Public
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'Public'))
    ? path.join(__dirname, 'Public')
    : path.join(__dirname, 'public');

app.use(cors());
app.use(express.json());

// Servir archivos estáticos
app.use(express.static(PUBLIC_DIR));

// Ruta raíz principal
app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Ruta dedicada para el panel de administración
app.get(['/admin', '/admin.html'], (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// --- MÉTODOS LOCALES (FALLBACK A db.json) ---
function normalizarUsuario(u) {
    if (!u) return u;
    return {
        usuario: u.usuario || '',
        clave: u.clave || '',
        correo: u.correo || '',
        telefono: u.telefono || '',
        direccion: u.direccion || '',
        fechaRegistro: u.fechaRegistro || u.fecha_registro || new Date().toLocaleDateString(),
        contadorModificaciones: typeof u.contadorModificaciones === 'number' ? u.contadorModificaciones : (typeof u.contador_modificaciones === 'number' ? u.contador_modificaciones : (u.historialEdiciones ? u.historialEdiciones.length : 0)),
        rol: u.rol || 'Cliente',
        estado: u.estado || 'Activo',
        historialEdiciones: Array.isArray(u.historialEdiciones) ? u.historialEdiciones : (Array.isArray(u.historial_ediciones) ? u.historial_ediciones : []),
        codigoRecuperacion: u.codigoRecuperacion || u.codigo_recuperacion || null,
        codigoExpiracion: u.codigoExpiracion || u.codigo_expiracion || null
    };
}

function leerDBLocal() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ usuarios: [], administradores: [ADMIN_DEFAULT], descargas: [] }, null, 2));
    }
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
        if (Array.isArray(data)) {
            return { usuarios: data.map(normalizarUsuario), administradores: [ADMIN_DEFAULT], descargas: [] };
        }
        if (!data.administradores) data.administradores = [ADMIN_DEFAULT];
        if (!data.descargas) data.descargas = [];
        data.usuarios = (data.usuarios || []).map(normalizarUsuario);
        return data;
    } catch (e) {
        return { usuarios: [], administradores: [ADMIN_DEFAULT], descargas: [] };
    }
}

function guardarDBLocal(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- API ENDPOINTS ---

// API: Login exclusivo para Administradores
app.post('/api/admin/login', async (req, res) => {
    const { usuario, clave } = req.body;

    if (pool) {
        try {
            const result = await pool.query(
                'SELECT usuario FROM administradores WHERE LOWER(usuario) = LOWER($1) AND clave = $2',
                [usuario, clave]
            );

            if (result.rows.length > 0) {
                res.json({ ok: true, usuario: result.rows[0].usuario });
            } else {
                res.status(401).json({ error: 'Credenciales no válidas' });
            }
        } catch (err) {
            res.status(500).json({ error: 'Error en el servidor' });
        }
    } else {
        const db = leerDBLocal();
        const adminExiste = db.administradores.find(a => a.usuario.toLowerCase() === (usuario || '').toLowerCase() && a.clave === clave);
        if (adminExiste) {
            res.json({ ok: true, usuario: adminExiste.usuario });
        } else {
            res.status(401).json({ error: 'Credenciales no válidas' });
        }
    }
});

// API: Obtener todos los usuarios
app.get('/api/usuarios', async (req, res) => {
    if (pool) {
        try {
            const result = await pool.query(
                `SELECT usuario, clave, correo, telefono, direccion, 
                        fecha_registro AS "fechaRegistro", 
                        contador_modificaciones AS "contadorModificaciones",
                        COALESCE(rol, 'Cliente') AS "rol",
                        COALESCE(estado, 'Activo') AS "estado",
                        COALESCE(historial_ediciones, '[]'::jsonb) AS "historialEdiciones"
                 FROM usuarios ORDER BY usuario ASC`
            );
            return res.json(result.rows);
        } catch (err) {
            return res.status(500).json({ error: 'Error al consultar PostgreSQL' });
        }
    } else {
        const db = leerDBLocal();
        res.json(db.usuarios || []);
    }
});

// API: Registrar usuario normal
app.post('/api/usuarios/registrar', async (req, res) => {
    const { usuario, clave, correo, telefono, direccion } = req.body;
    if (!usuario || !clave) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    if (!correo) return res.status(400).json({ error: 'El correo electrónico es requerido' });

    const fechaRegistro = new Date().toLocaleDateString();

    if (pool) {
        try {
            const existe = await pool.query('SELECT usuario FROM usuarios WHERE LOWER(usuario) = LOWER($1)', [usuario]);
            if (existe.rows.length > 0) return res.status(400).json({ error: 'El nombre de usuario ya existe' });

            const existeCorreo = await pool.query('SELECT usuario FROM usuarios WHERE LOWER(correo) = LOWER($1)', [correo]);
            if (existeCorreo.rows.length > 0) return res.status(400).json({ error: 'El correo electrónico ya está registrado' });

            const insertResult = await pool.query(
                `INSERT INTO usuarios (usuario, clave, correo, telefono, direccion, fecha_registro, contador_modificaciones, rol, estado, historial_ediciones)
                 VALUES ($1, $2, $3, $4, $5, $6, 0, 'Cliente', 'Activo', '[]'::jsonb)
                 RETURNING usuario, clave, correo, telefono, direccion, fecha_registro AS "fechaRegistro", contador_modificaciones AS "contadorModificaciones", rol, estado, historial_ediciones AS "historialEdiciones"`,
                [usuario, clave, correo, telefono || '', direccion || '', fechaRegistro]
            );

            return res.json({ mensaje: 'Usuario registrado exitosamente', usuario: insertResult.rows[0] });
        } catch (err) {
            return res.status(500).json({ error: 'Error en base de datos' });
        }
    } else {
        const db = leerDBLocal();
        if (db.usuarios.some(u => u.usuario.toLowerCase() === usuario.toLowerCase())) {
            return res.status(400).json({ error: 'El nombre de usuario ya existe' });
        }
        if (db.usuarios.some(u => u.correo && u.correo.toLowerCase() === correo.toLowerCase())) {
            return res.status(400).json({ error: 'El correo electrónico ya está registrado' });
        }

        const nuevoUsuario = {
            usuario,
            clave,
            correo,
            telefono: telefono || '',
            direccion: direccion || '',
            fechaRegistro,
            contadorModificaciones: 0,
            rol: 'Cliente',
            estado: 'Activo',
            historialEdiciones: []
        };
        db.usuarios.push(nuevoUsuario);
        guardarDBLocal(db);
        res.json({ mensaje: 'Usuario registrado exitosamente', usuario: nuevoUsuario });
    }
});

// API: Iniciar sesión usuario normal
app.post('/api/usuarios/login', async (req, res) => {
    const { usuario, clave } = req.body;

    if (!usuario || !clave) {
        return res.status(400).json({ error: 'Ingresa usuario y contraseña' });
    }

    if (pool) {
        try {
            const result = await pool.query(
                `SELECT usuario, clave, correo, telefono, direccion, 
                        fecha_registro AS "fechaRegistro", 
                        contador_modificaciones AS "contadorModificaciones",
                        COALESCE(rol, 'Cliente') AS "rol",
                        COALESCE(estado, 'Activo') AS "estado",
                        COALESCE(historial_ediciones, '[]'::jsonb) AS "historialEdiciones" 
                 FROM usuarios WHERE (LOWER(usuario) = LOWER($1) OR LOWER(correo) = LOWER($1)) AND clave = $2`,
                [usuario, clave]
            );

            if (result.rows.length > 0) {
                const user = result.rows[0];
                if (user.estado === 'Bloqueado') {
                    return res.status(403).json({ error: 'Tu cuenta ha sido bloqueada. Contacta al administrador para más información.' });
                }
                if (user.estado === 'Inactivo') {
                    return res.status(403).json({ error: 'Tu cuenta se encuentra inactiva. Contacta al administrador.' });
                }
                res.json(user);
            } else {
                res.status(401).json({ error: 'Credenciales incorrectas' });
            }
        } catch (err) {
            res.status(500).json({ error: 'Error en el servidor' });
        }
    } else {
        const db = leerDBLocal();
        const encontrado = db.usuarios.find(u =>
            (u.usuario.toLowerCase() === usuario.toLowerCase() || (u.correo && u.correo.toLowerCase() === usuario.toLowerCase())) &&
            u.clave === clave
        );

        if (encontrado) {
            if (encontrado.estado === 'Bloqueado') {
                return res.status(403).json({ error: 'Tu cuenta ha sido bloqueada. Contacta al administrador para más información.' });
            }
            if (encontrado.estado === 'Inactivo') {
                return res.status(403).json({ error: 'Tu cuenta se encuentra inactiva. Contacta al administrador.' });
            }
            res.json(encontrado);
        } else {
            res.status(401).json({ error: 'Credenciales incorrectas' });
        }
    }
});

// --- API: EDICIÓN DE PERFIL POR EL USUARIO ---
const procesarEdicionPerfil = async (req, res) => {
    const { usuario, id, correo, telefono, direccion, clave } = req.body;
    const nombreUsuario = usuario || id;

    if (!nombreUsuario) {
        return res.status(400).json({ error: 'Identificador de usuario requerido' });
    }

    if (pool) {
        try {
            const userRes = await pool.query(
                `SELECT usuario, clave, correo, telefono, direccion, fecha_registro, contador_modificaciones, rol, estado, historial_ediciones 
                 FROM usuarios WHERE LOWER(usuario) = LOWER($1)`,
                [nombreUsuario]
            );

            if (userRes.rows.length === 0) {
                return res.status(404).json({ error: 'Usuario no encontrado' });
            }

            const actual = userRes.rows[0];
            const cambios = [];

            if (correo && correo !== actual.correo) {
                cambios.push({ campo: 'Correo Electrónico', valorAnterior: actual.correo || 'Sin correo', valorNuevo: correo });
            }
            if (telefono !== undefined && telefono !== actual.telefono) {
                cambios.push({ campo: 'Teléfono', valorAnterior: actual.telefono || 'Sin teléfono', valorNuevo: telefono || 'Sin teléfono' });
            }
            if (direccion !== undefined && direccion !== actual.direccion) {
                cambios.push({ campo: 'Dirección', valorAnterior: actual.direccion || 'Sin dirección', valorNuevo: direccion || 'Sin dirección' });
            }
            if (clave && clave !== actual.clave) {
                cambios.push({ campo: 'Contraseña', valorAnterior: '••••••••', valorNuevo: '•••••••• (Actualizada)' });
            }

            let historialActual = actual.historial_ediciones || [];
            if (!Array.isArray(historialActual)) {
                try { historialActual = JSON.parse(historialActual); } catch (e) { historialActual = []; }
            }

            let nuevoContador = parseInt(actual.contador_modificaciones || 0);

            if (cambios.length > 0) {
                const registroAuditoria = crearRegistroAuditoria(
                    'perfil',
                    '📁 Edición de Perfil de Usuario',
                    cambios,
                    actual.usuario,
                    `Actualización de datos personales (${cambios.map(c => c.campo).join(', ')})`
                );
                historialActual.unshift(registroAuditoria);
                nuevoContador += 1;
            }

            const nuevoCorreo = correo || actual.correo;
            const nuevoTelefono = telefono !== undefined ? telefono : actual.telefono;
            const nuevaDireccion = direccion !== undefined ? direccion : actual.direccion;
            const nuevaClave = clave || actual.clave;

            const updateResult = await pool.query(
                `UPDATE usuarios 
                 SET correo = $2, telefono = $3, direccion = $4, clave = $5,
                     contador_modificaciones = $6, historial_ediciones = $7::jsonb
                 WHERE LOWER(usuario) = LOWER($1)
                 RETURNING usuario, clave, correo, telefono, direccion, 
                           fecha_registro AS "fechaRegistro", 
                           contador_modificaciones AS "contadorModificaciones", 
                           rol, estado, 
                           historial_ediciones AS "historialEdiciones"`,
                [nombreUsuario, nuevoCorreo, nuevoTelefono, nuevaDireccion, nuevaClave, nuevoContador, JSON.stringify(historialActual)]
            );

            res.json({ mensaje: 'Perfil actualizado exitosamente', usuario: updateResult.rows[0] });
        } catch (err) {
            console.error('Error al actualizar perfil en PostgreSQL:', err);
            res.status(500).json({ error: 'Error al actualizar perfil en el servidor' });
        }
    } else {
        const db = leerDBLocal();
        const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === nombreUsuario.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

        const actual = db.usuarios[idx];
        const cambios = [];

        if (correo && correo !== actual.correo) {
            cambios.push({ campo: 'Correo Electrónico', valorAnterior: actual.correo || 'Sin correo', valorNuevo: correo });
            actual.correo = correo;
        }
        if (telefono !== undefined && telefono !== actual.telefono) {
            cambios.push({ campo: 'Teléfono', valorAnterior: actual.telefono || 'Sin teléfono', valorNuevo: telefono || 'Sin teléfono' });
            actual.telefono = telefono;
        }
        if (direccion !== undefined && direccion !== actual.direccion) {
            cambios.push({ campo: 'Dirección', valorAnterior: actual.direccion || 'Sin dirección', valorNuevo: direccion || 'Sin dirección' });
            actual.direccion = direccion;
        }
        if (clave && clave !== actual.clave) {
            cambios.push({ campo: 'Contraseña', valorAnterior: '••••••••', valorNuevo: '•••••••• (Actualizada)' });
            actual.clave = clave;
        }

        if (!Array.isArray(actual.historialEdiciones)) {
            actual.historialEdiciones = [];
        }

        if (cambios.length > 0) {
            const registroAuditoria = crearRegistroAuditoria(
                'perfil',
                '📁 Edición de Perfil de Usuario',
                cambios,
                actual.usuario,
                `Actualización de datos personales (${cambios.map(c => c.campo).join(', ')})`
            );
            actual.historialEdiciones.unshift(registroAuditoria);
            actual.contadorModificaciones = (actual.contadorModificaciones || 0) + 1;
        }

        guardarDBLocal(db);
        res.json({ mensaje: 'Perfil actualizado exitosamente', usuario: actual });
    }
};

app.put('/api/usuarios/editar', procesarEdicionPerfil);
app.put('/api/usuarios/actualizar', procesarEdicionPerfil);

// --- API: CAMBIAR CONTRASEÑA DESDE EL PERFIL ---
app.put('/api/usuarios/cambiar-clave', async (req, res) => {
    const { usuario, id, claveActual, claveNueva } = req.body;
    const nombreUsuario = usuario || id;

    if (!nombreUsuario || !claveActual || !claveNueva) {
        return res.status(400).json({ error: 'Usuario, contraseña actual y nueva contraseña son requeridos' });
    }

    if (claveNueva.length < 6) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    if (pool) {
        try {
            const userRes = await pool.query(
                `SELECT usuario, clave, contador_modificaciones, historial_ediciones 
                 FROM usuarios WHERE LOWER(usuario) = LOWER($1)`,
                [nombreUsuario]
            );

            if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

            const user = userRes.rows[0];
            if (user.clave !== claveActual) {
                return res.status(400).json({ error: 'La contraseña actual no es correcta' });
            }

            let historialActual = user.historial_ediciones || [];
            if (!Array.isArray(historialActual)) {
                try { historialActual = JSON.parse(historialActual); } catch (e) { historialActual = []; }
            }

            const registroAuditoria = crearRegistroAuditoria(
                'clave',
                '📁 Actualización de Contraseña',
                [
                    { campo: 'Contraseña', valorAnterior: '•••••••• (Clave anterior protegida)', valorNuevo: '•••••••• (Nueva clave establecida)' }
                ],
                user.usuario,
                'Cambio de contraseña realizado directamente desde el panel de perfil'
            );

            historialActual.unshift(registroAuditoria);
            const nuevoContador = parseInt(user.contador_modificaciones || 0) + 1;

            const updateResult = await pool.query(
                `UPDATE usuarios 
                 SET clave = $2, contador_modificaciones = $3, historial_ediciones = $4::jsonb 
                 WHERE LOWER(usuario) = LOWER($1)
                 RETURNING usuario, clave, correo, telefono, direccion, fecha_registro AS "fechaRegistro", contador_modificaciones AS "contadorModificaciones", rol, estado, historial_ediciones AS "historialEdiciones"`,
                [nombreUsuario, claveNueva, nuevoContador, JSON.stringify(historialActual)]
            );

            res.json({ ok: true, mensaje: 'Contraseña actualizada con éxito', usuario: updateResult.rows[0] });
        } catch (err) {
            res.status(500).json({ error: 'Error al cambiar contraseña' });
        }
    } else {
        const db = leerDBLocal();
        const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === nombreUsuario.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

        const user = db.usuarios[idx];
        if (user.clave !== claveActual) {
            return res.status(400).json({ error: 'La contraseña actual no es correcta' });
        }

        if (!Array.isArray(user.historialEdiciones)) {
            user.historialEdiciones = [];
        }

        const registroAuditoria = crearRegistroAuditoria(
            'clave',
            '📁 Actualización de Contraseña',
            [
                { campo: 'Contraseña', valorAnterior: '•••••••• (Clave anterior protegida)', valorNuevo: '•••••••• (Nueva clave establecida)' }
            ],
            user.usuario,
            'Cambio de contraseña realizado directamente desde el panel de perfil'
        );

        user.clave = claveNueva;
        user.historialEdiciones.unshift(registroAuditoria);
        user.contadorModificaciones = (user.contadorModificaciones || 0) + 1;

        guardarDBLocal(db);
        res.json({ ok: true, mensaje: 'Contraseña actualizada con éxito', usuario: user });
    }
});

// --- API: EDICIÓN COMPLETA Y GESTIÓN DE ESTADOS POR EL ADMINISTRADOR ---
app.put('/api/usuarios/:usuario', async (req, res) => {
    const nombreUsuario = req.params.usuario;
    const { correo, telefono, direccion, clave, rol, estado } = req.body;

    if (pool) {
        try {
            const userRes = await pool.query(
                `SELECT usuario, clave, correo, telefono, direccion, rol, estado, contador_modificaciones, historial_ediciones 
                 FROM usuarios WHERE LOWER(usuario) = LOWER($1)`,
                [nombreUsuario]
            );

            if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

            const actual = userRes.rows[0];
            const cambios = [];

            if (correo && correo !== actual.correo) {
                cambios.push({ campo: 'Correo Electrónico', valorAnterior: actual.correo || 'Sin correo', valorNuevo: correo });
            }
            if (telefono !== undefined && telefono !== actual.telefono) {
                cambios.push({ campo: 'Teléfono', valorAnterior: actual.telefono || 'Sin teléfono', valorNuevo: telefono });
            }
            if (direccion !== undefined && direccion !== actual.direccion) {
                cambios.push({ campo: 'Dirección', valorAnterior: actual.direccion || 'Sin dirección', valorNuevo: direccion });
            }
            if (clave && clave !== actual.clave) {
                cambios.push({ campo: 'Contraseña', valorAnterior: actual.clave, valorNuevo: clave });
            }
            if (rol && rol !== (actual.rol || 'Cliente')) {
                cambios.push({ campo: 'Rol de Usuario', valorAnterior: actual.rol || 'Cliente', valorNuevo: rol });
            }
            if (estado && estado !== (actual.estado || 'Activo')) {
                cambios.push({ campo: 'Estado de la Cuenta', valorAnterior: actual.estado || 'Activo', valorNuevo: estado });
            }

            let historialActual = actual.historial_ediciones || [];
            if (!Array.isArray(historialActual)) {
                try { historialActual = JSON.parse(historialActual); } catch (e) { historialActual = []; }
            }

            let nuevoContador = parseInt(actual.contador_modificaciones || 0);

            if (cambios.length > 0) {
                const registroAuditoria = crearRegistroAuditoria(
                    'admin',
                    '📁 Modificación por Administrador',
                    cambios,
                    'Administrador',
                    `Modificación de parámetros administrativos (${cambios.map(c => c.campo).join(', ')})`
                );
                historialActual.unshift(registroAuditoria);
                nuevoContador += 1;
            }

            const nuevoCorreo = correo !== undefined ? correo : actual.correo;
            const nuevoTelefono = telefono !== undefined ? telefono : actual.telefono;
            const nuevaDireccion = direccion !== undefined ? direccion : actual.direccion;
            const nuevaClave = clave !== undefined ? clave : actual.clave;
            const nuevoRol = rol || actual.rol || 'Cliente';
            const nuevoEstado = estado || actual.estado || 'Activo';

            const updateResult = await pool.query(
                `UPDATE usuarios 
                 SET correo = $2, telefono = $3, direccion = $4, clave = $5, rol = $6, estado = $7,
                     contador_modificaciones = $8, historial_ediciones = $9::jsonb 
                 WHERE LOWER(usuario) = LOWER($1)
                 RETURNING usuario, clave, correo, telefono, direccion, fecha_registro AS "fechaRegistro", contador_modificaciones AS "contadorModificaciones", rol, estado, historial_ediciones AS "historialEdiciones"`,
                [nombreUsuario, nuevoCorreo, nuevoTelefono, nuevaDireccion, nuevaClave, nuevoRol, nuevoEstado, nuevoContador, JSON.stringify(historialActual)]
            );

            res.json({ mensaje: 'Usuario actualizado exitosamente por el administrador', usuario: updateResult.rows[0] });
        } catch (err) {
            console.error('Error al actualizar usuario en PostgreSQL:', err);
            res.status(500).json({ error: 'Error al actualizar usuario' });
        }
    } else {
        const db = leerDBLocal();
        const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === nombreUsuario.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

        const actual = db.usuarios[idx];
        const cambios = [];

        if (correo !== undefined && correo !== actual.correo) {
            cambios.push({ campo: 'Correo Electrónico', valorAnterior: actual.correo || 'Sin correo', valorNuevo: correo });
            actual.correo = correo;
        }
        if (telefono !== undefined && telefono !== actual.telefono) {
            cambios.push({ campo: 'Teléfono', valorAnterior: actual.telefono || 'Sin teléfono', valorNuevo: telefono });
            actual.telefono = telefono;
        }
        if (direccion !== undefined && direccion !== actual.direccion) {
            cambios.push({ campo: 'Dirección', valorAnterior: actual.direccion || 'Sin dirección', valorNuevo: direccion });
            actual.direccion = direccion;
        }
        if (clave !== undefined && clave !== actual.clave) {
            cambios.push({ campo: 'Contraseña', valorAnterior: actual.clave, valorNuevo: clave });
            actual.clave = clave;
        }
        if (rol && rol !== (actual.rol || 'Cliente')) {
            cambios.push({ campo: 'Rol de Usuario', valorAnterior: actual.rol || 'Cliente', valorNuevo: rol });
            actual.rol = rol;
        }
        if (estado && estado !== (actual.estado || 'Activo')) {
            cambios.push({ campo: 'Estado de la Cuenta', valorAnterior: actual.estado || 'Activo', valorNuevo: estado });
            actual.estado = estado;
        }

        if (!Array.isArray(actual.historialEdiciones)) {
            actual.historialEdiciones = [];
        }

        if (cambios.length > 0) {
            const registroAuditoria = crearRegistroAuditoria(
                'admin',
                '📁 Modificación por Administrador',
                cambios,
                'Administrador',
                `Modificación de parámetros administrativos (${cambios.map(c => c.campo).join(', ')})`
            );
            actual.historialEdiciones.unshift(registroAuditoria);
            actual.contadorModificaciones = (actual.contadorModificaciones || 0) + 1;
        }

        guardarDBLocal(db);
        res.json({ mensaje: 'Usuario actualizado exitosamente por el administrador', usuario: actual });
    }
});

// --- API: RECUPERACIÓN DE CONTRASEÑA POR CORREO (CÓDIGO DE 6 DÍGITOS - 15 MINUTOS) ---

// 1. Solicitar código de recuperación
app.post('/api/usuarios/solicitar-codigo-recuperacion', async (req, res) => {
    const { correo } = req.body;
    if (!correo) return res.status(400).json({ error: 'El correo electrónico es requerido' });

    // Generar código numérico de 6 dígitos
    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    // Expiración: 15 minutos a partir de este momento (900.000 ms)
    const expiracion = Date.now() + (15 * 60 * 1000);

    let usuarioEncontrado = null;

    if (pool) {
        try {
            const userRes = await pool.query(
                'SELECT usuario, correo FROM usuarios WHERE LOWER(correo) = LOWER($1)',
                [correo]
            );

            if (userRes.rows.length === 0) {
                return res.status(404).json({ error: 'No existe ninguna cuenta asociada a este correo electrónico' });
            }
            usuarioEncontrado = userRes.rows[0];

            await pool.query(
                'UPDATE usuarios SET codigo_recuperacion = $1, codigo_expiracion = $2 WHERE LOWER(correo) = LOWER($3)',
                [codigo, expiracion, correo]
            );
        } catch (err) {
            console.error('Error al actualizar código en PostgreSQL:', err);
            return res.status(500).json({ error: 'Error al actualizar código en la base de datos' });
        }
    } else {
        const db = leerDBLocal();
        const idx = db.usuarios.findIndex(u => u.correo && u.correo.toLowerCase() === correo.toLowerCase());

        if (idx === -1) {
            return res.status(404).json({ error: 'No existe ninguna cuenta asociada a este correo electrónico' });
        }
        usuarioEncontrado = db.usuarios[idx];

        db.usuarios[idx].codigoRecuperacion = codigo;
        db.usuarios[idx].codigoExpiracion = expiracion;
        guardarDBLocal(db);
    }

    // DISPARAR EL ENVÍO REAL DEL CORREO MEDIANTE RESEND API
    try {
        const resultadoEnvio = await enviarCorreoRecuperacion(usuarioEncontrado.correo, codigo);

        if (resultadoEnvio && resultadoEnvio.enviado === false) {
            return res.status(400).json({
                error: 'No se detectó la variable RESEND_API_KEY en el servidor (Render). Configúrala en Environment Variables.',
                modoDev: true
            });
        }

        return res.json({
            ok: true,
            mensaje: 'Código de 6 dígitos enviado exitosamente. Revisa también tu carpeta de Spam / Correo No Deseado.'
        });
    } catch (emailErr) {
        console.error('[CAPTURA ERROR ENVÍO CORREO]:', emailErr);
        return res.status(500).json({
            error: 'Falló el envío del correo por Resend. Verifica que RESEND_API_KEY esté bien configurada en Render.',
            detalle: emailErr.message || 'Error de API Resend'
        });
    }
});

// 2. Verificar código de recuperación
app.post('/api/usuarios/verificar-codigo-recuperacion', async (req, res) => {
    const { correo, codigo } = req.body;
    if (!correo || !codigo) return res.status(400).json({ error: 'Correo y código son requeridos' });

    if (pool) {
        try {
            const userRes = await pool.query(
                'SELECT codigo_recuperacion, codigo_expiracion FROM usuarios WHERE LOWER(correo) = LOWER($1)',
                [correo]
            );

            if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

            const user = userRes.rows[0];
            if (!user.codigo_recuperacion || user.codigo_recuperacion !== codigo) {
                return res.status(400).json({ error: 'Código de verificación incorrecto' });
            }

            if (Date.now() > parseInt(user.codigo_expiracion || 0)) {
                return res.status(400).json({ error: 'El código ha expirado (duración máxima: 15 minutos)' });
            }

            return res.json({ ok: true, mensaje: 'Código verificado exitosamente' });
        } catch (err) {
            return res.status(500).json({ error: 'Error en la base de datos' });
        }
    } else {
        const db = leerDBLocal();
        const user = db.usuarios.find(u => u.correo && u.correo.toLowerCase() === correo.toLowerCase());

        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

        if (!user.codigoRecuperacion || user.codigoRecuperacion !== codigo) {
            return res.status(400).json({ error: 'Código de verificación incorrecto' });
        }

        if (Date.now() > (user.codigoExpiracion || 0)) {
            return res.status(400).json({ error: 'El código ha expirado (duración máxima: 15 minutos)' });
        }

        return res.json({ ok: true, mensaje: 'Código verificado exitosamente' });
    }
});

// 3. Restablecer contraseña con el código
app.post('/api/usuarios/restablecer-clave', async (req, res) => {
    const { correo, codigo, nuevaClave } = req.body;
    if (!correo || !codigo || !nuevaClave) {
        return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    if (pool) {
        try {
            const userRes = await pool.query(
                'SELECT usuario, clave, codigo_recuperacion, codigo_expiracion, contador_modificaciones, historial_ediciones FROM usuarios WHERE LOWER(correo) = LOWER($1)',
                [correo]
            );

            if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

            const user = userRes.rows[0];
            if (!user.codigo_recuperacion || user.codigo_recuperacion !== codigo) {
                return res.status(400).json({ error: 'Código inválido' });
            }

            if (Date.now() > parseInt(user.codigo_expiracion || 0)) {
                return res.status(400).json({ error: 'El código ha expirado. Debes solicitar uno nuevo.' });
            }

            let historialActual = user.historial_ediciones || [];
            if (!Array.isArray(historialActual)) {
                try { historialActual = JSON.parse(historialActual); } catch (e) { historialActual = []; }
            }

            const registroAuditoria = crearRegistroAuditoria(
                'recuperacion',
                '📁 Recuperación de Contraseña (Código OTP)',
                [
                    { campo: 'Contraseña', valorAnterior: '•••••••• (Olvidada)', valorNuevo: '•••••••• (Restablecida con OTP)' }
                ],
                'Sistema / Recuperación OTP',
                'Contraseña restablecida exitosamente mediante validación de código numérico enviado por correo'
            );

            historialActual.unshift(registroAuditoria);
            const nuevoContador = parseInt(user.contador_modificaciones || 0) + 1;

            await pool.query(
                `UPDATE usuarios 
                 SET clave = $1, codigo_recuperacion = NULL, codigo_expiracion = NULL, 
                     contador_modificaciones = $2, historial_ediciones = $3::jsonb 
                 WHERE LOWER(correo) = LOWER($4)`,
                [nuevaClave, nuevoContador, JSON.stringify(historialActual), correo]
            );

            return res.json({ ok: true, mensaje: 'Contraseña actualizada con éxito' });
        } catch (err) {
            return res.status(500).json({ error: 'Error al actualizar contraseña' });
        }
    } else {
        const db = leerDBLocal();
        const idx = db.usuarios.findIndex(u => u.correo && u.correo.toLowerCase() === correo.toLowerCase());

        if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

        const user = db.usuarios[idx];
        if (!user.codigoRecuperacion || user.codigoRecuperacion !== codigo) {
            return res.status(400).json({ error: 'Código inválido' });
        }

        if (Date.now() > (user.codigoExpiracion || 0)) {
            return res.status(400).json({ error: 'El código ha expirado. Debes solicitar uno nuevo.' });
        }

        if (!Array.isArray(user.historialEdiciones)) {
            user.historialEdiciones = [];
        }

        const registroAuditoria = crearRegistroAuditoria(
            'recuperacion',
            '📁 Recuperación de Contraseña (Código OTP)',
            [
                { campo: 'Contraseña', valorAnterior: '•••••••• (Olvidada)', valorNuevo: '•••••••• (Restablecida con OTP)' }
            ],
            'Sistema / Recuperación OTP',
            'Contraseña restablecida exitosamente mediante validación de código numérico enviado por correo'
        );

        user.clave = nuevaClave;
        user.codigoRecuperacion = null;
        user.codigoExpiracion = null;
        user.historialEdiciones.unshift(registroAuditoria);
        user.contadorModificaciones = (user.contadorModificaciones || 0) + 1;

        guardarDBLocal(db);
        return res.json({ ok: true, mensaje: 'Contraseña actualizada con éxito' });
    }
});

// --- API: ELIMINAR USUARIO ---
const eliminarUsuarioHandler = async (req, res) => {
    const nombreUsuario = req.params.usuario || req.body.usuario || req.body.id;

    if (!nombreUsuario) {
        return res.status(400).json({ error: 'Nombre de usuario requerido' });
    }

    if (pool) {
        try {
            await pool.query('DELETE FROM usuarios WHERE LOWER(usuario) = LOWER($1)', [nombreUsuario]);
            res.json({ mensaje: 'Usuario eliminado exitosamente' });
        } catch (err) {
            res.status(500).json({ error: 'Error al eliminar usuario en base de datos' });
        }
    } else {
        const db = leerDBLocal();
        db.usuarios = db.usuarios.filter(u => u.usuario.toLowerCase() !== nombreUsuario.toLowerCase());
        guardarDBLocal(db);
        res.json({ mensaje: 'Usuario eliminado exitosamente' });
    }
};

app.delete('/api/usuarios/:usuario', eliminarUsuarioHandler);
app.delete('/api/usuarios/eliminar/:usuario', eliminarUsuarioHandler);
app.post('/api/usuarios/eliminar', eliminarUsuarioHandler);

// API: Vaciar usuarios
app.delete('/api/usuarios', async (req, res) => {
    if (pool) {
        try {
            await pool.query('TRUNCATE TABLE usuarios');
            res.json({ mensaje: 'Base de datos vaciada exitosamente' });
        } catch (err) {
            res.status(500).json({ error: 'Error al vaciar la base de datos' });
        }
    } else {
        const db = leerDBLocal();
        db.usuarios = [];
        guardarDBLocal(db);
        res.json({ mensaje: 'Base de datos vaciada exitosamente' });
    }
});

// --- HISTORIAL DE DESCARGAS ---

// API: Registrar una descarga
app.post('/api/descargas', async (req, res) => {
    const { formato } = req.body;
    const ahora = new Date();
    const fecha = ahora.toLocaleDateString();
    const hora = ahora.toLocaleTimeString();

    if (pool) {
        try {
            const result = await pool.query(
                'INSERT INTO descargas (formato, fecha, hora) VALUES ($1, $2, $3) RETURNING *',
                [formato, fecha, hora]
            );
            res.json(result.rows[0]);
        } catch (err) {
            res.status(500).json({ error: 'Error al guardar log de descarga' });
        }
    } else {
        const db = leerDBLocal();
        const nuevaDescarga = { id: Date.now(), formato, fecha, hora };
        db.descargas.push(nuevaDescarga);
        guardarDBLocal(db);
        res.json(nuevaDescarga);
    }
});

// API: Obtener lista de descargas
app.get('/api/descargas', async (req, res) => {
    if (pool) {
        try {
            const result = await pool.query('SELECT * FROM descargas ORDER BY id DESC');
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: 'Error al consultar descargas' });
        }
    } else {
        const db = leerDBLocal();
        res.json([...db.descargas].reverse());
    }
});

// API: Eliminar una descarga específica por ID
app.delete('/api/descargas/:id', async (req, res) => {
    const { id } = req.params;

    if (pool) {
        try {
            await pool.query('DELETE FROM descargas WHERE id = $1', [id]);
            res.json({ mensaje: 'Registro de descarga eliminado' });
        } catch (err) {
            res.status(500).json({ error: 'Error al eliminar el registro' });
        }
    } else {
        const db = leerDBLocal();
        db.descargas = db.descargas.filter(d => d.id.toString() !== id.toString());
        guardarDBLocal(db);
        res.json({ mensaje: 'Registro de descarga eliminado' });
    }
});

// API: Vaciar todas las descargas
app.delete('/api/descargas', async (req, res) => {
    if (pool) {
        try {
            await pool.query('TRUNCATE TABLE descargas');
            res.json({ mensaje: 'Historial de descargas vaciado' });
        } catch (err) {
            res.status(500).json({ error: 'Error al vaciar historial' });
        }
    } else {
        const db = leerDBLocal();
        db.descargas = [];
        guardarDBLocal(db);
        res.json({ mensaje: 'Historial de descargas vaciado' });
    }
});

// Redirección por defecto
app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor iniciado en puerto ${PORT}`);
});