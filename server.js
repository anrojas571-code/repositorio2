require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { Resend } = require('resend');
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;
const PRIMARY_DB_FILE = path.join(__dirname, 'database.json');
const LEGACY_DB_FILE = path.join(__dirname, 'db.json');
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_cambiar';
const BCRYPT_SALT_ROUNDS = 10;

// --- MIDDLEWARES GLOBALES ---
app.use(cors({
    origin: true, // Permitir todos los orígenes en desarrollo, en producción especificar
    credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ruta dinámica para la carpeta Public
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'Public'))
    ? path.join(__dirname, 'Public')
    : path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// --- RATE LIMITING ---
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // límite de 100 peticiones por IP
    message: { error: 'Demasiadas peticiones desde esta IP, por favor espera 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', limiter); // Aplica a todas las rutas /api/

// Limitadores más estrictos para login y recuperación
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Demasiados intentos de login, espera 15 minutos.' },
});
const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Demasiadas solicitudes de recuperación, espera 15 minutos.' },
});

// --- CREDENCIALES ADMINISTRADOR POR DEFECTO (HASH) ---
const ADMIN_DEFAULT = [
    { usuario: 'Admin', clave: 'An12345*' },
    { usuario: 'Angel', clave: 'Samuel20' }
];
// Hashear las claves al inicio (se hará en la carga de la base de datos)

// --- FUNCIONES DE UTILIDAD ---

// Enmascarar correo
function enmascararCorreo(correo) {
    if (!correo || typeof correo !== 'string' || !correo.includes('@')) return '***@correo.com';
    const [nombre, dominio] = correo.trim().split('@');
    if (!nombre || nombre.length === 0) return `***@${dominio}`;
    if (nombre.length === 1) return `${nombre}***@${dominio}`;
    if (nombre.length === 2) return `${nombre[0]}***@${dominio}`;
    return `${nombre[0]}***${nombre[nombre.length - 1]}@${dominio}`;
}

// Función para enviar correos (usando Resend o SMTP)
async function enviarCorreo(destino, asunto, texto, html) {
    // Intentar primero con Resend
    const apiKey = (process.env.RESEND_API_KEY || '').trim();
    if (apiKey) {
        try {
            const resend = new Resend(apiKey);
            const remitente = process.env.EMAIL_FROM || 'Sistema <soporte@misistema.space>';
            const result = await resend.emails.send({
                from: remitente,
                to: destino,
                subject: asunto,
                text: texto,
                html: html,
            });
            if (result.error) throw new Error(result.error.message);
            return { enviado: true, service: 'Resend', id: result.data.id };
        } catch (err) {
            console.warn('Resend falló, intentando SMTP...', err.message);
        }
    }

    // Fallback a SMTP (si está configurado)
    const smtpHost = process.env.EMAIL_HOST || '';
    const smtpUser = process.env.EMAIL_USER || '';
    const smtpPass = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');
    if (smtpHost && smtpUser && smtpPass) {
        try {
            const transporter = nodemailer.createTransport({
                host: smtpHost,
                port: parseInt(process.env.EMAIL_PORT || '587'),
                secure: process.env.EMAIL_PORT === '465',
                auth: { user: smtpUser, pass: smtpPass },
            });
            const info = await transporter.sendMail({
                from: process.env.EMAIL_FROM || `"Sistema" <${smtpUser}>`,
                to: destino,
                subject: asunto,
                text: texto,
                html: html,
            });
            return { enviado: true, service: 'SMTP', id: info.messageId };
        } catch (err) {
            console.error('SMTP falló:', err.message);
        }
    }

    // Si todo falla, solo loguear
    console.warn('No se pudo enviar correo a', destino, 'para asunto:', asunto);
    return { enviado: false, error: 'No hay servicio de correo configurado' };
}

