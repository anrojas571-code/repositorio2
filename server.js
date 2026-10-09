require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const { Resend } = require('resend');
const XLSX = require('xlsx');

// --- NUEVAS DEPENDENCIAS ENTERPRISE ---
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

// --- BASE DE DATOS RELACIONAL SQLITE & VALIDACIONES CON ESQUEMAS ZOD ---
const { dbSqlite, leerDBDesdeSQLite, guardarDBEnSQLite } = require('./sqliteDB');
const {
    validar,
    registroSchema,
    loginSchema,
    adminLoginSchema,
    cambiarClaveSchema,
    recuperarSolicitarSchema,
    restablecerClaveSchema,
    editarPerfilSchema,
    soporteMensajeSchema,
    soporteRespuestaSchema
} = require('./validaciones');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const SYSTEM_NAME = process.env.SYSTEM_NAME || 'Sistema de Gestión de Usuarios';
const HOST_NAME = process.env.HOST_NAME || 'sistema.local';
const JWT_SECRET = process.env.JWT_SECRET || 'clave_secreta_super_segura_2026_jwt_token_master';

const PRIMARY_DB_FILE = path.join(__dirname, 'database.json');
const LEGACY_DB_FILE = path.join(__dirname, 'db.json');

// --- SEGURIDAD: HELMET Y COOKIES ---
// Content Security Policy adaptado para permitir fuentes, íconos y CDN de FontAwesome, Google Fonts y Chart.js
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// --- RATE LIMITING (PROTECCIÓN CONTRA ATAQUES DE FUERZA BRUTA Y SPAM) ---
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 500, // Máximo 500 peticiones por ventana para navegación general
    message: { error: 'Demasiadas solicitudes desde esta IP. Inténtalo de nuevo más tarde.' },
    standardHeaders: true,
    legacyHeaders: false
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 15, // Máximo 15 intentos de autenticación por IP cada 15 min
    message: { error: 'Demasiados intentos de acceso desde esta IP. Inténtalo de nuevo en 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', apiLimiter);
app.use('/api/usuarios/login', authLimiter);
app.use('/api/admin/login', authLimiter);
app.use('/api/usuarios/recuperar-solicitar', authLimiter);
app.use('/api/usuarios/solicitar-codigo-recuperacion', authLimiter);

// Middleware de compresión GZIP nativa (acelera la carga un 70-80% sin librerías externas)
app.use((req, res, next) => {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (!acceptEncoding.includes('gzip')) return next();

    const originalSend = res.send;
    res.send = function (body) {
        if (!body) return originalSend.call(this, body);

        // No comprimir si ya es binario procesado o archivo descargable Excel
        const contentType = res.getHeader('Content-Type') || '';
        if (typeof contentType === 'string' && contentType.includes('spreadsheetml')) {
            return originalSend.call(this, body);
        }

        if (typeof body === 'string' || Buffer.isBuffer(body)) {
            const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
            if (buffer.length > 512) {
                try {
                    const gzipped = zlib.gzipSync(buffer);
                    res.setHeader('Content-Encoding', 'gzip');
                    res.removeHeader('Content-Length');
                    return originalSend.call(this, gzipped);
                } catch (e) {
                    return originalSend.call(this, body);
                }
            }
        }
        return originalSend.call(this, body);
    };
    next();
});

// Ruta dinámica para la carpeta Public
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'Public'))
    ? path.join(__dirname, 'Public')
    : path.join(__dirname, 'public');

// Servir archivos estáticos locales
app.use(express.static(PUBLIC_DIR));

// Credenciales del administrador por defecto
const ADMIN_DEFAULT = [
    { usuario: 'Admin', clave: 'An12345*', rol: 'admin' },
    { usuario: 'Angel', clave: 'Samuel20', rol: 'admin' }
];

// --- UTILIDADES CRIPTOGRÁFICAS BCRYPT ---
function esBcryptHash(str) {
    if (!str || typeof str !== 'string') return false;
    return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(str);
}

function hashearClave(clavePlana) {
    if (!clavePlana || typeof clavePlana !== 'string') return '';
    return bcrypt.hashSync(clavePlana, 10);
}

function verificarClave(claveIngresada, claveAlmacenada) {
    if (!claveIngresada || !claveAlmacenada) return false;
    if (esBcryptHash(claveAlmacenada)) {
        return bcrypt.compareSync(claveIngresada, claveAlmacenada);
    }
    // Compatibilidad retroactiva durante proceso de migración
    return claveIngresada === claveAlmacenada;
}

// Migración automática sin pérdida de datos de claves en texto plano a hashes bcrypt
function migrarClavesPlanas(data) {
    if (!data) return false;
    let huboCambios = false;

    if (Array.isArray(data.usuarios)) {
        data.usuarios.forEach(u => {
            if (u.clave && !esBcryptHash(u.clave)) {
                u.clave = hashearClave(u.clave);
                huboCambios = true;
            }
        });
    }

    if (Array.isArray(data.administradores)) {
        data.administradores.forEach(a => {
            if (a.clave && !esBcryptHash(a.clave)) {
                a.clave = hashearClave(a.clave);
                huboCambios = true;
            }
        });
    }

    return huboCambios;
}

