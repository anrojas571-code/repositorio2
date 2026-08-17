require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { Resend } = require('resend'); // Se cambió Nodemailer por el SDK Oficial de Resend

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

// Función auxiliar para enviar el correo de recuperación mediante la API HTTP de Resend
async function enviarCorreoRecuperacion(correoDestino, codigo) {
    console.log(`\n==================================================`);
    console.log(`[CÓDIGO DE RECUPERACIÓN GENERADO]`);
    console.log(`Para: ${correoDestino}`);
    console.log(`Código OTP (6 dígitos): ${codigo}`);
    console.log(`Válido durante: 2 minutos (120 segundos)`);
    console.log(`==================================================\n`);

    const apiKey = obtenerApiKeyResend();

    if (!apiKey) {
        console.warn(`[EMAIL ADVERTENCIA] No se envió el correo porque falta RESEND_API_KEY / EMAIL_PASS en Render.`);
        return { enviado: false, motivo: 'no_credentials', codigo };
    }

    const resend = new Resend(apiKey);

    // Determinar dirección del remitente (from) válida
    let remitenteFinal = process.env.EMAIL_FROM || 'Sistema de Usuarios <onboarding@resend.dev>';

    console.log(`[EMAIL DISPARANDO VIA API HTTP] Enviando a ${correoDestino} desde ${remitenteFinal}...`);

    try {
        const data = await resend.emails.send({
            from: remitenteFinal,
            to: correoDestino,
            subject: '🔒 Código de Recuperación de Contraseña (6 dígitos)',
            text: `Tu código de recuperación es: ${codigo}. Este código vence en 2 minutos.\nRevisa también tu carpeta de Spam / Correo No Deseado.`,
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
                    <p style="color: #ef4444; font-size: 13px; font-weight: 700; text-align: center; margin-bottom: 8px;">⏰ Este código caducará en exactamente 2 minutos.</p>
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
                    codigo_recuperacion TEXT,
                    codigo_expiracion BIGINT
                );
            `);

            // Asegurar que columnas nuevas existan si la tabla ya existía
            await pool.query(`
                ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS correo TEXT;
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
function leerDBLocal() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ usuarios: [], administradores: [ADMIN_DEFAULT], descargas: [] }));
    }
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
        if (Array.isArray(data)) {
            return { usuarios: data, administradores: [ADMIN_DEFAULT], descargas: [] };
        }
        if (!data.administradores) data.administradores = [ADMIN_DEFAULT];
        if (!data.descargas) data.descargas = [];
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
                'SELECT usuario FROM administradores WHERE usuario = $1 AND clave = $2',
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
        const adminExiste = db.administradores.find(a => a.usuario === usuario && a.clave === clave);
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
                        contador_modificaciones AS "contadorModificaciones" 
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
                `INSERT INTO usuarios (usuario, clave, correo, telefono, direccion, fecha_registro, contador_modificaciones)
                 VALUES ($1, $2, $3, $4, $5, $6, 0)
                 RETURNING usuario, clave, correo, telefono, direccion, fecha_registro AS "fechaRegistro", contador_modificaciones AS "contadorModificaciones"`,
                [usuario, clave, correo, telefono || '', direccion || '', fechaRegistro]
            );

            return res.json({ mensaje: 'Usuario registrado', usuario: insertResult.rows[0] });
        } catch (err) {
            return res.status(500).json({ error: 'Error en base de datos' });
        }
    } else {
        const db = leerDBLocal();
        if (db.usuarios.some(u => u.usuario.toLowerCase() === usuario.toLowerCase())) {
            return res.status(400).json({ error: 'El usuario ya existe' });
        }
        if (db.usuarios.some(u => u.correo && u.correo.toLowerCase() === correo.toLowerCase())) {
            return res.status(400).json({ error: 'El correo electrónico ya está registrado' });
        }

        const nuevoUsuario = { usuario, clave, correo, telefono, direccion, fechaRegistro, contadorModificaciones: 0 };
        db.usuarios.push(nuevoUsuario);
        guardarDBLocal(db);
        res.json({ mensaje: 'Usuario registrado', usuario: nuevoUsuario });
    }
});