// --- FUNCIONES DE PERSISTENCIA LOCAL (JSON) ---
function leerDBLocal() {
    let targetFile = PRIMARY_DB_FILE;
    if (!fs.existsSync(PRIMARY_DB_FILE) && fs.existsSync(LEGACY_DB_FILE)) {
        targetFile = LEGACY_DB_FILE;
    }

    if (!fs.existsSync(targetFile)) {
        const initialData = {
            usuarios: [],
            administradores: ADMIN_DEFAULT.map(a => ({
                ...a,
                clave: bcrypt.hashSync(a.clave, BCRYPT_SALT_ROUNDS)
            })),
            descargas: [],
            soporte: [],
            auditoria: [{
                id: Date.now().toString(),
                fecha: new Date().toLocaleDateString('es-ES'),
                hora: new Date().toLocaleTimeString('es-ES'),
                tipo: 'INICIALIZACION',
                usuario: 'Sistema',
                detalle: 'Inicialización automática con bcrypt',
                ip: '127.0.0.1'
            }]
        };
        fs.writeFileSync(PRIMARY_DB_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }

    try {
        const raw = fs.readFileSync(targetFile, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
            return { usuarios: data, administradores: ADMIN_DEFAULT.map(a => ({ ...a, clave: bcrypt.hashSync(a.clave, BCRYPT_SALT_ROUNDS) })), descargas: [], soporte: [], auditoria: [] };
        }
        if (!data.administradores) {
            data.administradores = ADMIN_DEFAULT.map(a => ({ ...a, clave: bcrypt.hashSync(a.clave, BCRYPT_SALT_ROUNDS) }));
        } else {
            // Asegurar que las claves de admin estén hasheadas (migración)
            data.administradores = data.administradores.map(a => {
                if (a.clave && !a.clave.startsWith('$2b$')) {
                    return { ...a, clave: bcrypt.hashSync(a.clave, BCRYPT_SALT_ROUNDS) };
                }
                return a;
            });
        }
        if (!data.descargas) data.descargas = [];
        if (!data.usuarios) data.usuarios = [];
        if (!data.soporte) data.soporte = [];
        if (!data.auditoria) data.auditoria = [];
        return data;
    } catch (e) {
        console.error('Error leyendo database.json:', e);
        return { usuarios: [], administradores: ADMIN_DEFAULT.map(a => ({ ...a, clave: bcrypt.hashSync(a.clave, BCRYPT_SALT_ROUNDS) })), descargas: [], soporte: [], auditoria: [] };
    }
}

function guardarDBLocal(data) {
    const jsonStr = JSON.stringify(data, null, 2);
    try {
        fs.writeFileSync(PRIMARY_DB_FILE, jsonStr);
        fs.writeFileSync(LEGACY_DB_FILE, jsonStr); // sincronizar
    } catch (err) {
        console.error('Error escribiendo en database.json:', err);
    }
}

// --- BASE DE DATOS POSTGRESQL (OPCIONAL) ---
let pool = null;
if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    console.log('Conectado a PostgreSQL mediante DATABASE_URL');

    // Inicializar tablas
    (async () => {
        try {
            await pool.query(`
        CREATE TABLE IF NOT EXISTS usuarios (
          usuario VARCHAR(255) PRIMARY KEY,
          clave TEXT NOT NULL,
          correo TEXT,
          telefono TEXT,
          direccion TEXT,
          fecha_registro TEXT,
          contador_modificaciones INT DEFAULT 0,
          codigo_recuperacion TEXT,
          codigo_expiracion BIGINT,
          rol VARCHAR(50) DEFAULT 'Cliente',
          estado VARCHAR(50) DEFAULT 'Activo',
          historial_ediciones TEXT DEFAULT '[]'
        );
      `);
            await pool.query(`
        ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS correo TEXT;
        ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefono TEXT;
        ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS direccion TEXT;
        ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS fecha_registro TEXT;
        ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS contador_modificaciones INT DEFAULT 0;
        ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS codigo_recuperacion TEXT;
        ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS codigo_expiracion BIGINT;
        ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS rol VARCHAR(50) DEFAULT 'Cliente';
        ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS estado VARCHAR(50) DEFAULT 'Activo';
        ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS historial_ediciones TEXT DEFAULT '[]';
      `);
            await pool.query(`
        CREATE TABLE IF NOT EXISTS administradores (
          usuario VARCHAR(255) PRIMARY KEY,
          clave TEXT NOT NULL,
          rol VARCHAR(50) DEFAULT 'admin'
        );
      `);
            await pool.query(`
        CREATE TABLE IF NOT EXISTS descargas (
          id SERIAL PRIMARY KEY,
          formato VARCHAR(20) NOT NULL,
          fecha TEXT NOT NULL,
          hora TEXT NOT NULL
        );
      `);
            await pool.query(`
        CREATE TABLE IF NOT EXISTS soporte (
          id TEXT PRIMARY KEY,
          usuario TEXT NOT NULL,
          emisor VARCHAR(20) DEFAULT 'usuario',
          motivo TEXT NOT NULL,
          mensaje TEXT NOT NULL,
          fecha TEXT NOT NULL
        );
      `);
            await pool.query(`
        CREATE TABLE IF NOT EXISTS auditoria (
          id TEXT PRIMARY KEY,
          fecha TEXT NOT NULL,
          hora TEXT NOT NULL,
          tipo TEXT NOT NULL,
          usuario TEXT,
          detalle TEXT NOT NULL,
          ip TEXT
        );
      `);
            // Insertar admins si no existen
            for (const admin of ADMIN_DEFAULT) {
                const hash = bcrypt.hashSync(admin.clave, BCRYPT_SALT_ROUNDS);
                await pool.query(
                    `INSERT INTO administradores (usuario, clave) VALUES ($1, $2) ON CONFLICT (usuario) DO NOTHING`,
                    [admin.usuario, hash]
                );
            }
            console.log('Tablas PostgreSQL listas');
        } catch (err) {
            console.error('Error inicializando PostgreSQL:', err);
        }
    })();
}