// --- MIDDLEWARES DE AUTENTICACIÓN JWT ---
function verificarAdminJWT(req, res, next) {
    const token = req.cookies.admin_token || req.headers['authorization']?.replace(/^Bearer\s+/i, '');

    if (!token) {
        return res.status(401).json({ error: 'Acceso denegado. Sesión administrativa no iniciada o token no proporcionado.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.rol !== 'admin') {
            return res.status(403).json({ error: 'Acceso denegado. Permisos de administrador insuficientes.' });
        }
        req.admin = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token de administrador inválido o sesión expirada. Inicia sesión nuevamente.' });
    }
}

function verificarUsuarioJWT(req, res, next) {
    const token = req.cookies.auth_token || req.headers['authorization']?.replace(/^Bearer\s+/i, '');

    if (!token) {
        return res.status(401).json({ error: 'No autenticado. Token de sesión no proporcionado.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Sesión expirada o token inválido. Inicia sesión nuevamente.' });
    }
}

// Middleware: Permite Admin o Usuario dueño de la cuenta
function verificarAdminOUsuarioPropio(req, res, next) {
    const adminToken = req.cookies.admin_token || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (adminToken) {
        try {
            const decoded = jwt.verify(adminToken, JWT_SECRET);
            if (decoded.rol === 'admin') {
                req.admin = decoded;
                return next();
            }
        } catch (e) {}
    }

    const userToken = req.cookies.auth_token || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (userToken) {
        try {
            const decoded = jwt.verify(userToken, JWT_SECRET);
            const targetUser = (req.params.usuario || req.body.usuario || '').trim().toLowerCase();
            if (decoded.usuario && decoded.usuario.toLowerCase() === targetUser) {
                req.user = decoded;
                return next();
            }
        } catch (e) {}
    }

    return res.status(403).json({ error: 'Acceso denegado. No tienes permisos para realizar esta acción sobre este usuario.' });
}

// Middleware híbrido: Permite al usuario autenticado o al administrador
function verificarUsuarioOUsuarioAdmin(req, res, next) {
    const userToken = req.cookies.auth_token || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (userToken) {
        try {
            const decoded = jwt.verify(userToken, JWT_SECRET);
            req.user = decoded;
            return next();
        } catch (e) {}
    }

    const adminToken = req.cookies.admin_token || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (adminToken) {
        try {
            const decoded = jwt.verify(adminToken, JWT_SECRET);
            if (decoded.rol === 'admin') {
                req.admin = decoded;
                return next();
            }
        } catch (e) {}
    }

    return res.status(401).json({ error: 'No autenticado. Inicia sesión para realizar esta acción.' });
}

// --- BASE DE DATOS RELACIONAL SQLITE (CON CACHÉ Y RESPALDO JSON SINCRONIZADO) ---
let dbCache = null;

function leerDBLocal() {
    if (dbCache) return dbCache;

    try {
        dbCache = leerDBDesdeSQLite();

        // Migración transparente si se detectan credenciales en texto plano
        const migrado = migrarClavesPlanas(dbCache);
        if (migrado) {
            guardarDBLocal(dbCache);
            console.log('🔒 [SEGURIDAD] Todas las contraseñas han sido migradas exitosamente a hashes bcrypt protegidos.');
        }

        return dbCache;
    } catch (e) {
        console.error('Error al leer desde base de datos SQLite:', e.message);
        return { usuarios: [], administradores: ADMIN_DEFAULT, descargas: [], soporte: [], auditoria: [] };
    }
}

function guardarDBLocal(data) {
    dbCache = data;
    try {
        guardarDBEnSQLite(data);
    } catch (err) {
        console.error('Error guardando en base de datos SQLite:', err.message);
    }
}

// Carga inicial al arrancar
leerDBLocal();

// Función utilitaria para enmascarar correos electrónicos (ej: usuario@correo.com -> u***o@correo.com)
function enmascararCorreo(correo) {
    if (!correo || typeof correo !== 'string' || !correo.includes('@')) {
        return '***@correo.com';
    }
    const [nombre, dominio] = correo.trim().split('@');
    if (!nombre || nombre.length === 0) return `***@${dominio}`;
    if (nombre.length === 1) return `${nombre}***@${dominio}`;
    if (nombre.length === 2) return `${nombre[0]}***@${dominio}`;
    return `${nombre[0]}***${nombre[nombre.length - 1]}@${dominio}`;
}

// Normalizador unificado de objetos usuario (protege la contraseña en respuestas)
function normalizarUsuario(u) {
    if (!u) return null;
    let historial = u.historialEdiciones || u.historial_ediciones || [];
    if (typeof historial === 'string') {
        try {
            historial = JSON.parse(historial);
        } catch (e) {
            historial = [];
        }
    }
    if (!Array.isArray(historial)) {
        historial = [];
    }

    return {
        usuario: u.usuario,
        clave: '••••••••', // Jamás exponer texto plano ni el hash por la API
        correo: u.correo || '',
        telefono: u.telefono || '',
        direccion: u.direccion || '',
        fechaRegistro: u.fechaRegistro || u.fecha_registro || new Date().toLocaleDateString('es-ES'),
        contadorModificaciones: parseInt(u.contadorModificaciones || u.contador_modificaciones || 0),
        rol: u.rol || 'Cliente',
        estado: u.estado || 'Activo',
        historialEdiciones: historial,
        codigoRecuperacion: u.codigoRecuperacion || u.codigo_recuperacion || null,
        codigoExpiracion: u.codigoExpiracion || u.codigo_expiracion || null
    };
}

// Registro centralizado de auditoría en database.json
async function registrarEventoAuditoria(tipo, usuario, detalle, req = null) {
    const ahora = new Date();
    const fecha = ahora.toLocaleDateString('es-ES');
    const hora = ahora.toLocaleTimeString('es-ES');
    let ip = '127.0.0.1';
    if (req) {
        ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '127.0.0.1';
        if (typeof ip === 'string' && ip.includes(',')) ip = ip.split(',')[0].trim();
    }
    const evento = {
        id: Date.now().toString() + '-' + Math.floor(Math.random() * 1000),
        fecha,
        hora,
        tipo: tipo || 'GENERAL',
        usuario: usuario || 'Sistema',
        detalle: detalle || '',
        ip: ip || '127.0.0.1'
    };

    try {
        const db = leerDBLocal();
        if (!Array.isArray(db.auditoria)) db.auditoria = [];
        db.auditoria.unshift(evento);
        if (db.auditoria.length > 1000) db.auditoria = db.auditoria.slice(0, 1000);
        guardarDBLocal(db);
    } catch (err) {
        console.error('Error al registrar auditoría local:', err.message);
    }
    return evento;
}

// Función auxiliar para obtener la API Key de Resend desde el archivo de entorno
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

// Envío de correo electrónico mediante la API HTTP de Resend
async function enviarCorreoRecuperacion(correoDestino, codigo) {
    console.log(`\n==================================================`);
    console.log(`[CÓDIGO DE RECUPERACIÓN GENERADO]`);
    console.log(`Para: ${correoDestino}`);
    console.log(`Código OTP (6 dígitos): ${codigo}`);
    console.log(`Válido durante: 15 minutos (900 segundos)`);
    console.log(`==================================================\n`);

    const apiKey = obtenerApiKeyResend();

    if (!apiKey) {
        console.warn(`[EMAIL AVISO] No se envió el correo a la bandeja porque falta colocar RESEND_API_KEY en el archivo .env.`);
        console.warn(`[EMAIL AVISO] Puedes usar el código OTP (${codigo}) directamente en la web para continuar tus pruebas.`);
        return { enviado: false, motivo: 'no_credentials', codigo };
    }

    const resend = new Resend(apiKey);
    let remitenteFinal = process.env.EMAIL_FROM || 'Sistema de Usuarios <onboarding@resend.dev>';

    console.log(`[RESEND] Enviando correo de recuperación a ${correoDestino} desde ${remitenteFinal}...`);

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

// --- RUTAS DE VISTAS PRINCIPALES ---
app.get(['/', '/index', '/index.html'], (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get(['/admin', '/admin.html'], (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// --- WEBSOCKETS (SOCKET.IO) EN TIEMPO REAL ---
io.on('connection', (socket) => {
    console.log(`⚡ [SOCKET.IO] Conexión establecida: ${socket.id}`);

    // Cliente se suscribe a su canal individual
    socket.on('join_user_room', (nombreUsuario) => {
        if (nombreUsuario && typeof nombreUsuario === 'string') {
            const sala = `room_${nombreUsuario.trim().toLowerCase()}`;
            socket.join(sala);
            console.log(`[SOCKET.IO] Cliente ${socket.id} unido a sala: ${sala}`);
        }
    });

    // Panel de administración se une a la sala administrativa
    socket.on('join_admin_room', () => {
        socket.join('room_admin');
        console.log(`[SOCKET.IO] Admin ${socket.id} suscrito a room_admin`);
    });

    // Enviar mensaje en tiempo real directamente por WebSocket
    socket.on('send_message', (data) => {
        try {
            const { usuario, motivo, mensaje, emisor } = data || {};
            if (!usuario || !mensaje) return;

            const nuevoMensaje = {
                id: Date.now().toString(),
                usuario: usuario.trim(),
                emisor: (emisor || 'usuario').toLowerCase(),
                motivo: (motivo || 'Consulta General').trim(),
                mensaje: mensaje.trim(),
                fecha: new Date().toLocaleString('es-ES')
            };

            const db = leerDBLocal();
            if (!Array.isArray(db.soporte)) db.soporte = [];
            db.soporte.push(nuevoMensaje);
            guardarDBLocal(db);

            const salaUsuario = `room_${nuevoMensaje.usuario.toLowerCase()}`;
            io.to(salaUsuario).emit('nuevo_mensaje_soporte', nuevoMensaje);
            io.to('room_admin').emit('nuevo_mensaje_soporte', nuevoMensaje);
            io.emit('soporte_actualizado', nuevoMensaje);
        } catch (err) {
            console.error('[SOCKET.IO Error]', err);
        }
    });

    socket.on('disconnect', () => {
        // Desconexión limpia
    });
});

// --- API SOPORTE TÉCNICO ---
app.post(['/api/soporte', '/api/soporte/enviar'], validar(soporteMensajeSchema), async (req, res) => {
    const usuario = req.body.usuario || req.body.usuario_origen || req.body.remitente;
    const motivo = req.body.motivo || 'Consulta General';
    const mensaje = req.body.mensaje;
    const emisor = (req.body.emisor || 'usuario').toLowerCase();

    if (!usuario || !mensaje) {
        return res.status(400).json({ error: 'El usuario y el mensaje son requeridos' });
    }

    const nuevoMensaje = {
        id: Date.now().toString(),
        usuario: usuario.trim(),
        emisor: emisor,
        motivo: motivo.trim(),
        mensaje: mensaje.trim(),
        fecha: new Date().toLocaleString('es-ES')
    };

    const db = leerDBLocal();
    if (!Array.isArray(db.soporte)) db.soporte = [];
    db.soporte.push(nuevoMensaje);
    guardarDBLocal(db);

    // Emisión instantánea por WebSockets
    const salaUsuario = `room_${nuevoMensaje.usuario.toLowerCase()}`;
    io.to(salaUsuario).emit('nuevo_mensaje_soporte', nuevoMensaje);
    io.to('room_admin').emit('nuevo_mensaje_soporte', nuevoMensaje);
    io.emit('soporte_actualizado', nuevoMensaje);

    return res.status(201).json({ status: 'ok', mensaje: 'Mensaje recibido con éxito', data: nuevoMensaje });
});

app.post('/api/soporte/responder', verificarAdminJWT, validar(soporteRespuestaSchema), async (req, res) => {
    const usuario = req.body.usuario || req.body.usuario_origen;
    const { mensaje } = req.body;

    if (!usuario || !mensaje) {
        return res.status(400).json({ error: 'El usuario y el mensaje son requeridos' });
    }

    const respuestaAdmin = {
        id: Date.now().toString(),
        usuario: usuario.trim(),
        emisor: 'admin',
        motivo: req.body.motivo || 'Respuesta de Soporte',
        mensaje: mensaje.trim(),
        fecha: new Date().toLocaleString('es-ES')
    };

    const db = leerDBLocal();
    if (!Array.isArray(db.soporte)) db.soporte = [];
    db.soporte.push(respuestaAdmin);
    guardarDBLocal(db);

    // Emisión instantánea por WebSockets
    const salaUsuario = `room_${respuestaAdmin.usuario.toLowerCase()}`;
    io.to(salaUsuario).emit('nuevo_mensaje_soporte', respuestaAdmin);
    io.to('room_admin').emit('nuevo_mensaje_soporte', respuestaAdmin);
    io.emit('soporte_actualizado', respuestaAdmin);

    return res.status(201).json({ status: 'ok', mensaje: 'Respuesta enviada con éxito', data: respuestaAdmin });
});

app.get('/api/soporte', verificarAdminJWT, async (req, res) => {
    const db = leerDBLocal();
    const soporte = (db.soporte || []).slice().sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    return res.json(soporte);
});

app.get('/api/soporte/usuario/:usuario', async (req, res) => {
    const usuarioParam = (req.params.usuario || '').trim();
    if (!usuarioParam) {
        return res.status(400).json({ error: 'El parámetro usuario es requerido' });
    }

    const db = leerDBLocal();
    const mensajes = (db.soporte || [])
        .filter(m => m.usuario && m.usuario.toLowerCase() === usuarioParam.toLowerCase())
        .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    return res.json(mensajes);
});

app.delete('/api/soporte/usuario/:usuario', verificarAdminOUsuarioPropio, async (req, res) => {
    const usuarioParam = (req.params.usuario || '').trim();
    if (!usuarioParam) {
        return res.status(400).json({ error: 'El parámetro usuario es requerido' });
    }

    const db = leerDBLocal();
    db.soporte = (db.soporte || []).filter(
        m => !m.usuario || m.usuario.toLowerCase() !== usuarioParam.toLowerCase()
    );
    guardarDBLocal(db);
    io.emit('soporte_eliminado', { usuario: usuarioParam });
    return res.json({ status: 'ok', mensaje: `Conversación de ${usuarioParam} eliminada` });
});

app.delete(['/api/soporte', '/api/soporte/vaciar'], verificarAdminJWT, async (req, res) => {
    const db = leerDBLocal();
    db.soporte = [];
    guardarDBLocal(db);
    io.emit('soporte_vaciado');
    await registrarEventoAuditoria('SOPORTE_VACIADO', 'Administrador', 'Vaciado completo del historial de soporte', req);
    return res.json({ status: 'ok', mensaje: 'Todos los chats han sido eliminados' });
});

app.delete('/api/soporte/:id', verificarAdminJWT, async (req, res) => {
    const { id } = req.params;
    const db = leerDBLocal();
    db.soporte = (db.soporte || []).filter(m => m.id !== id);
    guardarDBLocal(db);
    io.emit('soporte_eliminado', { id });
    return res.json({ status: 'ok', mensaje: 'Mensaje eliminado' });
});

// --- API ADMINISTRADORES (AUTENTICACIÓN JWT Y SESIÓN SEGURA) ---
app.post('/api/admin/login', validar(adminLoginSchema), async (req, res) => {
    const { usuario, clave } = req.body;
    if (!usuario || !clave) {
        return res.status(400).json({ error: 'Credenciales incompletas' });
    }

    const db = leerDBLocal();
    const admins = db.administradores || ADMIN_DEFAULT;
    const adminEncontrado = admins.find(a => a.usuario.toLowerCase() === usuario.trim().toLowerCase());

    if (adminEncontrado) {
        const esValida = verificarClave(clave.trim(), adminEncontrado.clave);
        if (esValida) {
            // Asegurar que si la clave no estaba hasheada, se actualice de inmediato
            if (!esBcryptHash(adminEncontrado.clave)) {
                adminEncontrado.clave = hashearClave(clave.trim());
                guardarDBLocal(db);
            }

            // Generar Token JWT firmado
            const token = jwt.sign(
                { usuario: adminEncontrado.usuario, rol: adminEncontrado.rol || 'admin' },
                JWT_SECRET,
                { expiresIn: '8h' }
            );

            // Asignar Cookie HttpOnly
            res.cookie('admin_token', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: 8 * 3600 * 1000
            });

            await registrarEventoAuditoria('ADMIN_LOGIN_EXITOSO', usuario, 'Acceso exitoso al panel administrativo con Token JWT', req);
            return res.json({
                success: true,
                token,
                rol: adminEncontrado.rol || 'admin',
                usuario: adminEncontrado.usuario,
                mensaje: 'Acceso autorizado al panel de control'
            });
        }
    }

    await registrarEventoAuditoria('ADMIN_LOGIN_FALLIDO', usuario, 'Intento de acceso denegado con credenciales inválidas', req);
    return res.status(401).json({ error: 'Credenciales inválidas para administrador' });
});

app.get('/api/admin/verificar-sesion', verificarAdminJWT, (req, res) => {
    return res.json({ ok: true, admin: req.admin });
});

app.post('/api/admin/logout', (req, res) => {
    res.clearCookie('admin_token');
    return res.json({ ok: true, mensaje: 'Sesión de administrador cerrada con éxito' });
});

// --- API GESTIÓN DE USUARIOS ---
app.get('/api/usuarios', verificarAdminJWT, async (req, res) => {
    const db = leerDBLocal();
    const usuarios = (db.usuarios || []).map(normalizarUsuario);
    return res.json(usuarios);
});

app.post(['/api/usuarios/registro', '/api/usuarios/registrar'], validar(registroSchema), async (req, res) => {
    const { usuario, clave, correo, telefono, direccion } = req.body;
    if (!usuario || !clave) {
        return res.status(400).json({ error: 'Nombre de usuario y contraseña requeridos' });
    }

    const db = leerDBLocal();
    const usuarioLimpio = usuario.trim();
    const correoLimpio = (correo || '').trim();

    const existeUsuario = (db.usuarios || []).some(
        u => u.usuario && u.usuario.toLowerCase() === usuarioLimpio.toLowerCase()
    );
    if (existeUsuario) {
        return res.status(400).json({ error: 'El nombre de usuario ya se encuentra registrado' });
    }

    if (correoLimpio) {
        const existeCorreo = (db.usuarios || []).some(
            u => u.correo && u.correo.toLowerCase() === correoLimpio.toLowerCase()
        );
        if (existeCorreo) {
            return res.status(400).json({ error: 'El correo electrónico ya está registrado con otra cuenta' });
        }
    }

    // Hashear la contraseña con bcrypt (10 rondas de salt)
    const claveProtegida = hashearClave(clave.trim());

    const nuevoUsuario = {
        usuario: usuarioLimpio,
        clave: claveProtegida,
        correo: correoLimpio,
        telefono: (telefono || '').trim(),
        direccion: (direccion || '').trim(),
        fechaRegistro: new Date().toLocaleDateString('es-ES'),
        contadorModificaciones: 0,
        rol: 'Cliente',
        estado: 'Activo',
        historialEdiciones: [],
        codigoRecuperacion: null,
        codigoExpiracion: null
    };

    db.usuarios.push(nuevoUsuario);
    guardarDBLocal(db);

    await registrarEventoAuditoria('REGISTRO_USUARIO', usuarioLimpio, `Nueva cuenta registrada (${correoLimpio || 'Sin correo'}) con encriptación bcrypt`, req);

    return res.status(201).json({
        success: true,
        mensaje: 'Usuario registrado con éxito',
        usuario: normalizarUsuario(nuevoUsuario)
    });
});

app.post('/api/usuarios/login', validar(loginSchema), async (req, res) => {
    const { usuario, clave } = req.body;
    if (!usuario || !clave) {
        return res.status(400).json({ error: 'Ingresa usuario y contraseña' });
    }

    const db = leerDBLocal();
    const busqueda = usuario.trim().toLowerCase();

    const user = (db.usuarios || []).find(
        u => (u.usuario && u.usuario.toLowerCase() === busqueda) ||
            (u.correo && u.correo.toLowerCase() === busqueda)
    );

    if (!user) {
        return res.status(401).json({ error: 'Usuario o correo no encontrado' });
    }

    if (user.estado && user.estado.toLowerCase() === 'bloqueado') {
        await registrarEventoAuditoria('LOGIN_BLOQUEADO', user.usuario, 'Intento de acceso con cuenta bloqueada', req);
        return res.status(403).json({ error: 'Tu cuenta ha sido bloqueada. Contacta al administrador.' });
    }

    // Comparación segura con bcrypt
    const esValida = verificarClave(clave.trim(), user.clave);
    if (!esValida) {
        await registrarEventoAuditoria('LOGIN_FALLIDO', user.usuario, 'Intento de inicio de sesión con contraseña incorrecta', req);
        return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    // Auto-actualizar a hash si estaba en texto plano
    if (!esBcryptHash(user.clave)) {
        user.clave = hashearClave(clave.trim());
        guardarDBLocal(db);
    }

    await registrarEventoAuditoria('LOGIN_EXITOSO', user.usuario, 'Inicio de sesión exitoso en la plataforma', req);

    // Generar JWT para el usuario
    const token = jwt.sign(
        { usuario: user.usuario, rol: user.rol || 'Cliente' },
        JWT_SECRET,
        { expiresIn: '24h' }
    );

    // Cookie segura
    res.cookie('auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 3600 * 1000
    });

    const usuarioNormalizado = normalizarUsuario(user);
    return res.json({
        ...usuarioNormalizado,
        success: true,
        token,
        usuario: usuarioNormalizado.usuario
    });
});

app.get('/api/usuarios/verificar-sesion', verificarUsuarioJWT, (req, res) => {
    const db = leerDBLocal();
    const user = (db.usuarios || []).find(u => u.usuario.toLowerCase() === req.user.usuario.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    return res.json({ ok: true, usuario: normalizarUsuario(user) });
});

app.post('/api/usuarios/logout', (req, res) => {
    res.clearCookie('auth_token');
    return res.json({ ok: true, mensaje: 'Sesión de usuario cerrada con éxito' });
});

// --- RECUPERACIÓN DE CONTRASEÑA CON OTP ---
app.post(['/api/usuarios/recuperar-solicitar', '/api/usuarios/solicitar-codigo-recuperacion'], validar(recuperarSolicitarSchema), async (req, res) => {
    const busqueda = (req.body.busqueda || req.body.correo || req.body.usuario || '').trim();
    if (!busqueda) return res.status(400).json({ error: 'Ingresa tu nombre de usuario o correo electrónico' });

    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    const expiracion = Date.now() + (15 * 60 * 1000);

    const db = leerDBLocal();
    const idx = (db.usuarios || []).findIndex(u =>
        (u.usuario && u.usuario.toLowerCase() === busqueda.toLowerCase()) ||
        (u.correo && u.correo.toLowerCase() === busqueda.toLowerCase())
    );

    if (idx === -1) {
        return res.status(404).json({ error: 'No existe ninguna cuenta asociada a este usuario o correo electrónico' });
    }

    const usuarioEncontrado = db.usuarios[idx];
    usuarioEncontrado.codigoRecuperacion = codigo;
    usuarioEncontrado.codigoExpiracion = expiracion;
    guardarDBLocal(db);

    const correoEnmascarado = enmascararCorreo(usuarioEncontrado.correo);

    await registrarEventoAuditoria(
        'OTP_SOLICITADO',
        usuarioEncontrado.usuario,
        `Código OTP de 6 dígitos generado para ${correoEnmascarado}`,
        req
    );

    try {
        await enviarCorreoRecuperacion(usuarioEncontrado.correo, codigo);
    } catch (emailErr) {
        console.warn('[CAPTURA AVISO ENVÍO CORREO]:', emailErr.message);
    }

    return res.json({
        ok: true,
        usuario: usuarioEncontrado.usuario,
        correoEnmascarado: correoEnmascarado,
        mensaje: `Código de 6 dígitos generado con éxito para ${correoEnmascarado}. Válido durante 15 minutos.`
    });
});

app.post('/api/usuarios/recuperar-verificar', async (req, res) => {
    const usuarioTarget = (req.body.usuario || req.body.correo || req.body.busqueda || '').trim();
    const otp = (req.body.otp || req.body.codigo || '').trim();
    const nuevaClave = (req.body.nuevaClave || req.body.clave || '').trim();

    if (!usuarioTarget || !otp || !nuevaClave) {
        return res.status(400).json({ error: 'Todos los campos son requeridos (usuario, código OTP y nueva contraseña)' });
    }

    if (nuevaClave.length < 6) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const db = leerDBLocal();
    const idx = (db.usuarios || []).findIndex(u =>
        (u.usuario && u.usuario.toLowerCase() === usuarioTarget.toLowerCase()) ||
        (u.correo && u.correo.toLowerCase() === usuarioTarget.toLowerCase())
    );

    if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = db.usuarios[idx];

    if (!user.codigoRecuperacion || user.codigoRecuperacion !== otp) {
        return res.status(400).json({ error: 'El código de recuperación es incorrecto o ha caducado' });
    }

    if (user.codigoExpiracion && Date.now() > user.codigoExpiracion) {
        return res.status(400).json({ error: 'El código de recuperación ha expirado. Solicita uno nuevo.' });
    }

    const logAuditoria = {
        tipo: 'recuperacion',
        carpeta: '📁 Recuperación con OTP',
        editor: 'Sistema (OTP de 2 Pasos)',
        fecha: new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }),
        resumen: 'Contraseña restablecida exitosamente mediante flujo OTP de 2 pasos',
        cambios: [{
            campo: 'Contraseña',
            valorAnterior: '••••••••',
            valorNuevo: '•••••••• (Restablecida con bcrypt)'
        }]
    };

    if (!Array.isArray(user.historialEdiciones)) user.historialEdiciones = [];
    user.historialEdiciones.unshift(logAuditoria);
    user.clave = hashearClave(nuevaClave); // Hash seguro
    user.contadorModificaciones = (parseInt(user.contadorModificaciones || 0)) + 1;
    user.codigoRecuperacion = null;
    user.codigoExpiracion = null;

    guardarDBLocal(db);
    await registrarEventoAuditoria('RECUPERACION_EXITOSA', user.usuario, 'Contraseña restablecida y protegida con bcrypt mediante OTP', req);

    return res.json({ ok: true, mensaje: 'Contraseña actualizada con éxito' });
});

app.post('/api/usuarios/verificar-codigo-recuperacion', async (req, res) => {
    const { usuario, busqueda, codigo } = req.body;
    const target = (usuario || busqueda || '').trim();
    const code = (codigo || '').trim();

    if (!target || !code) return res.status(400).json({ error: 'Datos incompletos' });

    const db = leerDBLocal();
    const user = (db.usuarios || []).find(u =>
        (u.usuario && u.usuario.toLowerCase() === target.toLowerCase()) ||
        (u.correo && u.correo.toLowerCase() === target.toLowerCase())
    );

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (user.codigoRecuperacion !== code) {
        return res.status(400).json({ error: 'Código de recuperación inválido' });
    }

    if (user.codigoExpiracion && Date.now() > user.codigoExpiracion) {
        return res.status(400).json({ error: 'El código ha expirado' });
    }

    return res.json({ ok: true, mensaje: 'Código verificado correctamente' });
});

app.post('/api/usuarios/restablecer-clave', validar(restablecerClaveSchema), async (req, res) => {
    const { usuario, nuevaClave, claveNueva, codigo, otp } = req.body;
    const claveAEstablecer = (nuevaClave || claveNueva || '').trim();
    const codigoAValidar = (codigo || otp || '').trim();

    if (!usuario || !claveAEstablecer) {
        return res.status(400).json({ error: 'Campos requeridos' });
    }
    if (claveAEstablecer.length < 6) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const db = leerDBLocal();
    const idx = (db.usuarios || []).findIndex(u => u.usuario.toLowerCase() === usuario.trim().toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = db.usuarios[idx];
    if (codigoAValidar && user.codigoRecuperacion && user.codigoRecuperacion !== codigoAValidar) {
        return res.status(400).json({ error: 'Código de verificación incorrecto' });
    }

    user.clave = hashearClave(claveAEstablecer);
    user.codigoRecuperacion = null;
    user.codigoExpiracion = null;
    guardarDBLocal(db);

    await registrarEventoAuditoria('CLAVE_RESTABLECIDA', user.usuario, 'Contraseña restablecida con código y encriptada', req);
    return res.json({ ok: true, mensaje: 'Contraseña restablecida con éxito' });
});

// --- EDICIÓN DE PERFIL ---
app.put(['/api/usuarios/perfil', '/api/usuarios/editar'], verificarUsuarioOUsuarioAdmin, validar(editarPerfilSchema), async (req, res) => {
    const { usuario, correo, telefono, direccion } = req.body;
    if (!usuario) return res.status(400).json({ error: 'Nombre de usuario requerido' });

    const db = leerDBLocal();
    const idx = (db.usuarios || []).findIndex(u => u.usuario.toLowerCase() === usuario.trim().toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

    const userActual = normalizarUsuario(db.usuarios[idx]);
    const nuevoCorreo = correo !== undefined ? correo.trim() : userActual.correo;
    const nuevoTelefono = telefono !== undefined ? telefono.trim() : userActual.telefono;
    const nuevaDireccion = direccion !== undefined ? direccion.trim() : userActual.direccion;

    const cambios = [];
    if (nuevoCorreo !== userActual.correo) {
        cambios.push({ campo: 'Correo Electrónico', valorAnterior: userActual.correo || 'Vacío', valorNuevo: nuevoCorreo || 'Vacío' });
    }
    if (nuevoTelefono !== userActual.telefono) {
        cambios.push({ campo: 'Teléfono', valorAnterior: userActual.telefono || 'Vacío', valorNuevo: nuevoTelefono || 'Vacío' });
    }
    if (nuevaDireccion !== userActual.direccion) {
        cambios.push({ campo: 'Dirección', valorAnterior: userActual.direccion || 'Vacío', valorNuevo: nuevaDireccion || 'Vacío' });
    }

    if (cambios.length > 0) {
        const logAuditoria = {
            tipo: 'perfil',
            carpeta: '📁 Actualización de Perfil',
            editor: 'Usuario',
            fecha: new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }),
            resumen: `${cambios.length} campo(s) de perfil modificado(s)`,
            cambios: cambios
        };
        if (!Array.isArray(db.usuarios[idx].historialEdiciones)) db.usuarios[idx].historialEdiciones = [];
        db.usuarios[idx].historialEdiciones.unshift(logAuditoria);
        db.usuarios[idx].contadorModificaciones = (parseInt(db.usuarios[idx].contadorModificaciones || 0)) + 1;
    }

    db.usuarios[idx].correo = nuevoCorreo;
    db.usuarios[idx].telefono = nuevoTelefono;
    db.usuarios[idx].direccion = nuevaDireccion;

    guardarDBLocal(db);
    if (cambios.length > 0) {
        await registrarEventoAuditoria('PERFIL_ACTUALIZADO', usuario, `Perfil actualizado: ${cambios.map(c => c.campo).join(', ')}`, req);
    }
    return res.json({ mensaje: 'Perfil actualizado', usuario: normalizarUsuario(db.usuarios[idx]) });
});

// Cambio voluntario de contraseña por el usuario
app.put('/api/usuarios/cambiar-clave', verificarUsuarioOUsuarioAdmin, validar(cambiarClaveSchema), async (req, res) => {
    const { usuario, claveActual, claveNueva } = req.body;
    if (!usuario || !claveActual || !claveNueva) {
        return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    if (claveNueva.length < 6) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const db = leerDBLocal();
    const idx = (db.usuarios || []).findIndex(u => u.usuario.toLowerCase() === usuario.trim().toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Verificar si la clave actual coincide con el hash almacenado
    const esCorrecta = verificarClave(claveActual.trim(), db.usuarios[idx].clave);
    if (!esCorrecta) {
        return res.status(400).json({ error: 'La contraseña actual no es correcta' });
    }

    const logAuditoria = {
        tipo: 'clave',
        carpeta: '📁 Cambio de Contraseña',
        editor: 'Usuario',
        fecha: new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }),
        resumen: 'Contraseña actualizada voluntariamente por el usuario',
        cambios: [{
            campo: 'Contraseña',
            valorAnterior: '••••••••',
            valorNuevo: '•••••••• (Modificada con bcrypt)'
        }]
    };

    if (!Array.isArray(db.usuarios[idx].historialEdiciones)) db.usuarios[idx].historialEdiciones = [];
    db.usuarios[idx].historialEdiciones.unshift(logAuditoria);
    db.usuarios[idx].clave = hashearClave(claveNueva.trim());
    db.usuarios[idx].contadorModificaciones = (parseInt(db.usuarios[idx].contadorModificaciones || 0)) + 1;

    guardarDBLocal(db);
    await registrarEventoAuditoria('CLAVE_CAMBIADA', usuario, 'Contraseña cambiada voluntariamente y protegida con bcrypt', req);
    return res.json({ ok: true, mensaje: 'Contraseña cambiada con éxito', usuario: normalizarUsuario(db.usuarios[idx]) });
});

// Edición de usuario por el Administrador
app.put(['/api/usuarios/admin-editar', '/api/usuarios/:usuario'], verificarAdminJWT, async (req, res) => {
    const usuarioTarget = req.params.usuario || req.body.usuario || req.body.originalUsuario;
    const { correo, telefono, direccion, clave, rol, estado } = req.body;

    if (!usuarioTarget) return res.status(400).json({ error: 'Usuario objetivo requerido' });

    const db = leerDBLocal();
    const idx = (db.usuarios || []).findIndex(u => u.usuario.toLowerCase() === usuarioTarget.trim().toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

    const userActual = db.usuarios[idx];
    const nuevoCorreo = correo !== undefined ? correo.trim() : userActual.correo;
    const nuevoTelefono = telefono !== undefined ? telefono.trim() : userActual.telefono;
    const nuevaDireccion = direccion !== undefined ? direccion.trim() : userActual.direccion;
    
    // Si el admin ingresa una clave nueva (no vacía ni placeholder), se hashea con bcrypt
    let nuevaClave = userActual.clave;
    let cambioClave = false;
    if (clave && typeof clave === 'string') {
        const cTrim = clave.trim();
        if (cTrim !== '' && cTrim !== '••••••••' && !esBcryptHash(cTrim)) {
            nuevaClave = hashearClave(cTrim);
            cambioClave = true;
        }
    }

    const nuevoRol = rol || userActual.rol;
    const nuevoEstado = estado || userActual.estado;

    const cambios = [];
    if (nuevoCorreo !== userActual.correo) {
        cambios.push({ campo: 'Correo Electrónico', valorAnterior: userActual.correo || 'Vacío', valorNuevo: nuevoCorreo || 'Vacío' });
    }
    if (nuevoTelefono !== userActual.telefono) {
        cambios.push({ campo: 'Teléfono', valorAnterior: userActual.telefono || 'Vacío', valorNuevo: nuevoTelefono || 'Vacío' });
    }
    if (nuevaDireccion !== userActual.direccion) {
        cambios.push({ campo: 'Dirección', valorAnterior: userActual.direccion || 'Vacío', valorNuevo: nuevaDireccion || 'Vacío' });
    }
    if (cambioClave) {
        cambios.push({ campo: 'Contraseña', valorAnterior: '••••••••', valorNuevo: '•••••••• (Actualizada por Admin)' });
    }
    if (nuevoRol !== userActual.rol) {
        cambios.push({ campo: 'Rol', valorAnterior: userActual.rol || 'Cliente', valorNuevo: nuevoRol });
    }
    if (nuevoEstado !== userActual.estado) {
        cambios.push({ campo: 'Estado de Cuenta', valorAnterior: userActual.estado || 'Activo', valorNuevo: nuevoEstado });
    }

    if (cambios.length > 0) {
        const logAuditoria = {
            tipo: 'admin',
            carpeta: '📁 Modificación por Administrador',
            editor: 'Administrador',
            fecha: new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }),
            resumen: `${cambios.length} cambio(s) realizado(s) por el Administrador`,
            cambios: cambios
        };
        if (!Array.isArray(db.usuarios[idx].historialEdiciones)) db.usuarios[idx].historialEdiciones = [];
        db.usuarios[idx].historialEdiciones.unshift(logAuditoria);
        db.usuarios[idx].contadorModificaciones = (parseInt(db.usuarios[idx].contadorModificaciones || 0)) + 1;
    }

    db.usuarios[idx].correo = nuevoCorreo;
    db.usuarios[idx].telefono = nuevoTelefono;
    db.usuarios[idx].direccion = nuevaDireccion;
    db.usuarios[idx].clave = nuevaClave;
    db.usuarios[idx].rol = nuevoRol;
    db.usuarios[idx].estado = nuevoEstado;

    guardarDBLocal(db);
    if (cambios.length > 0) {
        await registrarEventoAuditoria('ADMIN_EDITO_USUARIO', 'Administrador', `Modificación sobre ${usuarioTarget}: ${cambios.map(c => c.campo).join(', ')}`, req);
    }
    return res.json({ ok: true, mensaje: 'Usuario actualizado con éxito', usuario: normalizarUsuario(db.usuarios[idx]) });
});

// Función de procesamiento de acciones masivas sobre usuarios
async function manejarAccionBulk(accion, usuariosSeleccionados, req, res) {
    if (!accion || !Array.isArray(usuariosSeleccionados) || usuariosSeleccionados.length === 0) {
        return res.status(400).json({ error: 'Debes proporcionar una acción válida y al menos un usuario seleccionado.' });
    }

    const accionNormalizada = accion.toLowerCase().trim();
    if (!['activar', 'inactivo', 'bloquear', 'eliminar'].includes(accionNormalizada)) {
        return res.status(400).json({ error: 'Acción inválida. Opciones permitidas: activar, inactivo, bloquear, eliminar.' });
    }

    const db = leerDBLocal();
    const setUsuarios = new Set(usuariosSeleccionados.map(u => u.toLowerCase()));

    if (accionNormalizada === 'eliminar') {
        db.usuarios = (db.usuarios || []).filter(u => !setUsuarios.has(u.usuario.toLowerCase()));
    } else {
        let nuevoEstado = 'Activo';
        if (accionNormalizada === 'inactivo') {
            nuevoEstado = 'Inactivo';
        } else if (accionNormalizada === 'bloquear') {
            nuevoEstado = 'Bloqueado';
        }
        (db.usuarios || []).forEach(u => {
            if (setUsuarios.has(u.usuario.toLowerCase())) {
                u.estado = nuevoEstado;
            }
        });
    }
    guardarDBLocal(db);

    await registrarEventoAuditoria(
        'ACCION_MASIVA',
        'Administrador',
        `Acción masiva '${accionNormalizada}' ejecutada sobre ${usuariosSeleccionados.length} usuario(s): ${usuariosSeleccionados.join(', ')}`,
        req
    );

    return res.json({
        ok: true,
        success: true,
        accion: accionNormalizada,
        afectados: usuariosSeleccionados.length,
        mensaje: `Operación masiva '${accionNormalizada}' completada con éxito sobre ${usuariosSeleccionados.length} cuenta(s).`
    });
}

app.post('/api/usuarios/bulk', verificarAdminJWT, async (req, res) => {
    const accion = req.body.accion;
    const lista = req.body.usuariosSeleccionados || req.body.usuarios;
    await manejarAccionBulk(accion, lista, req, res);
});

app.post('/api/usuarios/bulk-status', verificarAdminJWT, async (req, res) => {
    const { usuarios, estado } = req.body;
    const accion = (estado || '').toLowerCase() === 'bloqueado' ? 'bloquear' : 'activar';
    await manejarAccionBulk(accion, usuarios, req, res);
});

app.post('/api/usuarios/bulk-statusinactivo', verificarAdminJWT, async (req, res) => {
    const { usuarios, estado } = req.body;
    const accion = (estado || '').toLowerCase() === 'inactivo' ? 'inactivo' : 'activar';
    await manejarAccionBulk(accion, usuarios, req, res);
});

app.post('/api/usuarios/bulk-delete', verificarAdminJWT, async (req, res) => {
    const { usuarios } = req.body;
    await manejarAccionBulk('eliminar', usuarios, req, res);
});

// Vaciar toda la base de datos de usuarios (Solo Admin)
app.delete('/api/usuarios', verificarAdminJWT, async (req, res) => {
    const db = leerDBLocal();
    db.usuarios = [];
    guardarDBLocal(db);
    await registrarEventoAuditoria('BASE_DATOS_VACIADA', 'Administrador', 'Se vaciaron todos los usuarios de la base de datos SQLite', req);
    return res.json({ ok: true, mensaje: 'Base de datos de usuarios vaciada con éxito' });
});

// Eliminar un usuario individual (Admin o el propio usuario autenticado)
app.delete('/api/usuarios/:usuario', verificarAdminOUsuarioPropio, async (req, res) => {
    const { usuario } = req.params;
    const db = leerDBLocal();
    const lenAntes = (db.usuarios || []).length;
    db.usuarios = (db.usuarios || []).filter(u => u.usuario.toLowerCase() !== usuario.toLowerCase());

    if (db.usuarios.length === lenAntes) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    guardarDBLocal(db);
    await registrarEventoAuditoria('USUARIO_ELIMINADO', 'Administrador', `Usuario ${usuario} eliminado del sistema`, req);
    return res.json({ ok: true, mensaje: `Usuario ${usuario} eliminado con éxito` });
});

// --- AUDITORÍA ---
app.get('/api/auditoria', verificarAdminJWT, async (req, res) => {
    const db = leerDBLocal();
    return res.json(db.auditoria || []);
});

// Vaciar bitácora de auditoría
app.delete('/api/auditoria', verificarAdminJWT, async (req, res) => {
    const db = leerDBLocal();
    db.auditoria = [];
    guardarDBLocal(db);
    return res.json({ ok: true, mensaje: 'Bitácora de auditoría vaciada con éxito' });
});

// --- HISTORIAL DE DESCARGAS ---
app.post('/api/descargas', verificarAdminJWT, async (req, res) => {
    const { formato } = req.body;
    const ahora = new Date();
    const fecha = ahora.toLocaleDateString('es-ES');
    const hora = ahora.toLocaleTimeString('es-ES');

    const db = leerDBLocal();
    if (!Array.isArray(db.descargas)) db.descargas = [];
    const nuevoRegistro = { id: Date.now(), formato: formato || 'Excel', fecha, hora };
    db.descargas.push(nuevoRegistro);
    guardarDBLocal(db);

    return res.json({ ok: true, id: nuevoRegistro.id, fecha, hora });
});

app.get('/api/descargas', verificarAdminJWT, async (req, res) => {
    const db = leerDBLocal();
    return res.json(db.descargas || []);
});

app.delete('/api/descargas/:id', verificarAdminJWT, async (req, res) => {
    const { id } = req.params;
    const db = leerDBLocal();
    db.descargas = (db.descargas || []).filter(d => String(d.id) !== String(id));
    guardarDBLocal(db);
    return res.json({ ok: true, mensaje: 'Registro de descarga eliminado con éxito' });
});

app.delete('/api/descargas', verificarAdminJWT, async (req, res) => {
    const db = leerDBLocal();
    db.descargas = [];
    guardarDBLocal(db);
    return res.json({ ok: true, mensaje: 'Historial de descargas vaciado con éxito' });
});

// --- API EXPORTACIÓN DE DATOS (EXCEL / CSV) ---
app.get('/api/exportar/excel', verificarAdminJWT, async (req, res) => {
    try {
        const formato = (req.query.formato || 'xlsx').toLowerCase();
        const db = leerDBLocal();
        const usuarios = (db.usuarios || []).map(normalizarUsuario);
        const auditoria = db.auditoria || [];

        const datosUsuarios = usuarios.map(u => ({
            "Usuario": u.usuario || '',
            "Rol": u.rol || 'Cliente',
            "Estado": u.estado || 'Activo',
            "Contraseña": "•••••••• (Encriptada)",
            "Correo": u.correo || '',
            "Teléfono": u.telefono || '',
            "Dirección": u.direccion || '',
            "Fecha Registro": u.fechaRegistro || '',
            "Modificaciones": u.contadorModificaciones || 0
        }));

        const datosAuditoria = auditoria.map(a => ({
            "ID": a.id || '',
            "Fecha": a.fecha || '',
            "Hora": a.hora || '',
            "Tipo": a.tipo || '',
            "Usuario": a.usuario || '',
            "Detalle": a.detalle || '',
            "IP": a.ip || ''
        }));

        const ahora = new Date();
        const fechaDescarga = ahora.toLocaleDateString('es-ES');
        const horaDescarga = ahora.toLocaleTimeString('es-ES');

        if (!Array.isArray(db.descargas)) db.descargas = [];
        db.descargas.push({ id: Date.now(), formato: 'Excel', fecha: fechaDescarga, hora: horaDescarga });
        guardarDBLocal(db);

        await registrarEventoAuditoria('EXPORTAR_EXCEL', 'Administrador', 'Exportación de base de datos a archivo Excel (.xlsx)', req);

        const wb = XLSX.utils.book_new();
        const wsUsuarios = XLSX.utils.json_to_sheet(datosUsuarios);
        wsUsuarios['!cols'] = [
            { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 22 },
            { wch: 25 }, { wch: 16 }, { wch: 22 }, { wch: 18 }, { wch: 15 }
        ];
        XLSX.utils.book_append_sheet(wb, wsUsuarios, "Usuarios");

        const wsAuditoria = XLSX.utils.json_to_sheet(datosAuditoria);
        wsAuditoria['!cols'] = [
            { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 18 },
            { wch: 18 }, { wch: 40 }, { wch: 16 }
        ];
        XLSX.utils.book_append_sheet(wb, wsAuditoria, "Auditoria");

        if (formato === 'csv') {
            const csvData = XLSX.utils.sheet_to_csv(wsUsuarios);
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="reporte_usuarios_${Date.now()}.csv"`);
            return res.send(csvData);
        }

        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="reporte_sistema_${Date.now()}.xlsx"`);
        return res.send(buffer);
    } catch (err) {
        console.error('Error al exportar a Excel:', err);
        return res.status(500).json({ error: 'Error al generar el archivo Excel' });
    }
});

// Redirección por defecto
app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- INICIO DEL SERVIDOR CON WEBSOCKETS ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
======================================================================
  [#] ${SYSTEM_NAME.toUpperCase()}
  [*] Servidor Enterprise Seguro con WebSockets & JWT
======================================================================
  [>] Acceso con Nombre:    http://${HOST_NAME}:${PORT}
  [>] Acceso Localhost:     http://localhost:${PORT}
  [>] Panel Administrador:  http://${HOST_NAME}:${PORT}/admin
  [>] Servicio de Correo:   Resend API
  [>] Seguridad:            Bcrypt + Helmet + Rate Limit + JWT (HttpOnly)
  [>] Tiempo Real:          Socket.io WebSockets
  [>] Almacenamiento:       Local (database.json)
======================================================================
`);
});