// API: Iniciar sesión usuario normal
app.post('/api/usuarios/login', async (req, res) => {
    const { usuario, clave } = req.body;

    if (pool) {
        try {
            const result = await pool.query(
                `SELECT usuario, clave, correo, telefono, direccion, 
                        fecha_registro AS "fechaRegistro", 
                        contador_modificaciones AS "contadorModificaciones" 
                 FROM usuarios WHERE (LOWER(usuario) = LOWER($1) OR LOWER(correo) = LOWER($1)) AND clave = $2`,
                [usuario, clave]
            );

            if (result.rows.length > 0) {
                res.json(result.rows[0]);
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
        if (encontrado) res.json(encontrado);
        else res.status(401).json({ error: 'Credenciales incorrectas' });
    }
});

// --- API: RECUPERACIÓN DE CONTRASEÑA POR CORREO (CÓDIGO DE 6 DÍGITOS - 2 MINUTOS) ---

// 1. Solicitar código de recuperación
app.post('/api/usuarios/solicitar-codigo-recuperacion', async (req, res) => {
    const { correo } = req.body;
    if (!correo) return res.status(400).json({ error: 'El correo electrónico es requerido' });

    // Generar código numérico de 6 dígitos
    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    // Expiración: 2 minutos a partir de este momento (120.000 ms)
    const expiracion = Date.now() + (2 * 60 * 1000);

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
                return res.status(400).json({ error: 'El código ha expirado (duración máxima: 2 minutos)' });
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
            return res.status(400).json({ error: 'El código ha expirado (duración máxima: 2 minutos)' });
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
                'SELECT codigo_recuperacion, codigo_expiracion FROM usuarios WHERE LOWER(correo) = LOWER($1)',
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

            await pool.query(
                `UPDATE usuarios 
                 SET clave = $1, codigo_recuperacion = NULL, codigo_expiracion = NULL, 
                     contador_modificaciones = COALESCE(contador_modificaciones, 0) + 1 
                 WHERE LOWER(correo) = LOWER($2)`,
                [nuevaClave, correo]
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

        db.usuarios[idx].clave = nuevaClave;
        db.usuarios[idx].codigoRecuperacion = null;
        db.usuarios[idx].codigoExpiracion = null;
        db.usuarios[idx].contadorModificaciones = (db.usuarios[idx].contadorModificaciones || 0) + 1;
        guardarDBLocal(db);

        return res.json({ ok: true, mensaje: 'Contraseña actualizada con éxito' });
    }
});

// API: Editar perfil
app.put('/api/usuarios/editar', async (req, res) => {
    const { usuario, clave, correo, telefono, direccion } = req.body;

    if (pool) {
        try {
            const updateResult = await pool.query(
                `UPDATE usuarios 
                 SET clave = $2, correo = $3, telefono = $4, direccion = $5, contador_modificaciones = COALESCE(contador_modificaciones, 0) + 1 
                 WHERE LOWER(usuario) = LOWER($1)
                 RETURNING usuario, clave, correo, telefono, direccion, fecha_registro AS "fechaRegistro", contador_modificaciones AS "contadorModificaciones"`,
                [usuario, clave, correo, telefono, direccion]
            );

            if (updateResult.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
            res.json({ mensaje: 'Perfil actualizado', usuario: updateResult.rows[0] });
        } catch (err) {
            res.status(500).json({ error: 'Error al actualizar' });
        }
    } else {
        const db = leerDBLocal();
        const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === usuario.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

        db.usuarios[idx].clave = clave;
        if (correo) db.usuarios[idx].correo = correo;
        db.usuarios[idx].telefono = telefono;
        db.usuarios[idx].direccion = direccion;
        db.usuarios[idx].contadorModificaciones = (db.usuarios[idx].contadorModificaciones || 0) + 1;

        guardarDBLocal(db);
        res.json({ mensaje: 'Perfil actualizado', usuario: db.usuarios[idx] });
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

// API: Vaciar usuarios
app.delete('/api/usuarios', async (req, res) => {
    if (pool) {
        try {
            await pool.query('TRUNCATE TABLE usuarios');
            res.json({ mensaje: 'Base de datos vaciada' });
        } catch (err) {
            res.status(500).json({ error: 'Error al vaciar la base de datos' });
        }
    } else {
        const db = leerDBLocal();
        db.usuarios = [];
        guardarDBLocal(db);
        res.json({ mensaje: 'Base de datos vaciada' });
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
        res.json(db.descargas.reverse());
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