// --- FUNCIONES DE AUDITORÍA (unificadas) ---
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

    if (pool) {
        try {
            await pool.query(
                `INSERT INTO auditoria (id, fecha, hora, tipo, usuario, detalle, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [evento.id, evento.fecha, evento.hora, evento.tipo, evento.usuario, evento.detalle, evento.ip]
            );
        } catch (err) {
            console.error('Error al registrar auditoría en PostgreSQL:', err.message);
        }
    } else {
        try {
            const db = leerDBLocal();
            if (!Array.isArray(db.auditoria)) db.auditoria = [];
            db.auditoria.unshift(evento);
            if (db.auditoria.length > 1000) db.auditoria = db.auditoria.slice(0, 1000);
            guardarDBLocal(db);
        } catch (err) {
            console.error('Error al registrar auditoría local:', err.message);
        }
    }
    return evento;
}

// --- MIDDLEWARE DE AUTENTICACIÓN JWT ---
function autenticarToken(req, res, next) {
    // Obtener token de cookie o header
    let token = req.cookies?.token;
    if (!token) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.slice(7);
        }
    }
    if (!token) {
        return res.status(401).json({ error: 'Acceso no autorizado. Token faltante.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.usuario = decoded; // { usuario, rol }
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Token inválido o expirado.' });
    }
}

// Middleware para verificar rol de administrador
function verificarAdmin(req, res, next) {
    if (req.usuario && req.usuario.rol === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Se requieren privilegios de administrador.' });
    }
}

// --- RUTAS PÚBLICAS (no requieren autenticación) ---

// Servir index.html y admin.html
app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.get(['/admin', '/admin.html'], (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// Verificar si el token es válido (para frontend)
app.get('/api/verify', autenticarToken, (req, res) => {
    // Buscar datos del usuario en la base
    const usuario = req.usuario;
    res.json({ ok: true, usuario: usuario.usuario, rol: usuario.rol });
});

// --- RUTAS DE AUTENTICACIÓN (sin autenticación) ---

// Login de administrador (no usa JWT, solo para admin.html)
app.post('/api/admin/login', async (req, res) => {
    const { usuario, clave } = req.body;
    if (!usuario || !clave) return res.status(400).json({ error: 'Usuario y clave requeridos' });

    let adminEncontrado = null;
    if (pool) {
        try {
            const result = await pool.query('SELECT usuario, clave FROM administradores WHERE LOWER(usuario) = LOWER($1)', [usuario]);
            if (result.rows.length > 0) adminEncontrado = result.rows[0];
        } catch (err) {
            return res.status(500).json({ error: 'Error en base de datos' });
        }
    } else {
        const db = leerDBLocal();
        adminEncontrado = db.administradores?.find(a => a.usuario.toLowerCase() === usuario.toLowerCase());
    }

    if (!adminEncontrado) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const match = await bcrypt.compare(clave, adminEncontrado.clave);
    if (!match) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Generar token JWT para admin (con rol admin)
    const token = jwt.sign(
        { usuario: adminEncontrado.usuario, rol: 'admin' },
        JWT_SECRET,
        { expiresIn: '8h' }
    );

    // Enviar token en cookie HttpOnly (más seguro)
    res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 8 * 60 * 60 * 1000 // 8 horas
    });

    res.json({ ok: true, mensaje: 'Autenticación exitosa', usuario: adminEncontrado.usuario });
});

// Login de usuario normal (devuelve token en cookie)
app.post('/api/usuarios/login',
    loginLimiter,
    [
        body('usuario').trim().notEmpty().withMessage('Usuario requerido'),
        body('clave').trim().notEmpty().withMessage('Clave requerida'),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array().map(e => e.msg).join(', ') });
        }

        const { usuario, clave } = req.body;
        let usuarioEncontrado = null;

        if (pool) {
            try {
                const result = await pool.query(
                    `SELECT usuario, clave, correo, telefono, direccion, fecha_registro AS "fechaRegistro",
                  contador_modificaciones AS "contadorModificaciones", rol, estado, historial_ediciones AS "historialEdiciones"
           FROM usuarios WHERE LOWER(usuario) = LOWER($1) OR LOWER(correo) = LOWER($1)`,
                    [usuario]
                );
                if (result.rows.length > 0) usuarioEncontrado = result.rows[0];
            } catch (err) {
                return res.status(500).json({ error: 'Error en base de datos' });
            }
        } else {
            const db = leerDBLocal();
            usuarioEncontrado = db.usuarios.find(u =>
                u.usuario.toLowerCase() === usuario.toLowerCase() ||
                (u.correo && u.correo.toLowerCase() === usuario.toLowerCase())
            );
        }

        if (!usuarioEncontrado) {
            await registrarEventoAuditoria('LOGIN_FALLIDO', usuario, 'Credenciales incorrectas', req);
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        // Verificar estado
        if (usuarioEncontrado.estado === 'Bloqueado') {
            await registrarEventoAuditoria('LOGIN_BLOQUEADO', usuarioEncontrado.usuario, 'Cuenta bloqueada', req);
            return res.status(403).json({ error: 'Tu cuenta ha sido bloqueada por el administrador.' });
        }
        if (usuarioEncontrado.estado === 'Inactivo') {
            await registrarEventoAuditoria('LOGIN_INACTIVO', usuarioEncontrado.usuario, 'Cuenta inactiva', req);
            return res.status(403).json({ error: 'Tu cuenta está inactiva. Contacta al administrador.' });
        }

        // Verificar contraseña con bcrypt
        const match = await bcrypt.compare(clave, usuarioEncontrado.clave);
        if (!match) {
            await registrarEventoAuditoria('LOGIN_FALLIDO', usuarioEncontrado.usuario, 'Contraseña incorrecta', req);
            return res.status(401).json({ error: 'Credenciales incorrectas' });
        }

        // Generar token JWT
        const token = jwt.sign(
            { usuario: usuarioEncontrado.usuario, rol: usuarioEncontrado.rol || 'cliente' },
            JWT_SECRET,
            { expiresIn: '4h' }
        );

        // Cookie HttpOnly
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 4 * 60 * 60 * 1000
        });

        // Devolver datos del usuario (sin clave)
        const userData = {
            usuario: usuarioEncontrado.usuario,
            correo: usuarioEncontrado.correo,
            telefono: usuarioEncontrado.telefono,
            direccion: usuarioEncontrado.direccion,
            fechaRegistro: usuarioEncontrado.fechaRegistro,
            contadorModificaciones: usuarioEncontrado.contadorModificaciones,
            rol: usuarioEncontrado.rol || 'Cliente',
            estado: usuarioEncontrado.estado || 'Activo',
            historialEdiciones: usuarioEncontrado.historialEdiciones || []
        };

        await registrarEventoAuditoria('LOGIN_EXITOSO', userData.usuario, 'Inicio de sesión exitoso', req);
        res.json({ ok: true, usuario: userData });
    }
);

// Registro de usuario
app.post('/api/usuarios/registrar',
    [
        body('usuario').trim().notEmpty().withMessage('Usuario requerido').isLength({ min: 3 }).withMessage('Mínimo 3 caracteres'),
        body('clave').trim().notEmpty().withMessage('Clave requerida').isLength({ min: 6 }).withMessage('Mínimo 6 caracteres'),
        body('correo').trim().notEmpty().withMessage('Correo requerido').isEmail().withMessage('Correo inválido'),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array().map(e => e.msg).join(', ') });
        }

        const { usuario, clave, correo, telefono, direccion } = req.body;

        // Verificar si usuario o correo ya existen
        let existe = false;
        if (pool) {
            try {
                const result = await pool.query('SELECT usuario FROM usuarios WHERE LOWER(usuario) = LOWER($1) OR LOWER(correo) = LOWER($2)', [usuario, correo]);
                if (result.rows.length > 0) existe = true;
            } catch (err) {
                return res.status(500).json({ error: 'Error en base de datos' });
            }
        } else {
            const db = leerDBLocal();
            existe = db.usuarios.some(u => u.usuario.toLowerCase() === usuario.toLowerCase() || (u.correo && u.correo.toLowerCase() === correo.toLowerCase()));
        }

        if (existe) {
            return res.status(400).json({ error: 'El usuario o correo ya están registrados.' });
        }

        // Hashear clave
        const hashedClave = await bcrypt.hash(clave, BCRYPT_SALT_ROUNDS);

        const fechaRegistro = new Date().toLocaleDateString('es-ES');

        let nuevoUsuario = {
            usuario,
            clave: hashedClave,
            correo: correo || '',
            telefono: telefono || '',
            direccion: direccion || '',
            fechaRegistro,
            contadorModificaciones: 0,
            rol: 'Cliente',
            estado: 'Activo',
            historialEdiciones: [],
            codigoRecuperacion: null,
            codigoExpiracion: null
        };

        if (pool) {
            try {
                await pool.query(
                    `INSERT INTO usuarios (usuario, clave, correo, telefono, direccion, fecha_registro, contador_modificaciones, rol, estado, historial_ediciones)
           VALUES ($1, $2, $3, $4, $5, $6, 0, 'Cliente', 'Activo', '[]')`,
                    [usuario, hashedClave, correo || '', telefono || '', direccion || '', fechaRegistro]
                );
                await registrarEventoAuditoria('REGISTRO_USUARIO', usuario, `Nuevo usuario registrado con correo ${correo}`, req);
                res.json({ mensaje: 'Usuario registrado con éxito', usuario: { usuario, correo, telefono, direccion, fechaRegistro, rol: 'Cliente', estado: 'Activo' } });
            } catch (err) {
                console.error('Error en registro PostgreSQL:', err);
                res.status(500).json({ error: 'Error al registrar en base de datos' });
            }
        } else {
            const db = leerDBLocal();
            db.usuarios.push(nuevoUsuario);
            guardarDBLocal(db);
            await registrarEventoAuditoria('REGISTRO_USUARIO', usuario, `Nuevo usuario registrado con correo ${correo}`, req);
            res.json({ mensaje: 'Usuario registrado con éxito', usuario: { usuario, correo, telefono, direccion, fechaRegistro, rol: 'Cliente', estado: 'Activo' } });
        }
    }
);

// --- RUTAS PROTEGIDAS (requieren autenticación) ---

// Cerrar sesión (eliminar cookie)
app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ ok: true, mensaje: 'Sesión cerrada' });
});

// Obtener perfil del usuario autenticado
app.get('/api/usuarios/perfil', autenticarToken, async (req, res) => {
    const usuario = req.usuario.usuario;
    let userData = null;
    if (pool) {
        try {
            const result = await pool.query(
                `SELECT usuario, correo, telefono, direccion, fecha_registro AS "fechaRegistro",
                contador_modificaciones AS "contadorModificaciones", rol, estado, historial_ediciones AS "historialEdiciones"
         FROM usuarios WHERE LOWER(usuario) = LOWER($1)`,
                [usuario]
            );
            if (result.rows.length > 0) userData = result.rows[0];
        } catch (err) {
            return res.status(500).json({ error: 'Error en base de datos' });
        }
    } else {
        const db = leerDBLocal();
        userData = db.usuarios.find(u => u.usuario.toLowerCase() === usuario.toLowerCase());
    }

    if (!userData) return res.status(404).json({ error: 'Usuario no encontrado' });

    // No devolver la clave
    delete userData.clave;
    res.json(userData);
});

// Editar perfil (usuario autenticado)
app.put('/api/usuarios/perfil',
    autenticarToken,
    [
        body('correo').optional().trim().isEmail().withMessage('Correo inválido'),
        body('telefono').optional().trim(),
        body('direccion').optional().trim(),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array().map(e => e.msg).join(', ') });
        }

        const usuario = req.usuario.usuario;
        const { correo, telefono, direccion } = req.body;

        if (pool) {
            try {
                // Obtener datos actuales
                const current = await pool.query('SELECT * FROM usuarios WHERE LOWER(usuario) = LOWER($1)', [usuario]);
                if (current.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
                const actual = current.rows[0];

                const cambios = [];
                if (correo !== undefined && correo.trim() !== actual.correo) {
                    cambios.push({ campo: 'Correo Electrónico', valorAnterior: actual.correo || 'Vacío', valorNuevo: correo.trim() });
                }
                if (telefono !== undefined && telefono.trim() !== actual.telefono) {
                    cambios.push({ campo: 'Teléfono', valorAnterior: actual.telefono || 'Vacío', valorNuevo: telefono.trim() });
                }
                if (direccion !== undefined && direccion.trim() !== actual.direccion) {
                    cambios.push({ campo: 'Dirección', valorAnterior: actual.direccion || 'Vacío', valorNuevo: direccion.trim() });
                }

                if (cambios.length === 0) {
                    return res.json({ mensaje: 'No se realizaron cambios', usuario: actual });
                }

                // Actualizar
                const nuevoCorreo = correo !== undefined ? correo.trim() : actual.correo;
                const nuevoTelefono = telefono !== undefined ? telefono.trim() : actual.telefono;
                const nuevaDireccion = direccion !== undefined ? direccion.trim() : actual.direccion;

                // Historial
                let historial = [];
                try {
                    historial = JSON.parse(actual.historial_ediciones || '[]');
                } catch (e) { historial = []; }
                historial.unshift({
                    tipo: 'perfil',
                    carpeta: '📁 Actualización de Perfil',
                    editor: 'Usuario',
                    fecha: new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }),
                    resumen: `${cambios.length} campo(s) modificado(s)`,
                    cambios
                });
                const nuevoContador = (parseInt(actual.contador_modificaciones || 0)) + 1;

                await pool.query(
                    `UPDATE usuarios SET correo = $1, telefono = $2, direccion = $3, contador_modificaciones = $4, historial_ediciones = $5
           WHERE LOWER(usuario) = LOWER($6)`,
                    [nuevoCorreo, nuevoTelefono, nuevaDireccion, nuevoContador, JSON.stringify(historial), usuario]
                );

                await registrarEventoAuditoria('PERFIL_ACTUALIZADO', usuario, `Campos: ${cambios.map(c => c.campo).join(', ')}`, req);
                res.json({ mensaje: 'Perfil actualizado' });
            } catch (err) {
                console.error('Error al actualizar perfil:', err);
                res.status(500).json({ error: 'Error al actualizar perfil' });
            }
        } else {
            // Modo local
            const db = leerDBLocal();
            const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === usuario.toLowerCase());
            if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });
            const actual = db.usuarios[idx];
            const cambios = [];
            if (correo !== undefined && correo.trim() !== actual.correo) {
                cambios.push({ campo: 'Correo Electrónico', valorAnterior: actual.correo || 'Vacío', valorNuevo: correo.trim() });
            }
            if (telefono !== undefined && telefono.trim() !== actual.telefono) {
                cambios.push({ campo: 'Teléfono', valorAnterior: actual.telefono || 'Vacío', valorNuevo: telefono.trim() });
            }
            if (direccion !== undefined && direccion.trim() !== actual.direccion) {
                cambios.push({ campo: 'Dirección', valorAnterior: actual.direccion || 'Vacío', valorNuevo: direccion.trim() });
            }
            if (cambios.length === 0) {
                return res.json({ mensaje: 'No se realizaron cambios', usuario: actual });
            }
            const nuevoCorreo = correo !== undefined ? correo.trim() : actual.correo;
            const nuevoTelefono = telefono !== undefined ? telefono.trim() : actual.telefono;
            const nuevaDireccion = direccion !== undefined ? direccion.trim() : actual.direccion;
            let historial = actual.historialEdiciones || [];
            historial.unshift({
                tipo: 'perfil',
                carpeta: '📁 Actualización de Perfil',
                editor: 'Usuario',
                fecha: new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }),
                resumen: `${cambios.length} campo(s) modificado(s)`,
                cambios
            });
            db.usuarios[idx].correo = nuevoCorreo;
            db.usuarios[idx].telefono = nuevoTelefono;
            db.usuarios[idx].direccion = nuevaDireccion;
            db.usuarios[idx].contadorModificaciones = (parseInt(db.usuarios[idx].contadorModificaciones || 0)) + 1;
            db.usuarios[idx].historialEdiciones = historial;
            guardarDBLocal(db);
            await registrarEventoAuditoria('PERFIL_ACTUALIZADO', usuario, `Campos: ${cambios.map(c => c.campo).join(', ')}`, req);
            res.json({ mensaje: 'Perfil actualizado' });
        }
    }
);

// Cambiar contraseña (usuario autenticado)
app.put('/api/usuarios/cambiar-clave',
    autenticarToken,
    [
        body('claveActual').trim().notEmpty().withMessage('Clave actual requerida'),
        body('claveNueva').trim().notEmpty().withMessage('Nueva clave requerida').isLength({ min: 6 }).withMessage('Mínimo 6 caracteres'),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array().map(e => e.msg).join(', ') });
        }

        const usuario = req.usuario.usuario;
        const { claveActual, claveNueva } = req.body;

        let user = null;
        if (pool) {
            try {
                const result = await pool.query('SELECT usuario, clave, contador_modificaciones, historial_ediciones FROM usuarios WHERE LOWER(usuario) = LOWER($1)', [usuario]);
                if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
                user = result.rows[0];
            } catch (err) {
                return res.status(500).json({ error: 'Error en base de datos' });
            }
        } else {
            const db = leerDBLocal();
            user = db.usuarios.find(u => u.usuario.toLowerCase() === usuario.toLowerCase());
            if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        // Verificar clave actual
        const match = await bcrypt.compare(claveActual, user.clave);
        if (!match) {
            return res.status(400).json({ error: 'La contraseña actual no es correcta' });
        }

        const hashedNueva = await bcrypt.hash(claveNueva, BCRYPT_SALT_ROUNDS);

        // Registrar en historial
        let historial = [];
        try {
            historial = JSON.parse(user.historial_ediciones || '[]');
        } catch (e) { historial = []; }
        historial.unshift({
            tipo: 'clave',
            carpeta: '📁 Cambio de Contraseña',
            editor: 'Usuario',
            fecha: new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }),
            resumen: 'Contraseña actualizada voluntariamente',
            cambios: [{ campo: 'Contraseña', valorAnterior: '••••••••', valorNuevo: '•••••••• (Modificada)' }]
        });
        const nuevoContador = (parseInt(user.contador_modificaciones || 0)) + 1;

        if (pool) {
            await pool.query(
                `UPDATE usuarios SET clave = $1, contador_modificaciones = $2, historial_ediciones = $3 WHERE LOWER(usuario) = LOWER($4)`,
                [hashedNueva, nuevoContador, JSON.stringify(historial), usuario]
            );
        } else {
            const db = leerDBLocal();
            const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === usuario.toLowerCase());
            if (idx !== -1) {
                db.usuarios[idx].clave = hashedNueva;
                db.usuarios[idx].contadorModificaciones = nuevoContador;
                db.usuarios[idx].historialEdiciones = historial;
                guardarDBLocal(db);
            }
        }

        await registrarEventoAuditoria('CLAVE_CAMBIADA', usuario, 'Contraseña actualizada', req);
        res.json({ mensaje: 'Contraseña cambiada con éxito' });
    }
);

// --- RUTAS DE RECUPERACIÓN (OTP) ---

// Solicitar código OTP (Paso 1)
app.post('/api/usuarios/recuperar-solicitar',
    otpLimiter,
    [
        body('busqueda').trim().notEmpty().withMessage('Usuario o correo requerido'),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array().map(e => e.msg).join(', ') });
        }

        const busqueda = req.body.busqueda.trim();
        let user = null;

        if (pool) {
            try {
                const result = await pool.query('SELECT usuario, correo, estado FROM usuarios WHERE LOWER(usuario) = LOWER($1) OR LOWER(correo) = LOWER($1)', [busqueda]);
                if (result.rows.length > 0) user = result.rows[0];
            } catch (err) {
                return res.status(500).json({ error: 'Error en base de datos' });
            }
        } else {
            const db = leerDBLocal();
            user = db.usuarios.find(u => u.usuario.toLowerCase() === busqueda.toLowerCase() || (u.correo && u.correo.toLowerCase() === busqueda.toLowerCase()));
        }

        if (!user) {
            return res.status(404).json({ error: 'No existe ninguna cuenta asociada a este usuario o correo' });
        }

        // Generar código OTP de 6 dígitos
        const codigo = Math.floor(100000 + Math.random() * 900000).toString();
        const expiracion = Date.now() + 15 * 60 * 1000; // 15 minutos

        // Guardar en base de datos
        if (pool) {
            await pool.query(
                `UPDATE usuarios SET codigo_recuperacion = $1, codigo_expiracion = $2 WHERE LOWER(usuario) = LOWER($3)`,
                [codigo, expiracion, user.usuario]
            );
        } else {
            const db = leerDBLocal();
            const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === user.usuario.toLowerCase());
            if (idx !== -1) {
                db.usuarios[idx].codigoRecuperacion = codigo;
                db.usuarios[idx].codigoExpiracion = expiracion;
                guardarDBLocal(db);
            }
        }

        // Enviar correo
        const correoEnmascarado = enmascararCorreo(user.correo);
        const asunto = '🔒 Código de Recuperación de Contraseña (6 dígitos)';
        const texto = `Tu código de recuperación es: ${codigo}. Este código vence en 15 minutos.\nRevisa tu carpeta de Spam / Correo No Deseado.`;
        const html = `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff;">
        <h2 style="color: #4f46e5; text-align: center;">Recuperación de Contraseña</h2>
        <p>Has solicitado restablecer tu contraseña. Utiliza el siguiente código:</p>
        <div style="background: #f8fafc; border: 2px dashed #4f46e5; border-radius: 12px; padding: 18px; text-align: center; margin: 20px 0;">
          <span style="font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #0f172a;">${codigo}</span>
        </div>
        <p style="color: #ef4444; font-weight: 700; text-align: center;">⏰ Caduca en 15 minutos.</p>
        <p style="color: #94a3b8; text-align: center; font-size: 12px;">Si no solicitaste esto, ignora este mensaje.</p>
      </div>
    `;

        const emailResult = await enviarCorreo(user.correo, asunto, texto, html);

        await registrarEventoAuditoria('OTP_SOLICITADO', user.usuario, `Código OTP generado para ${correoEnmascarado}`, req);

        res.json({
            ok: true,
            usuario: user.usuario,
            correoEnmascarado,
            mensaje: `Código de 6 dígitos enviado a ${correoEnmascarado}. Válido por 15 minutos.`
        });
    }
);

// Verificar OTP y cambiar contraseña (Paso 2)
app.post('/api/usuarios/recuperar-verificar',
    [
        body('usuario').trim().notEmpty().withMessage('Usuario requerido'),
        body('otp').trim().notEmpty().withMessage('Código OTP requerido').isLength({ min: 6, max: 6 }).withMessage('Código de 6 dígitos'),
        body('nuevaClave').trim().notEmpty().withMessage('Nueva clave requerida').isLength({ min: 6 }).withMessage('Mínimo 6 caracteres'),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array().map(e => e.msg).join(', ') });
        }

        const { usuario, otp, nuevaClave } = req.body;
        let user = null;

        if (pool) {
            try {
                const result = await pool.query(
                    `SELECT usuario, correo, clave, codigo_recuperacion, codigo_expiracion, contador_modificaciones, historial_ediciones
           FROM usuarios WHERE LOWER(usuario) = LOWER($1)`,
                    [usuario]
                );
                if (result.rows.length > 0) user = result.rows[0];
            } catch (err) {
                return res.status(500).json({ error: 'Error en base de datos' });
            }
        } else {
            const db = leerDBLocal();
            user = db.usuarios.find(u => u.usuario.toLowerCase() === usuario.toLowerCase());
        }

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        // Verificar OTP
        if (!user.codigo_recuperacion || user.codigo_recuperacion !== otp) {
            await registrarEventoAuditoria('OTP_FALLIDO', usuario, 'Código OTP incorrecto', req);
            return res.status(400).json({ error: 'Código de verificación incorrecto' });
        }

        if (Date.now() > (parseInt(user.codigo_expiracion) || 0)) {
            await registrarEventoAuditoria('OTP_EXPIRADO', usuario, 'Código OTP expirado', req);
            return res.status(400).json({ error: 'El código ha expirado. Solicita uno nuevo.' });
        }

        // Hashear nueva clave
        const hashedNueva = await bcrypt.hash(nuevaClave, BCRYPT_SALT_ROUNDS);

        // Registrar en historial
        let historial = [];
        try {
            historial = JSON.parse(user.historial_ediciones || '[]');
        } catch (e) { historial = []; }
        historial.unshift({
            tipo: 'recuperacion',
            carpeta: '📁 Recuperación con OTP',
            editor: 'Sistema (OTP)',
            fecha: new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }),
            resumen: 'Contraseña restablecida mediante OTP',
            cambios: [{ campo: 'Contraseña', valorAnterior: '••••••••', valorNuevo: '•••••••• (Restablecida)' }]
        });
        const nuevoContador = (parseInt(user.contador_modificaciones || 0)) + 1;

        if (pool) {
            await pool.query(
                `UPDATE usuarios SET clave = $1, codigo_recuperacion = NULL, codigo_expiracion = NULL, contador_modificaciones = $2, historial_ediciones = $3
         WHERE LOWER(usuario) = LOWER($4)`,
                [hashedNueva, nuevoContador, JSON.stringify(historial), usuario]
            );
        } else {
            const db = leerDBLocal();
            const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === usuario.toLowerCase());
            if (idx !== -1) {
                db.usuarios[idx].clave = hashedNueva;
                db.usuarios[idx].codigoRecuperacion = null;
                db.usuarios[idx].codigoExpiracion = null;
                db.usuarios[idx].contadorModificaciones = nuevoContador;
                db.usuarios[idx].historialEdiciones = historial;
                guardarDBLocal(db);
            }
        }

        await registrarEventoAuditoria('CLAVE_RESTABLECIDA', usuario, 'Contraseña actualizada mediante OTP', req);
        res.json({ ok: true, mensaje: 'Contraseña actualizada con éxito. Ya puedes iniciar sesión.' });
    }
);

// --- RUTAS PROTEGIDAS PARA ADMINISTRADORES ---

// Obtener lista de usuarios (solo admin)
app.get('/api/usuarios', autenticarToken, verificarAdmin, async (req, res) => {
    if (pool) {
        try {
            const result = await pool.query(
                `SELECT usuario, correo, telefono, direccion, fecha_registro AS "fechaRegistro",
                contador_modificaciones AS "contadorModificaciones", rol, estado, historial_ediciones AS "historialEdiciones"
         FROM usuarios ORDER BY usuario ASC`
            );
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: 'Error al obtener usuarios' });
        }
    } else {
        const db = leerDBLocal();
        // Ocultar claves
        const usuarios = db.usuarios.map(u => {
            const { clave, ...rest } = u;
            return rest;
        });
        res.json(usuarios);
    }
});

// Editar usuario (admin)
app.put('/api/usuarios/admin-editar',
    autenticarToken,
    verificarAdmin,
    [
        body('usuario').trim().notEmpty().withMessage('Usuario requerido'),
        body('correo').optional().trim().isEmail().withMessage('Correo inválido'),
        body('clave').optional().trim().isLength({ min: 6 }).withMessage('Clave mínima 6 caracteres'),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array().map(e => e.msg).join(', ') });
        }

        const { usuario, correo, telefono, direccion, clave, rol, estado } = req.body;

        // Obtener usuario actual
        let userActual = null;
        if (pool) {
            try {
                const result = await pool.query('SELECT * FROM usuarios WHERE LOWER(usuario) = LOWER($1)', [usuario]);
                if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
                userActual = result.rows[0];
            } catch (err) {
                return res.status(500).json({ error: 'Error en base de datos' });
            }
        } else {
            const db = leerDBLocal();
            userActual = db.usuarios.find(u => u.usuario.toLowerCase() === usuario.toLowerCase());
            if (!userActual) return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        // Construir objeto de actualización
        const cambios = [];
        let nuevoCorreo = correo !== undefined ? correo.trim() : userActual.correo;
        let nuevoTelefono = telefono !== undefined ? telefono.trim() : userActual.telefono;
        let nuevaDireccion = direccion !== undefined ? direccion.trim() : userActual.direccion;
        let nuevoRol = rol || userActual.rol;
        let nuevoEstado = estado || userActual.estado;
        let nuevaClave = userActual.clave;

        if (clave && clave.trim() !== '') {
            nuevaClave = await bcrypt.hash(clave.trim(), BCRYPT_SALT_ROUNDS);
            cambios.push({ campo: 'Contraseña', valorAnterior: '••••••••', valorNuevo: '•••••••• (Modificada)' });
        }
        if (nuevoCorreo !== userActual.correo) {
            cambios.push({ campo: 'Correo Electrónico', valorAnterior: userActual.correo || 'Vacío', valorNuevo: nuevoCorreo || 'Vacío' });
        }
        if (nuevoTelefono !== userActual.telefono) {
            cambios.push({ campo: 'Teléfono', valorAnterior: userActual.telefono || 'Vacío', valorNuevo: nuevoTelefono || 'Vacío' });
        }
        if (nuevaDireccion !== userActual.direccion) {
            cambios.push({ campo: 'Dirección', valorAnterior: userActual.direccion || 'Vacío', valorNuevo: nuevaDireccion || 'Vacío' });
        }
        if (nuevoRol !== userActual.rol) {
            cambios.push({ campo: 'Rol', valorAnterior: userActual.rol || 'Cliente', valorNuevo: nuevoRol });
        }
        if (nuevoEstado !== userActual.estado) {
            cambios.push({ campo: 'Estado', valorAnterior: userActual.estado || 'Activo', valorNuevo: nuevoEstado });
        }

        if (cambios.length === 0) {
            return res.json({ mensaje: 'No se realizaron cambios' });
        }

        // Historial
        let historial = [];
        try {
            historial = JSON.parse(userActual.historial_ediciones || '[]');
        } catch (e) { historial = []; }
        historial.unshift({
            tipo: 'admin',
            carpeta: '📁 Modificación por Administrador',
            editor: 'Administrador',
            fecha: new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }),
            resumen: `${cambios.length} cambio(s) realizado(s) por Administrador`,
            cambios
        });
        const nuevoContador = (parseInt(userActual.contador_modificaciones || 0)) + 1;

        if (pool) {
            await pool.query(
                `UPDATE usuarios SET correo = $1, telefono = $2, direccion = $3, clave = $4, rol = $5, estado = $6,
         contador_modificaciones = $7, historial_ediciones = $8
         WHERE LOWER(usuario) = LOWER($9)`,
                [nuevoCorreo, nuevoTelefono, nuevaDireccion, nuevaClave, nuevoRol, nuevoEstado, nuevoContador, JSON.stringify(historial), usuario]
            );
        } else {
            const db = leerDBLocal();
            const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === usuario.toLowerCase());
            if (idx !== -1) {
                db.usuarios[idx].correo = nuevoCorreo;
                db.usuarios[idx].telefono = nuevoTelefono;
                db.usuarios[idx].direccion = nuevaDireccion;
                db.usuarios[idx].clave = nuevaClave;
                db.usuarios[idx].rol = nuevoRol;
                db.usuarios[idx].estado = nuevoEstado;
                db.usuarios[idx].contadorModificaciones = nuevoContador;
                db.usuarios[idx].historialEdiciones = historial;
                guardarDBLocal(db);
            }
        }

        await registrarEventoAuditoria('USUARIO_EDITADO', usuario, `Campos modificados: ${cambios.map(c => c.campo).join(', ')}`, req);
        res.json({ mensaje: 'Usuario actualizado con éxito' });
    }
);

// Acciones masivas (admin)
app.post('/api/usuarios/bulk',
    autenticarToken,
    verificarAdmin,
    [
        body('accion').isIn(['activar', 'bloquear', 'eliminar']).withMessage('Acción inválida'),
        body('usuariosSeleccionados').isArray({ min: 1 }).withMessage('Selecciona al menos un usuario'),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array().map(e => e.msg).join(', ') });
        }

        const { accion, usuariosSeleccionados } = req.body;

        if (pool) {
            try {
                if (accion === 'eliminar') {
                    await pool.query('DELETE FROM usuarios WHERE LOWER(usuario) = ANY($1::text[])', [usuariosSeleccionados.map(u => u.toLowerCase())]);
                } else {
                    const nuevoEstado = accion === 'activar' ? 'Activo' : 'Bloqueado';
                    await pool.query('UPDATE usuarios SET estado = $1 WHERE LOWER(usuario) = ANY($2::text[])', [nuevoEstado, usuariosSeleccionados.map(u => u.toLowerCase())]);
                }
            } catch (err) {
                return res.status(500).json({ error: 'Error al procesar acción masiva' });
            }
        } else {
            const db = leerDBLocal();
            const set = new Set(usuariosSeleccionados.map(u => u.toLowerCase()));
            if (accion === 'eliminar') {
                db.usuarios = db.usuarios.filter(u => !set.has(u.usuario.toLowerCase()));
            } else {
                const nuevoEstado = accion === 'activar' ? 'Activo' : 'Bloqueado';
                db.usuarios.forEach(u => {
                    if (set.has(u.usuario.toLowerCase())) u.estado = nuevoEstado;
                });
            }
            guardarDBLocal(db);
        }

        await registrarEventoAuditoria('ACCION_MASIVA', 'Administrador', `Acción '${accion}' sobre ${usuariosSeleccionados.length} usuarios`, req);
        res.json({ mensaje: `Acción '${accion}' completada con éxito`, afectados: usuariosSeleccionados.length });
    }
);

// Eliminar usuario individual (admin)
app.delete('/api/usuarios/:usuario',
    autenticarToken,
    verificarAdmin,
    async (req, res) => {
        const { usuario } = req.params;

        if (pool) {
            try {
                await pool.query('DELETE FROM usuarios WHERE LOWER(usuario) = LOWER($1)', [usuario]);
            } catch (err) {
                return res.status(500).json({ error: 'Error al eliminar usuario' });
            }
        } else {
            const db = leerDBLocal();
            db.usuarios = db.usuarios.filter(u => u.usuario.toLowerCase() !== usuario.toLowerCase());
            guardarDBLocal(db);
        }

        await registrarEventoAuditoria('ELIMINAR_USUARIO', 'Administrador', `Usuario ${usuario} eliminado`, req);
        res.json({ mensaje: 'Usuario eliminado' });
    }
);

// --- RUTAS DE SOPORTE (protegidas para admin y también usadas por clientes) ---

// Envío de mensaje (cliente o admin)
app.post('/api/soporte/enviar',
    [
        body('usuario').trim().notEmpty().withMessage('Usuario requerido'),
        body('mensaje').trim().notEmpty().withMessage('Mensaje requerido'),
        body('emisor').optional().isIn(['usuario', 'admin']).withMessage('Emisor inválido'),
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ error: errors.array().map(e => e.msg).join(', ') });
        }

        const { usuario, mensaje, emisor = 'usuario', motivo = 'Consulta General' } = req.body;

        const nuevoMensaje = {
            id: Date.now().toString(),
            usuario: usuario.trim(),
            emisor: emisor,
            motivo: motivo.trim(),
            mensaje: mensaje.trim(),
            fecha: new Date().toLocaleString('es-ES')
        };

        if (pool) {
            try {
                await pool.query(
                    `INSERT INTO soporte (id, usuario, emisor, motivo, mensaje, fecha) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [nuevoMensaje.id, nuevoMensaje.usuario, nuevoMensaje.emisor, nuevoMensaje.motivo, nuevoMensaje.mensaje, nuevoMensaje.fecha]
                );
                await registrarEventoAuditoria('SOPORTE_ENVIADO', usuario, `Mensaje de ${emisor}: ${mensaje.slice(0, 50)}...`, req);
                res.status(201).json({ mensaje: 'Mensaje enviado' });
            } catch (err) {
                res.status(500).json({ error: 'Error al guardar mensaje' });
            }
        } else {
            const db = leerDBLocal();
            if (!Array.isArray(db.soporte)) db.soporte = [];
            db.soporte.push(nuevoMensaje);
            guardarDBLocal(db);
            await registrarEventoAuditoria('SOPORTE_ENVIADO', usuario, `Mensaje de ${emisor}: ${mensaje.slice(0, 50)}...`, req);
            res.status(201).json({ mensaje: 'Mensaje enviado' });
        }
    }
);

