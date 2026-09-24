require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Resend } = require('resend');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;
const SYSTEM_NAME = process.env.SYSTEM_NAME || 'Sistema de Gestión de Usuarios';
const HOST_NAME = process.env.HOST_NAME || 'sistema.local';

const PRIMARY_DB_FILE = path.join(__dirname, 'database.json');
const LEGACY_DB_FILE = path.join(__dirname, 'db.json');

// --- MIDDLEWARES GLOBALES ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// --- CACHÉ EN MEMORIA PARA MÁXIMA VELOCIDAD LOCAL ---
let dbCache = null;

function leerDBLocal() {
    if (dbCache) return dbCache;

    let targetFile = PRIMARY_DB_FILE;
    if (!fs.existsSync(PRIMARY_DB_FILE) && fs.existsSync(LEGACY_DB_FILE)) {
        targetFile = LEGACY_DB_FILE;
    }

    if (!fs.existsSync(targetFile)) {
        const initialData = {
            usuarios: [],
            administradores: ADMIN_DEFAULT,
            descargas: [],
            soporte: [],
            auditoria: [{
                id: Date.now().toString(),
                fecha: new Date().toLocaleDateString('es-ES'),
                hora: new Date().toLocaleTimeString('es-ES'),
                tipo: 'INICIALIZACION',
                usuario: 'Sistema',
                detalle: 'Inicialización de la base de datos local en database.json',
                ip: '127.0.0.1'
            }]
        };
        try {
            fs.writeFileSync(PRIMARY_DB_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
            fs.writeFileSync(LEGACY_DB_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
        } catch (e) {
            console.error('Error creando base de datos inicial:', e);
        }
        dbCache = initialData;
        return dbCache;
    }

    try {
        const raw = fs.readFileSync(targetFile, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
            dbCache = { usuarios: data, administradores: ADMIN_DEFAULT, descargas: [], soporte: [], auditoria: [] };
        } else {
            if (!data.administradores || !Array.isArray(data.administradores) || data.administradores.length === 0) {
                data.administradores = ADMIN_DEFAULT;
            }
            if (!Array.isArray(data.descargas)) data.descargas = [];
            if (!Array.isArray(data.usuarios)) data.usuarios = [];
            if (!Array.isArray(data.soporte)) data.soporte = [];
            if (!Array.isArray(data.auditoria)) data.auditoria = [];
            dbCache = data;
        }
        return dbCache;
    } catch (e) {
        console.error('Error al leer base de datos local:', e.message);
        dbCache = { usuarios: [], administradores: ADMIN_DEFAULT, descargas: [], soporte: [], auditoria: [] };
        return dbCache;
    }
}

function guardarDBLocal(data) {
    dbCache = data;
    const jsonStr = JSON.stringify(data, null, 2);
    try {
        fs.writeFileSync(PRIMARY_DB_FILE, jsonStr, 'utf-8');
    } catch (err) {
        console.error('Error escribiendo en database.json:', err.message);
    }
    try {
        fs.writeFileSync(LEGACY_DB_FILE, jsonStr, 'utf-8');
    } catch (err) {
        // Silencioso para réplica
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

// Normalizador unificado de objetos usuario
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
        clave: u.clave || '',
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
        console.warn(`[EMAIL ADVERTENCIA] No se envió el correo porque falta RESEND_API_KEY en variables de entorno.`);
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

// --- API SOPORTE TÉCNICO ---
app.post(['/api/soporte', '/api/soporte/enviar'], async (req, res) => {
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
    return res.status(201).json({ status: 'ok', mensaje: 'Mensaje recibido con éxito', data: nuevoMensaje });
});

app.post('/api/soporte/responder', async (req, res) => {
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
    return res.status(201).json({ status: 'ok', mensaje: 'Respuesta enviada con éxito', data: respuestaAdmin });
});

app.get('/api/soporte', async (req, res) => {
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

app.delete('/api/soporte/usuario/:usuario', async (req, res) => {
    const usuarioParam = (req.params.usuario || '').trim();
    if (!usuarioParam) {
        return res.status(400).json({ error: 'El parámetro usuario es requerido' });
    }

    const db = leerDBLocal();
    db.soporte = (db.soporte || []).filter(
        m => !m.usuario || m.usuario.toLowerCase() !== usuarioParam.toLowerCase()
    );
    guardarDBLocal(db);
    return res.json({ status: 'ok', mensaje: `Conversación de ${usuarioParam} eliminada` });
});

app.delete(['/api/soporte', '/api/soporte/vaciar'], async (req, res) => {
    const db = leerDBLocal();
    db.soporte = [];
    guardarDBLocal(db);
    await registrarEventoAuditoria('SOPORTE_VACIADO', 'Administrador', 'Vaciado completo del historial de soporte', req);
    return res.json({ status: 'ok', mensaje: 'Todos los chats han sido eliminados' });
});

app.delete('/api/soporte/:id', async (req, res) => {
    const { id } = req.params;
    const db = leerDBLocal();
    db.soporte = (db.soporte || []).filter(m => m.id !== id);
    guardarDBLocal(db);
    return res.json({ status: 'ok', mensaje: 'Mensaje eliminado' });
});

// --- API ADMINISTRADORES ---
app.post('/api/admin/login', async (req, res) => {
    const { usuario, clave } = req.body;
    if (!usuario || !clave) {
        return res.status(400).json({ error: 'Credenciales incompletas' });
    }

    const db = leerDBLocal();
    const admins = db.administradores || ADMIN_DEFAULT;
    const adminEncontrado = admins.find(a => a.usuario.toLowerCase() === usuario.trim().toLowerCase());

    if (adminEncontrado && adminEncontrado.clave === clave.trim()) {
        await registrarEventoAuditoria('ADMIN_LOGIN_EXITOSO', usuario, 'Acceso exitoso al panel administrativo', req);
        return res.json({
            success: true,
            rol: adminEncontrado.rol || 'admin',
            usuario: adminEncontrado.usuario,
            mensaje: 'Acceso autorizado al panel de control'
        });
    }

    await registrarEventoAuditoria('ADMIN_LOGIN_FALLIDO', usuario, 'Intento de acceso denegado con credenciales inválidas', req);
    return res.status(401).json({ error: 'Credenciales inválidas para administrador' });
});

// --- API GESTIÓN DE USUARIOS ---
app.get('/api/usuarios', async (req, res) => {
    const db = leerDBLocal();
    const usuarios = (db.usuarios || []).map(normalizarUsuario);
    return res.json(usuarios);
});

app.post(['/api/usuarios/registro', '/api/usuarios/registrar'], async (req, res) => {
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

    const nuevoUsuario = {
        usuario: usuarioLimpio,
        clave: clave.trim(),
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

    await registrarEventoAuditoria('REGISTRO_USUARIO', usuarioLimpio, `Nueva cuenta registrada (${correoLimpio || 'Sin correo'})`, req);

    return res.status(201).json({
        success: true,
        mensaje: 'Usuario registrado con éxito',
        usuario: normalizarUsuario(nuevoUsuario)
    });
});

app.post('/api/usuarios/login', async (req, res) => {
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

    if (user.clave !== clave.trim()) {
        return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    await registrarEventoAuditoria('LOGIN_EXITOSO', user.usuario, 'Inicio de sesión exitoso en la plataforma', req);

    return res.json({
        success: true,
        usuario: normalizarUsuario(user),
        mensaje: 'Bienvenido de nuevo'
    });
});

// --- RECUPERACIÓN DE CONTRASEÑA CON OTP ---
app.post(['/api/usuarios/recuperar-solicitar', '/api/usuarios/solicitar-codigo-recuperacion'], async (req, res) => {
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
            valorNuevo: '•••••••• (Restablecida)'
        }]
    };

    if (!Array.isArray(user.historialEdiciones)) user.historialEdiciones = [];
    user.historialEdiciones.unshift(logAuditoria);
    user.clave = nuevaClave;
    user.contadorModificaciones = (parseInt(user.contadorModificaciones || 0)) + 1;
    user.codigoRecuperacion = null;
    user.codigoExpiracion = null;

    guardarDBLocal(db);
    await registrarEventoAuditoria('RECUPERACION_EXITOSA', user.usuario, 'Contraseña restablecida mediante código OTP verificado', req);

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

app.post('/api/usuarios/restablecer-clave', async (req, res) => {
    const { usuario, nuevaClave, codigo } = req.body;
    if (!usuario || !nuevaClave) {
        return res.status(400).json({ error: 'Campos requeridos' });
    }
    if (nuevaClave.length < 6) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }

    const db = leerDBLocal();
    const idx = (db.usuarios || []).findIndex(u => u.usuario.toLowerCase() === usuario.trim().toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = db.usuarios[idx];
    if (codigo && user.codigoRecuperacion && user.codigoRecuperacion !== codigo) {
        return res.status(400).json({ error: 'Código de verificación incorrecto' });
    }

    user.clave = nuevaClave.trim();
    user.codigoRecuperacion = null;
    user.codigoExpiracion = null;
    guardarDBLocal(db);

    await registrarEventoAuditoria('CLAVE_RESTABLECIDA', user.usuario, 'Contraseña restablecida con código', req);
    return res.json({ ok: true, mensaje: 'Contraseña restablecida con éxito' });
});

// --- EDICIÓN DE PERFIL ---
app.put(['/api/usuarios/perfil', '/api/usuarios/editar'], async (req, res) => {
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
app.put('/api/usuarios/cambiar-clave', async (req, res) => {
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

    if (db.usuarios[idx].clave !== claveActual) {
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
            valorNuevo: '•••••••• (Modificada)'
        }]
    };

    if (!Array.isArray(db.usuarios[idx].historialEdiciones)) db.usuarios[idx].historialEdiciones = [];
    db.usuarios[idx].historialEdiciones.unshift(logAuditoria);
    db.usuarios[idx].clave = claveNueva;
    db.usuarios[idx].contadorModificaciones = (parseInt(db.usuarios[idx].contadorModificaciones || 0)) + 1;

    guardarDBLocal(db);
    await registrarEventoAuditoria('CLAVE_CAMBIADA', usuario, 'Contraseña cambiada voluntariamente', req);
    return res.json({ ok: true, mensaje: 'Contraseña cambiada con éxito', usuario: normalizarUsuario(db.usuarios[idx]) });
});

// Edición de usuario por el Administrador
app.put(['/api/usuarios/admin-editar', '/api/usuarios/:usuario'], async (req, res) => {
    const usuarioTarget = req.params.usuario || req.body.usuario || req.body.originalUsuario;
    const { correo, telefono, direccion, clave, rol, estado } = req.body;

    if (!usuarioTarget) return res.status(400).json({ error: 'Usuario objetivo requerido' });

    const db = leerDBLocal();
    const idx = (db.usuarios || []).findIndex(u => u.usuario.toLowerCase() === usuarioTarget.trim().toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

    const userActual = normalizarUsuario(db.usuarios[idx]);
    const nuevoCorreo = correo !== undefined ? correo.trim() : userActual.correo;
    const nuevoTelefono = telefono !== undefined ? telefono.trim() : userActual.telefono;
    const nuevaDireccion = direccion !== undefined ? direccion.trim() : userActual.direccion;
    const nuevaClave = clave !== undefined && clave.trim() !== '' ? clave.trim() : userActual.clave;
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
    if (nuevaClave !== userActual.clave) {
        cambios.push({ campo: 'Contraseña', valorAnterior: userActual.clave || '••••••••', valorNuevo: nuevaClave });
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

app.post('/api/usuarios/bulk', async (req, res) => {
    const accion = req.body.accion;
    const lista = req.body.usuariosSeleccionados || req.body.usuarios;
    await manejarAccionBulk(accion, lista, req, res);
});

app.post('/api/usuarios/bulk-status', async (req, res) => {
    const { usuarios, estado } = req.body;
    const accion = (estado || '').toLowerCase() === 'bloqueado' ? 'bloquear' : 'activar';
    await manejarAccionBulk(accion, usuarios, req, res);
});

app.post('/api/usuarios/bulk-statusinactivo', async (req, res) => {
    const { usuarios, estado } = req.body;
    const accion = (estado || '').toLowerCase() === 'inactivo' ? 'inactivo' : 'activar';
    await manejarAccionBulk(accion, usuarios, req, res);
});

app.post('/api/usuarios/bulk-delete', async (req, res) => {
    const { usuarios } = req.body;
    await manejarAccionBulk('eliminar', usuarios, req, res);
});

// Vaciar toda la base de datos de usuarios
app.delete('/api/usuarios', async (req, res) => {
    const db = leerDBLocal();
    db.usuarios = [];
    guardarDBLocal(db);
    await registrarEventoAuditoria('BASE_DATOS_VACIADA', 'Administrador', 'Se vaciaron todos los usuarios de la base de datos local JSON', req);
    return res.json({ ok: true, mensaje: 'Base de datos de usuarios vaciada con éxito' });
});

// Eliminar un usuario individual
app.delete('/api/usuarios/:usuario', async (req, res) => {
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
app.get('/api/auditoria', async (req, res) => {
    const db = leerDBLocal();
    return res.json(db.auditoria || []);
});

// Vaciar bitácora de auditoría (corregido para responder siempre)
app.delete('/api/auditoria', async (req, res) => {
    const db = leerDBLocal();
    db.auditoria = [];
    guardarDBLocal(db);
    return res.json({ ok: true, mensaje: 'Bitácora de auditoría vaciada con éxito' });
});

// --- HISTORIAL DE DESCARGAS ---
app.post('/api/descargas', async (req, res) => {
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

app.get('/api/descargas', async (req, res) => {
    const db = leerDBLocal();
    return res.json(db.descargas || []);
});

app.delete('/api/descargas/:id', async (req, res) => {
    const { id } = req.params;
    const db = leerDBLocal();
    db.descargas = (db.descargas || []).filter(d => String(d.id) !== String(id));
    guardarDBLocal(db);
    return res.json({ ok: true, mensaje: 'Registro de descarga eliminado con éxito' });
});

app.delete('/api/descargas', async (req, res) => {
    const db = leerDBLocal();
    db.descargas = [];
    guardarDBLocal(db);
    return res.json({ ok: true, mensaje: 'Historial de descargas vaciado con éxito' });
});

// --- API EXPORTACIÓN DE DATOS (EXCEL / CSV) ---
app.get('/api/exportar/excel', async (req, res) => {
    try {
        const formato = (req.query.formato || 'xlsx').toLowerCase();
        const db = leerDBLocal();
        const usuarios = (db.usuarios || []).map(normalizarUsuario);
        const auditoria = db.auditoria || [];

        const datosUsuarios = usuarios.map(u => ({
            "Usuario": u.usuario || '',
            "Rol": u.rol || 'Cliente',
            "Estado": u.estado || 'Activo',
            "Contraseña": u.clave || '',
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
            { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 16 },
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

// --- INICIO DEL SERVIDOR LOCAL ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
======================================================================
  🏢  ${SYSTEM_NAME.toUpperCase()}
  ⚡  Servidor Local Optimizado (Rápido y Sin Dependencia de Render)
======================================================================
  🌐 Acceso con Nombre:    http://${HOST_NAME}:${PORT}
  💻 Acceso Localhost:     http://localhost:${PORT}
  🛡️  Panel Administrador:  http://${HOST_NAME}:${PORT}/admin
  📧 Servicio de Correo:   Resend API
  💾 Almacenamiento:       Local (database.json)
======================================================================
  💡 TIP: Puedes abrir http://${HOST_NAME}:${PORT} en tu navegador
     ejecutando 'activar-nombre-sistema.bat' una sola vez como admin.
======================================================================
`);
});