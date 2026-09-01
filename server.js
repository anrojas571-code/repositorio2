require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// --- MIDDLEWARES GLOBALES (DEBEN IR ANTES DE TODAS LAS RUTAS) ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ruta dinámica para la carpeta Public
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'Public'))
    ? path.join(__dirname, 'Public')
    : path.join(__dirname, 'public');

// Servir archivos estáticos
app.use(express.static(PUBLIC_DIR));

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
        console.warn(`[EMAIL ADVERTENCIA] No se envió el correo porque falta RESEND_API_KEY en variables de entorno.`);
        return { enviado: false, motivo: 'no_credentials', codigo };
    }

    const resend = new Resend(apiKey);
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
        fechaRegistro: u.fechaRegistro || u.fecha_registro || new Date().toLocaleDateString(),
        contadorModificaciones: parseInt(u.contadorModificaciones || u.contador_modificaciones || 0),
        rol: u.rol || 'Cliente',
        estado: u.estado || 'Activo',
        historialEdiciones: historial,
        codigoRecuperacion: u.codigoRecuperacion || u.codigo_recuperacion || null,
        codigoExpiracion: u.codigoExpiracion || u.codigo_expiracion || null
    };
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

    // Inicializar tablas y columnas en PostgreSQL
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
                    codigo_recuperacion TEXT,
                    codigo_expiracion BIGINT,
                    rol VARCHAR(50) DEFAULT 'Cliente',
                    estado VARCHAR(50) DEFAULT 'Activo',
                    historial_ediciones TEXT DEFAULT '[]'
                );
            `);

            // Asegurar columnas existentes
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

            // Tabla de soporte técnico
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

            // Asegurar columna emisor si la tabla ya existía
            await pool.query(`
                ALTER TABLE soporte ADD COLUMN IF NOT EXISTS emisor VARCHAR(20) DEFAULT 'usuario';
            `);
            // Insertar o actualizar el admin por defecto
            await pool.query(`
                INSERT INTO administradores (usuario, clave) 
                VALUES ($1, $2)
                ON CONFLICT (usuario) DO NOTHING;
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

// --- MÉTODOS LOCALES (FALLBACK A db.json) ---
function leerDBLocal() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ usuarios: [], administradores: [ADMIN_DEFAULT], descargas: [], soporte: [] }, null, 2));
    }
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
        if (Array.isArray(data)) {
            return { usuarios: data, administradores: [ADMIN_DEFAULT], descargas: [], soporte: [] };
        }
        if (!data.administradores) data.administradores = [ADMIN_DEFAULT];
        if (!data.descargas) data.descargas = [];
        if (!data.usuarios) data.usuarios = [];
        if (!data.soporte) data.soporte = [];
        return data;
    } catch (e) {
        return { usuarios: [], administradores: [ADMIN_DEFAULT], descargas: [], soporte: [] };
    }
}