// Obtener todos los mensajes (admin)
app.get('/api/soporte', autenticarToken, verificarAdmin, async (req, res) => {
    if (pool) {
        try {
            const result = await pool.query('SELECT * FROM soporte ORDER BY id ASC');
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: 'Error al obtener mensajes' });
        }
    } else {
        const db = leerDBLocal();
        res.json(db.soporte || []);
    }
});

// Obtener mensajes de un usuario (admin)
app.get('/api/soporte/usuario/:usuario', autenticarToken, verificarAdmin, async (req, res) => {
    const { usuario } = req.params;
    if (pool) {
        try {
            const result = await pool.query('SELECT * FROM soporte WHERE LOWER(usuario) = LOWER($1) ORDER BY id ASC', [usuario]);
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: 'Error al obtener mensajes' });
        }
    } else {
        const db = leerDBLocal();
        const mensajes = (db.soporte || []).filter(m => m.usuario.toLowerCase() === usuario.toLowerCase());
        res.json(mensajes);
    }
});

// Vaciar soporte (admin)
app.delete('/api/soporte/vaciar', autenticarToken, verificarAdmin, async (req, res) => {
    if (pool) {
        await pool.query('TRUNCATE TABLE soporte');
    } else {
        const db = leerDBLocal();
        db.soporte = [];
        guardarDBLocal(db);
    }
    await registrarEventoAuditoria('SOPORTE_VACIADO', 'Administrador', 'Historial de soporte vaciado', req);
    res.json({ mensaje: 'Historial de soporte vaciado' });
});

// --- RUTAS DE AUDITORÍA (admin) ---

// Obtener auditoría
app.get('/api/auditoria', autenticarToken, verificarAdmin, async (req, res) => {
    if (pool) {
        try {
            const result = await pool.query('SELECT * FROM auditoria ORDER BY id DESC LIMIT 500');
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: 'Error al obtener auditoría' });
        }
    } else {
        const db = leerDBLocal();
        res.json(db.auditoria || []);
    }
});

// Vaciar auditoría (admin)
app.delete('/api/auditoria', autenticarToken, verificarAdmin, async (req, res) => {
    if (pool) {
        await pool.query('TRUNCATE TABLE auditoria');
    } else {
        const db = leerDBLocal();
        db.auditoria = [];
        guardarDBLocal(db);
    }
    res.json({ mensaje: 'Auditoría vaciada' });
});

// --- RUTAS DE EXPORTACIÓN (admin) ---

// Exportar auditoría a Excel
app.get('/api/exportar/auditoria', autenticarToken, verificarAdmin, async (req, res) => {
    let datos = [];
    if (pool) {
        try {
            const result = await pool.query('SELECT * FROM auditoria ORDER BY id DESC');
            datos = result.rows;
        } catch (err) {
            return res.status(500).json({ error: 'Error al obtener auditoría' });
        }
    } else {
        const db = leerDBLocal();
        datos = db.auditoria || [];
    }

    if (datos.length === 0) {
        return res.status(404).json({ error: 'No hay registros de auditoría' });
    }

    // Crear hoja de Excel
    const ws = XLSX.utils.json_to_sheet(datos);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Auditoría');

    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });

    res.setHeader('Content-Disposition', 'attachment; filename=auditoria.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
});