function guardarDBLocal(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- RUTAS DE VISTAS PRINCIPALES ---
app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get(['/admin', '/admin.html'], (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// --- API SOPORTE TÉCNICO (Envío del usuario y chat) ---
app.post('/api/soporte', async (req, res) => {
    const usuario = req.body.usuario || req.body.usuario_origen || req.body.remitente;
    const motivo = req.body.motivo || 'Consulta General';
    const mensaje = req.body.mensaje;

    if (!usuario || !mensaje) {
        return res.status(400).json({ error: 'El usuario y el mensaje son requeridos' });
    }

    const nuevoMensaje = {
        id: Date.now().toString(),
        usuario: usuario.trim(),
        emisor: (req.body.emisor || 'usuario').toLowerCase(),
        motivo: motivo.trim(),
        mensaje: mensaje.trim(),
        fecha: new Date().toLocaleString('es-ES')
    };

    if (pool) {
        try {
            await pool.query(
                'INSERT INTO soporte (id, usuario, emisor, motivo, mensaje, fecha) VALUES ($1, $2, $3, $4, $5, $6)',
                [nuevoMensaje.id, nuevoMensaje.usuario, nuevoMensaje.emisor, nuevoMensaje.motivo, nuevoMensaje.mensaje, nuevoMensaje.fecha]
            );
            return res.status(201).json({ status: 'ok', mensaje: 'Mensaje recibido con éxito', data: nuevoMensaje });
        } catch (err) {
            console.error('Error al guardar mensaje de soporte en PostgreSQL:', err);
            return res.status(500).json({ error: 'Error al enviar mensaje de soporte' });
        }
    } else {
        const db = leerDBLocal();
        if (!Array.isArray(db.soporte)) db.soporte = [];
        db.soporte.push(nuevoMensaje);
        guardarDBLocal(db);
        return res.status(201).json({ status: 'ok', mensaje: 'Mensaje recibido con éxito', data: nuevoMensaje });
    }
});

// --- API SOPORTE TÉCNICO (Respuesta del Administrador) ---
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

    if (pool) {
        try {
            await pool.query(
                'INSERT INTO soporte (id, usuario, emisor, motivo, mensaje, fecha) VALUES ($1, $2, $3, $4, $5, $6)',
                [respuestaAdmin.id, respuestaAdmin.usuario, respuestaAdmin.emisor, respuestaAdmin.motivo, respuestaAdmin.mensaje, respuestaAdmin.fecha]
            );
            return res.status(201).json({ status: 'ok', mensaje: 'Respuesta enviada con éxito', data: respuestaAdmin });
        } catch (err) {
            console.error('Error al guardar respuesta de admin en PostgreSQL:', err);
            return res.status(500).json({ error: 'Error al enviar la respuesta de soporte' });
        }
    } else {
        const db = leerDBLocal();
        if (!Array.isArray(db.soporte)) db.soporte = [];
        db.soporte.push(respuestaAdmin);
        guardarDBLocal(db);
        return res.status(201).json({ status: 'ok', mensaje: 'Respuesta enviada con éxito', data: respuestaAdmin });
    }
});

// --- API SOPORTE TÉCNICO: Obtener todos los mensajes ---
app.get('/api/soporte', async (req, res) => {
    if (pool) {
        try {
            const result = await pool.query('SELECT * FROM soporte ORDER BY id ASC');
            return res.json(result.rows);
        } catch (err) {
            console.error('Error al obtener mensajes de soporte en PostgreSQL:', err);
            return res.status(500).json({ error: 'Error al obtener mensajes de soporte' });
        }
    } else {
        const db = leerDBLocal();
        const soporte = (db.soporte || []).slice().sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
        return res.json(soporte);
    }
});

// --- API SOPORTE TÉCNICO: Obtener mensajes de un usuario específico ---
app.get('/api/soporte/usuario/:usuario', async (req, res) => {
    const usuarioParam = (req.params.usuario || '').trim();
    if (!usuarioParam) {
        return res.status(400).json({ error: 'El parámetro usuario es requerido' });
    }

    if (pool) {
        try {
            const result = await pool.query(
                'SELECT * FROM soporte WHERE LOWER(usuario) = LOWER($1) ORDER BY id ASC',
                [usuarioParam]
            );
            return res.json(result.rows);
        } catch (err) {
            console.error(`Error al obtener mensajes de ${usuarioParam}:`, err);
            return res.status(500).json({ error: 'Error al obtener mensajes del usuario' });
        }
    } else {
        const db = leerDBLocal();
        const mensajes = (db.soporte || [])
            .filter(m => m.usuario && m.usuario.toLowerCase() === usuarioParam.toLowerCase())
            .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
        return res.json(mensajes);
    }
});

// --- API SOPORTE TÉCNICO: Eliminar conversación de un usuario ---
app.delete('/api/soporte/usuario/:usuario', async (req, res) => {
    const usuarioParam = (req.params.usuario || '').trim();
    if (!usuarioParam) {
        return res.status(400).json({ error: 'El parámetro usuario es requerido' });
    }

    if (pool) {
        try {
            await pool.query('DELETE FROM soporte WHERE LOWER(usuario) = LOWER($1)', [usuarioParam]);
            return res.json({ status: 'ok', mensaje: `Conversación de ${usuarioParam} eliminada` });
        } catch (err) {
            console.error(`Error al eliminar conversación de ${usuarioParam}:`, err);
            return res.status(500).json({ error: 'Error al eliminar la conversación del usuario' });
        }
    } else {
        const db = leerDBLocal();
        db.soporte = (db.soporte || []).filter(
            m => !m.usuario || m.usuario.toLowerCase() !== usuarioParam.toLowerCase()
        );
        guardarDBLocal(db);
        return res.json({ status: 'ok', mensaje: `Conversación de ${usuarioParam} eliminada` });
    }
});

// --- API SOPORTE TÉCNICO: Vaciar todos los mensajes ---
app.delete('/api/soporte', async (req, res) => {
    if (pool) {
        try {
            await pool.query('TRUNCATE TABLE soporte');
            return res.json({ status: 'ok', mensaje: 'Todos los chats han sido eliminados' });
        } catch (err) {
            console.error('Error al vaciar mensajes de soporte:', err);
            return res.status(500).json({ error: 'Error al vaciar los chats de soporte' });
        }
    } else {
        const db = leerDBLocal();
        db.soporte = [];
        guardarDBLocal(db);
        return res.json({ status: 'ok', mensaje: 'Todos los chats han sido eliminados' });
    }
});

// --- API SOPORTE TÉCNICO: Eliminar un mensaje individual por ID ---
app.delete('/api/soporte/:id', async (req, res) => {
    const { id } = req.params;
    if (pool) {
        try {
            await pool.query('DELETE FROM soporte WHERE id = $1', [id]);
            return res.json({ status: 'ok', mensaje: 'Mensaje eliminado' });
        } catch (err) {
            console.error('Error al eliminar mensaje:', err);
            return res.status(500).json({ error: 'Error al eliminar mensaje' });
        }
    } else {
        const db = leerDBLocal();
        db.soporte = (db.soporte || []).filter(m => m.id !== id);
        guardarDBLocal(db);
        return res.json({ status: 'ok', mensaje: 'Mensaje eliminado' });
    }
});

// API: Login exclusivo para Administradores
app.post('/api/admin/login', async (req, res) => {
    const usuario = req.body.usuario?.trim();
    const clave = req.body.clave?.trim();

    if (!usuario || !clave) {
        return res.status(400).json({ ok: false, error: 'Usuario y contraseña requeridos' });
    }

    if (pool) {
        try {
            const result = await pool.query(
                'SELECT usuario FROM administradores WHERE LOWER(usuario) = LOWER($1) AND clave = $2',
                [usuario, clave]
            );

            if (result.rows.length > 0) {
                return res.json({ ok: true, usuario: result.rows[0].usuario, message: 'Acceso concedido' });
            } else {
                return res.status(401).json({ ok: false, error: 'Credenciales no válidas' });
            }
        } catch (err) {
            console.error('Error en Login Admin (DB):', err);
            return res.status(500).json({ ok: false, error: 'Error en el servidor' });
        }
    } else {
        try {
            const db = leerDBLocal();
            const adminExiste = db.administradores?.find(
                a => a.usuario.trim().toLowerCase() === usuario.toLowerCase() && a.clave === clave
            );

            if (adminExiste) {
                return res.json({ ok: true, usuario: adminExiste.usuario, message: 'Acceso concedido' });
            } else {
                return res.status(401).json({ ok: false, error: 'Credenciales no válidas' });
            }
        } catch (err) {
            console.error('Error en Login Admin (Local):', err);
            return res.status(500).json({ ok: false, error: 'Error al leer la base local' });
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
                        COALESCE(historial_ediciones, '[]') AS "historialEdiciones",
                        codigo_recuperacion AS "codigoRecuperacion",
                        codigo_expiracion AS "codigoExpiracion"
                 FROM usuarios ORDER BY usuario ASC`
            );
            const usuariosNormalizados = result.rows.map(normalizarUsuario);
            return res.json(usuariosNormalizados);
        } catch (err) {
            return res.status(500).json({ error: 'Error al consultar PostgreSQL' });
        }
    } else {
        const db = leerDBLocal();
        const usuariosNormalizados = (db.usuarios || []).map(normalizarUsuario);
        res.json(usuariosNormalizados);
    }
});

// API: Registrar usuario normal
app.post('/api/usuarios/registrar', async (req, res) => {
    const { usuario, clave, correo, telefono, direccion } = req.body;
    if (!usuario || !clave) return res.status(400).json({ error: 'Usuario y clave requeridos' });
    if (!correo) return res.status(400).json({ error: 'El correo electrónico es requerido' });

    const fechaRegistro = new Date().toLocaleDateString();

    if (pool) {
        try {
            const existe = await pool.query('SELECT usuario FROM usuarios WHERE LOWER(usuario) = LOWER($1)', [usuario]);
            if (existe.rows.length > 0) return res.status(400).json({ error: 'El usuario ya existe' });

            const existeCorreo = await pool.query('SELECT usuario FROM usuarios WHERE LOWER(correo) = LOWER($1)', [correo]);
            if (existeCorreo.rows.length > 0) return res.status(400).json({ error: 'El correo electrónico ya está registrado' });

            const insertResult = await pool.query(
                `INSERT INTO usuarios (usuario, clave, correo, telefono, direccion, fecha_registro, contador_modificaciones, rol, estado, historial_ediciones)
                 VALUES ($1, $2, $3, $4, $5, $6, 0, 'Cliente', 'Activo', '[]')
                 RETURNING usuario, clave, correo, telefono, direccion, 
                           fecha_registro AS "fechaRegistro", 
                           contador_modificaciones AS "contadorModificaciones", 
                           rol, estado, historial_ediciones AS "historialEdiciones"`,
                [usuario, clave, correo, telefono || '', direccion || '', fechaRegistro]
            );

            return res.json({ mensaje: 'Usuario registrado', usuario: normalizarUsuario(insertResult.rows[0]) });
        } catch (err) {
            console.error('Error en registrar PostgreSQL:', err);
            return res.status(500).json({ error: 'Error en base de datos al registrar usuario' });
        }
    } else {
        const db = leerDBLocal();
        if (db.usuarios.some(u => u.usuario && u.usuario.toLowerCase() === usuario.toLowerCase())) {
            return res.status(400).json({ error: 'El usuario ya existe' });
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
        res.json({ mensaje: 'Usuario registrado', usuario: normalizarUsuario(nuevoUsuario) });
    }
});

// API: Iniciar sesión usuario normal
app.post('/api/usuarios/login', async (req, res) => {
    const { usuario, clave } = req.body;
    if (!usuario || !clave) return res.status(400).json({ error: 'Usuario y clave requeridos' });

    if (pool) {
        try {
            const result = await pool.query(
                `SELECT usuario, clave, correo, telefono, direccion, 
                        fecha_registro AS "fechaRegistro", 
                        contador_modificaciones AS "contadorModificaciones", 
                        COALESCE(rol, 'Cliente') AS "rol", 
                        COALESCE(estado, 'Activo') AS "estado", 
                        COALESCE(historial_ediciones, '[]') AS "historialEdiciones" 
                 FROM usuarios WHERE (LOWER(usuario) = LOWER($1) OR LOWER(correo) = LOWER($1)) AND clave = $2`,
                [usuario, clave]
            );

            if (result.rows.length > 0) {
                const user = normalizarUsuario(result.rows[0]);
                if (user.estado === 'Bloqueado') {
                    return res.status(403).json({ error: 'Tu cuenta ha sido bloqueada por el administrador.' });
                }
                if (user.estado === 'Inactivo') {
                    return res.status(403).json({ error: 'Tu cuenta se encuentra inactiva. Contacta al administrador.' });
                }
                res.json(user);
            } else {
                res.status(401).json({ error: 'Credenciales incorrectas' });
            }
        } catch (err) {
            res.status(500).json({ error: 'Error en PostgreSQL' });
        }
    } else {
        const db = leerDBLocal();
        const encontrado = db.usuarios.find(u =>
            (u.usuario.toLowerCase() === usuario.toLowerCase() || (u.correo && u.correo.toLowerCase() === usuario.toLowerCase())) &&
            u.clave === clave
        );
        if (encontrado) {
            const user = normalizarUsuario(encontrado);
            if (user.estado === 'Bloqueado') {
                return res.status(403).json({ error: 'Tu cuenta ha sido bloqueada por el administrador.' });
            }
            if (user.estado === 'Inactivo') {
                return res.status(403).json({ error: 'Tu cuenta se encuentra inactiva. Contacta al administrador.' });
            }
            res.json(user);
        } else {
            res.status(401).json({ error: 'Credenciales incorrectas' });
        }
    }
});

// --- RECUPERACIÓN DE CONTRASEÑA POR CORREO (OTP 6 DÍGITOS) ---

// 1. Solicitar código de recuperación
app.post('/api/usuarios/solicitar-codigo-recuperacion', async (req, res) => {
    const { correo } = req.body;
    if (!correo) return res.status(400).json({ error: 'El correo electrónico es requerido' });

    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
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

    try {
        const resultadoEnvio = await enviarCorreoRecuperacion(usuarioEncontrado.correo, codigo);

        if (resultadoEnvio && resultadoEnvio.enviado === false) {
            return res.status(400).json({
                error: 'No se detectó la variable RESEND_API_KEY en el servidor. Configúrala en Environment Variables.',
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

    const logAuditoria = {
        tipo: 'recuperacion',
        carpeta: '📁 Recuperación con OTP',
        editor: 'Sistema (OTP)',
        fecha: new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }),
        resumen: 'Contraseña restablecida exitosamente mediante código de seguridad OTP',
        cambios: [{
            campo: 'Contraseña',
            valorAnterior: '••••••••',
            valorNuevo: '•••••••• (Restablecida)'
        }]
    };

    if (pool) {
        try {
            const userRes = await pool.query(
                `SELECT usuario, codigo_recuperacion, codigo_expiracion, contador_modificaciones, historial_ediciones 
                 FROM usuarios WHERE LOWER(correo) = LOWER($1)`,
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

            let historial = [];
            try {
                historial = JSON.parse(user.historial_ediciones || '[]');
            } catch (e) { historial = []; }
            historial.unshift(logAuditoria);

            const nuevoContador = (parseInt(user.contador_modificaciones || 0)) + 1;

            await pool.query(
                `UPDATE usuarios 
                 SET clave = $1, codigo_recuperacion = NULL, codigo_expiracion = NULL, 
                     contador_modificaciones = $2, historial_ediciones = $3 
                 WHERE LOWER(correo) = LOWER($4)`,
                [nuevaClave, nuevoContador, JSON.stringify(historial), correo]
            );

            return res.json({ ok: true, mensaje: 'Contraseña actualizada con éxito' });
        } catch (err) {
            console.error('Error al restablecer clave en PostgreSQL:', err);
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

        if (!Array.isArray(user.historialEdiciones)) user.historialEdiciones = [];
        user.historialEdiciones.unshift(logAuditoria);
        user.clave = nuevaClave;
        user.codigoRecuperacion = null;
        user.codigoExpiracion = null;
        user.contadorModificaciones = (parseInt(user.contadorModificaciones || 0)) + 1;

        guardarDBLocal(db);
        return res.json({ ok: true, mensaje: 'Contraseña actualizada con éxito' });
    }
});

// API: Editar perfil del usuario desde index.html
app.put('/api/usuarios/editar', async (req, res) => {
    const { usuario, correo, telefono, direccion } = req.body;
    if (!usuario) return res.status(400).json({ error: 'Nombre de usuario requerido' });

    if (pool) {
        try {
            const userRes = await pool.query(
                `SELECT usuario, clave, correo, telefono, direccion, 
                        fecha_registro AS "fechaRegistro", 
                        contador_modificaciones AS "contadorModificaciones", 
                        COALESCE(rol, 'Cliente') AS "rol", 
                        COALESCE(estado, 'Activo') AS "estado", 
                        COALESCE(historial_ediciones, '[]') AS "historialEdiciones" 
                 FROM usuarios WHERE LOWER(usuario) = LOWER($1)`,
                [usuario]
            );

            if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
            const userActual = normalizarUsuario(userRes.rows[0]);

            const cambios = [];
            const nuevoCorreo = correo !== undefined ? correo.trim() : userActual.correo;
            const nuevoTelefono = telefono !== undefined ? telefono.trim() : userActual.telefono;
            const nuevaDireccion = direccion !== undefined ? direccion.trim() : userActual.direccion;

            if (nuevoCorreo !== userActual.correo) {
                cambios.push({ campo: 'Correo Electrónico', valorAnterior: userActual.correo || 'Vacío', valorNuevo: nuevoCorreo || 'Vacío' });
            }
            if (nuevoTelefono !== userActual.telefono) {
                cambios.push({ campo: 'Teléfono', valorAnterior: userActual.telefono || 'Vacío', valorNuevo: nuevoTelefono || 'Vacío' });
            }
            if (nuevaDireccion !== userActual.direccion) {
                cambios.push({ campo: 'Dirección', valorAnterior: userActual.direccion || 'Vacío', valorNuevo: nuevaDireccion || 'Vacío' });
            }

            let historial = userActual.historialEdiciones;
            let nuevoContador = userActual.contadorModificaciones;

            if (cambios.length > 0) {
                const logAuditoria = {
                    tipo: 'perfil',
                    carpeta: '📁 Actualización de Perfil',
                    editor: 'Usuario',
                    fecha: new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }),
                    resumen: `${cambios.length} campo(s) de perfil modificado(s)`,
                    cambios: cambios
                };
                historial.unshift(logAuditoria);
                nuevoContador++;
            }

            const updateResult = await pool.query(
                `UPDATE usuarios 
                 SET correo = $2, telefono = $3, direccion = $4, contador_modificaciones = $5, historial_ediciones = $6 
                 WHERE LOWER(usuario) = LOWER($1)
                 RETURNING usuario, clave, correo, telefono, direccion, 
                           fecha_registro AS "fechaRegistro", 
                           contador_modificaciones AS "contadorModificaciones", 
                           COALESCE(rol, 'Cliente') AS "rol", 
                           COALESCE(estado, 'Activo') AS "estado", 
                           COALESCE(historial_ediciones, '[]') AS "historialEdiciones"`,
                [usuario, nuevoCorreo, nuevoTelefono, nuevaDireccion, nuevoContador, JSON.stringify(historial)]
            );

            res.json({ mensaje: 'Perfil actualizado', usuario: normalizarUsuario(updateResult.rows[0]) });
        } catch (err) {
            console.error('Error al editar perfil PostgreSQL:', err);
            res.status(500).json({ error: 'Error al actualizar perfil en el servidor' });
        }
    } else {
        const db = leerDBLocal();
        const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === usuario.toLowerCase());
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
        res.json({ mensaje: 'Perfil actualizado', usuario: normalizarUsuario(db.usuarios[idx]) });
    }
});

// API: Cambiar contraseña voluntariamente desde el perfil (index.html)
app.put('/api/usuarios/cambiar-clave', async (req, res) => {
    const { usuario, claveActual, claveNueva } = req.body;
    if (!usuario || !claveActual || !claveNueva) {
        return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    if (claveNueva.length < 6) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
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

    if (pool) {
        try {
            const userRes = await pool.query(
                `SELECT usuario, clave, contador_modificaciones, historial_ediciones 
                 FROM usuarios WHERE LOWER(usuario) = LOWER($1)`,
                [usuario]
            );

            if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
            const user = userRes.rows[0];

            if (user.clave !== claveActual) {
                return res.status(400).json({ error: 'La contraseña actual no es correcta' });
            }

            let historial = [];
            try { historial = JSON.parse(user.historial_ediciones || '[]'); } catch (e) { historial = []; }
            historial.unshift(logAuditoria);
            const nuevoContador = (parseInt(user.contador_modificaciones || 0)) + 1;

            const updateResult = await pool.query(
                `UPDATE usuarios 
                 SET clave = $1, contador_modificaciones = $2, historial_ediciones = $3 
                 WHERE LOWER(usuario) = LOWER($4)
                 RETURNING usuario, clave, correo, telefono, direccion, 
                           fecha_registro AS "fechaRegistro", 
                           contador_modificaciones AS "contadorModificaciones", 
                           COALESCE(rol, 'Cliente') AS "rol", 
                           COALESCE(estado, 'Activo') AS "estado", 
                           COALESCE(historial_ediciones, '[]') AS "historialEdiciones"`,
                [claveNueva, nuevoContador, JSON.stringify(historial), usuario]
            );

            res.json({ ok: true, mensaje: 'Contraseña cambiada con éxito', usuario: normalizarUsuario(updateResult.rows[0]) });
        } catch (err) {
            console.error('Error al cambiar clave en PostgreSQL:', err);
            res.status(500).json({ error: 'Error en el servidor al cambiar contraseña' });
        }
    } else {
        const db = leerDBLocal();
        const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === usuario.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

        if (db.usuarios[idx].clave !== claveActual) {
            return res.status(400).json({ error: 'La contraseña actual no es correcta' });
        }

        if (!Array.isArray(db.usuarios[idx].historialEdiciones)) db.usuarios[idx].historialEdiciones = [];
        db.usuarios[idx].historialEdiciones.unshift(logAuditoria);
        db.usuarios[idx].clave = claveNueva;
        db.usuarios[idx].contadorModificaciones = (parseInt(db.usuarios[idx].contadorModificaciones || 0)) + 1;

        guardarDBLocal(db);
        res.json({ ok: true, mensaje: 'Contraseña cambiada con éxito', usuario: normalizarUsuario(db.usuarios[idx]) });
    }
});

// API: Edición completa de usuario por el Administrador (admin.html)
app.put(['/api/usuarios/admin-editar', '/api/usuarios/:usuario'], async (req, res) => {
    const usuarioTarget = req.params.usuario || req.body.usuario || req.body.originalUsuario;
    const { correo, telefono, direccion, clave, rol, estado } = req.body;

    if (!usuarioTarget) return res.status(400).json({ error: 'Usuario objetivo requerido' });

    if (pool) {
        try {
            const userRes = await pool.query(
                `SELECT usuario, clave, correo, telefono, direccion, 
                        fecha_registro AS "fechaRegistro", 
                        contador_modificaciones AS "contadorModificaciones", 
                        COALESCE(rol, 'Cliente') AS "rol", 
                        COALESCE(estado, 'Activo') AS "estado", 
                        COALESCE(historial_ediciones, '[]') AS "historialEdiciones" 
                 FROM usuarios WHERE LOWER(usuario) = LOWER($1)`,
                [usuarioTarget]
            );

            if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
            const userActual = normalizarUsuario(userRes.rows[0]);

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

            let historial = userActual.historialEdiciones;
            let nuevoContador = userActual.contadorModificaciones;

            if (cambios.length > 0) {
                const logAuditoria = {
                    tipo: 'admin',
                    carpeta: '📁 Modificación por Administrador',
                    editor: 'Administrador',
                    fecha: new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'medium' }),
                    resumen: `${cambios.length} cambio(s) realizado(s) por el Administrador`,
                    cambios: cambios
                };
                historial.unshift(logAuditoria);
                nuevoContador++;
            }

            const updateResult = await pool.query(
                `UPDATE usuarios 
                 SET correo = $2, telefono = $3, direccion = $4, clave = $5, rol = $6, estado = $7, 
                     contador_modificaciones = $8, historial_ediciones = $9 
                 WHERE LOWER(usuario) = LOWER($1)
                 RETURNING usuario, clave, correo, telefono, direccion, 
                           fecha_registro AS "fechaRegistro", 
                           contador_modificaciones AS "contadorModificaciones", 
                           COALESCE(rol, 'Cliente') AS "rol", 
                           COALESCE(estado, 'Activo') AS "estado", 
                           COALESCE(historial_ediciones, '[]') AS "historialEdiciones"`,
                [usuarioTarget, nuevoCorreo, nuevoTelefono, nuevaDireccion, nuevaClave, nuevoRol, nuevoEstado, nuevoContador, JSON.stringify(historial)]
            );

            res.json({ ok: true, mensaje: 'Usuario actualizado con éxito', usuario: normalizarUsuario(updateResult.rows[0]) });
        } catch (err) {
            console.error('Error al editar usuario por Admin PostgreSQL:', err);
            res.status(500).json({ error: 'Error en el servidor al actualizar usuario' });
        }
    } else {
        const db = leerDBLocal();
        const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === usuarioTarget.toLowerCase());
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
        res.json({ ok: true, mensaje: 'Usuario actualizado con éxito', usuario: normalizarUsuario(db.usuarios[idx]) });
    }
});

// API: Eliminar usuario individual
app.delete('/api/usuarios/:usuario', async (req, res) => {
    const nombreUsuario = req.params.usuario;

    if (pool) {
        try {
            await pool.query('DELETE FROM usuarios WHERE LOWER(usuario) = LOWER($1)', [nombreUsuario]);
            res.json({ mensaje: 'Usuario eliminado' });
        } catch (err) {
            res.status(500).json({ error: 'Error al eliminar usuario' });
        }
    } else {
        const db = leerDBLocal();
        db.usuarios = db.usuarios.filter(u => u.usuario.toLowerCase() !== nombreUsuario.toLowerCase());
        guardarDBLocal(db);
        res.json({ mensaje: 'Usuario eliminado' });
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

// Redirección por defecto (SIEMPRE AL FINAL)
app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor iniciado en puerto ${PORT}`);
});