// Exportar usuarios a Excel (admin)
app.get('/api/exportar/usuarios', autenticarToken, verificarAdmin, async (req, res) => {
    let usuarios = [];
    if (pool) {
        try {
            const result = await pool.query(
                `SELECT usuario, correo, telefono, direccion, fecha_registro AS "fechaRegistro",
                contador_modificaciones AS "contadorModificaciones", rol, estado
         FROM usuarios ORDER BY usuario ASC`
            );
            usuarios = result.rows;
        } catch (err) {
            return res.status(500).json({ error: 'Error al obtener usuarios' });
        }
    } else {
        const db = leerDBLocal();
        usuarios = db.usuarios.map(u => {
            const { clave, ...rest } = u;
            return rest;
        });
    }

    if (usuarios.length === 0) {
        return res.status(404).json({ error: 'No hay usuarios' });
    }

    const ws = XLSX.utils.json_to_sheet(usuarios);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Usuarios');

    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });

    res.setHeader('Content-Disposition', 'attachment; filename=usuarios.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
});

// --- RUTAS DE DESCARGA (no autenticadas, solo para admin) ---

app.post('/api/descargas', autenticarToken, verificarAdmin, async (req, res) => {
    const { formato } = req.body;
    const ahora = new Date();
    const fecha = ahora.toLocaleDateString('es-ES');
    const hora = ahora.toLocaleTimeString('es-ES');

    if (pool) {
        try {
            const result = await pool.query(
                `INSERT INTO descargas (formato, fecha, hora) VALUES ($1, $2, $3) RETURNING *`,
                [formato, fecha, hora]
            );
            res.json(result.rows[0]);
        } catch (err) {
            res.status(500).json({ error: 'Error al guardar descarga' });
        }
    } else {
        const db = leerDBLocal();
        const nueva = { id: Date.now(), formato, fecha, hora };
        db.descargas.push(nueva);
        guardarDBLocal(db);
        res.json(nueva);
    }
});

app.get('/api/descargas', autenticarToken, verificarAdmin, async (req, res) => {
    if (pool) {
        try {
            const result = await pool.query('SELECT * FROM descargas ORDER BY id DESC');
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: 'Error al obtener descargas' });
        }
    } else {
        const db = leerDBLocal();
        res.json(db.descargas || []);
    }
});

app.delete('/api/descargas/:id', autenticarToken, verificarAdmin, async (req, res) => {
    const { id } = req.params;
    if (pool) {
        await pool.query('DELETE FROM descargas WHERE id = $1', [id]);
    } else {
        const db = leerDBLocal();
        db.descargas = (db.descargas || []).filter(d => d.id.toString() !== id);
        guardarDBLocal(db);
    }
    res.json({ mensaje: 'Descarga eliminada' });
});

app.delete('/api/descargas', autenticarToken, verificarAdmin, async (req, res) => {
    if (pool) {
        await pool.query('TRUNCATE TABLE descargas');
    } else {
        const db = leerDBLocal();
        db.descargas = [];
        guardarDBLocal(db);
    }
    res.json({ mensaje: 'Historial de descargas vaciado' });
});

// --- RUTA POR DEFECTO ---
app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});