const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

const ADMIN_DEFAULT = {
    usuario: 'Admin',
    clave: 'An12345*'
};

let pool = null;
if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    console.log('Conectado a PostgreSQL');

    const initDb = async () => {
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS usuarios (
                    usuario VARCHAR(255) PRIMARY KEY,
                    clave TEXT NOT NULL,
                    nombre TEXT DEFAULT '',
                    apellido TEXT DEFAULT '',
                    ci TEXT DEFAULT '',
                    telefono TEXT DEFAULT '',
                    direccion TEXT DEFAULT '',
                    fecha_registro TEXT,
                    contador_modificaciones INT DEFAULT 0,
                    historial_modificaciones JSONB DEFAULT '[]'::jsonb
                );
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
                INSERT INTO administradores (usuario, clave) 
                VALUES ($1, $2)
                ON CONFLICT (usuario) DO UPDATE SET clave = EXCLUDED.clave;
            `, [ADMIN_DEFAULT.usuario, ADMIN_DEFAULT.clave]);

            console.log('Tablas inicializadas en PostgreSQL');
        } catch (err) {
            console.error('Error al inicializar PostgreSQL:', err);
        }
    };
    initDb();
} else {
    console.log('Modo fallback db.json local');
}

const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'Public'))
    ? path.join(__dirname, 'Public')
    : path.join(__dirname, 'public');

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get(['/admin', '/admin.html'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

function leerDBLocal() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ usuarios: [], administradores: [ADMIN_DEFAULT], descargas: [] }));
    }
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
        if (Array.isArray(data)) return { usuarios: data, administradores: [ADMIN_DEFAULT], descargas: [] };
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

// LOGIN ADMIN
app.post('/api/admin/login', async (req, res) => {
    const { usuario, clave } = req.body;
    if (pool) {
        try {
            const result = await pool.query('SELECT usuario FROM administradores WHERE usuario = $1 AND clave = $2', [usuario, clave]);
            if (result.rows.length > 0) res.json({ ok: true, usuario: result.rows[0].usuario });
            else res.status(401).json({ error: 'Credenciales inválidas' });
        } catch (err) {
            res.status(500).json({ error: 'Error del servidor' });
        }
    } else {
        const db = leerDBLocal();
        const admin = db.administradores.find(a => a.usuario === usuario && a.clave === clave);
        if (admin) res.json({ ok: true, usuario: admin.usuario });
        else res.status(401).json({ error: 'Credenciales inválidas' });
    }
});

// OBTENER USUARIOS
app.get('/api/usuarios', async (req, res) => {
    if (pool) {
        try {
            const result = await pool.query(`
                SELECT usuario, clave, nombre, apellido, ci, telefono, direccion, 
                       fecha_registro AS "fechaRegistro", 
                       contador_modificaciones AS "contadorModificaciones",
                       historial_modificaciones AS "historialModificaciones"
                FROM usuarios ORDER BY usuario ASC
            `);
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: 'Error al consultar usuarios' });
        }
    } else {
        const db = leerDBLocal();
        res.json(db.usuarios || []);
    }
});

// REGISTRAR USUARIO
app.post('/api/usuarios/registrar', async (req, res) => {
    const { usuario, clave, nombre, apellido, ci, telefono, direccion } = req.body;
    if (!usuario || !clave) return res.status(400).json({ error: 'Usuario y clave requeridos' });

    const fechaRegistro = new Date().toLocaleDateString();

    if (pool) {
        try {
            const existe = await pool.query('SELECT usuario FROM usuarios WHERE LOWER(usuario) = LOWER($1)', [usuario]);
            if (existe.rows.length > 0) return res.status(400).json({ error: 'El usuario ya existe' });

            const insertResult = await pool.query(`
                INSERT INTO usuarios (usuario, clave, nombre, apellido, ci, telefono, direccion, fecha_registro, contador_modificaciones, historial_modificaciones)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, '[]'::jsonb)
                RETURNING usuario, clave, nombre, apellido, ci, telefono, direccion, fecha_registro AS "fechaRegistro", contador_modificaciones AS "contadorModificaciones", historial_modificaciones AS "historialModificaciones"
            `, [usuario, clave, nombre || '', apellido || '', ci || '', telefono || '', direccion || '', fechaRegistro]);

            res.json({ mensaje: 'Usuario registrado', usuario: insertResult.rows[0] });
        } catch (err) {
            res.status(500).json({ error: 'Error en la base de datos' });
        }
    } else {
        const db = leerDBLocal();
        if (db.usuarios.some(u => u.usuario.toLowerCase() === usuario.toLowerCase())) {
            return res.status(400).json({ error: 'El usuario ya existe' });
        }
        const nuevo = { usuario, clave, nombre: nombre || '', apellido: apellido || '', ci: ci || '', telefono: telefono || '', direccion: direccion || '', fechaRegistro, contadorModificaciones: 0, historialModificaciones: [] };
        db.usuarios.push(nuevo);
        guardarDBLocal(db);
        res.json({ mensaje: 'Usuario registrado', usuario: nuevo });
    }
});

// LOGIN USUARIO
app.post('/api/usuarios/login', async (req, res) => {
    const { usuario, clave } = req.body;
    if (pool) {
        try {
            const result = await pool.query(`
                SELECT usuario, clave, nombre, apellido, ci, telefono, direccion, 
                       fecha_registro AS "fechaRegistro", 
                       contador_modificaciones AS "contadorModificaciones",
                       historial_modificaciones AS "historialModificaciones"
                FROM usuarios WHERE usuario = $1 AND clave = $2
            `, [usuario, clave]);

            if (result.rows.length > 0) res.json(result.rows[0]);
            else res.status(401).json({ error: 'Credenciales incorrectas' });
        } catch (err) {
            res.status(500).json({ error: 'Error del servidor' });
        }
    } else {
        const db = leerDBLocal();
        const enc = db.usuarios.find(u => u.usuario === usuario && u.clave === clave);
        if (enc) res.json(enc);
        else res.status(401).json({ error: 'Credenciales incorrectas' });
    }
});

// EDITAR PERFIL Y GUARDAR FECHA DE MODIFICACIÓN
app.put('/api/usuarios/editar', async (req, res) => {
    const { usuario, clave, nombre, apellido, ci, telefono, direccion } = req.body;
    const fechaHoraMod = `${new Date().toLocaleDateString()} - ${new Date().toLocaleTimeString()}`;

    if (pool) {
        try {
            const updateResult = await pool.query(`
                UPDATE usuarios 
                SET clave = $2, nombre = $3, apellido = $4, ci = $5, telefono = $6, direccion = $7,
                    contador_modificaciones = COALESCE(contador_modificaciones, 0) + 1,
                    historial_modificaciones = COALESCE(historial_modificaciones, '[]'::jsonb) || jsonb_build_array($8::text)
                WHERE LOWER(usuario) = LOWER($1)
                RETURNING usuario, clave, nombre, apellido, ci, telefono, direccion, fecha_registro AS "fechaRegistro", contador_modificaciones AS "contadorModificaciones", historial_modificaciones AS "historialModificaciones"
            `, [usuario, clave, nombre, apellido, ci, telefono, direccion, fechaHoraMod]);

            if (updateResult.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
            res.json({ mensaje: 'Perfil actualizado', usuario: updateResult.rows[0] });
        } catch (err) {
            res.status(500).json({ error: 'Error al actualizar perfil' });
        }
    } else {
        const db = leerDBLocal();
        const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === usuario.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

        db.usuarios[idx].clave = clave;
        db.usuarios[idx].nombre = nombre;
        db.usuarios[idx].apellido = apellido;
        db.usuarios[idx].ci = ci;
        db.usuarios[idx].telefono = telefono;
        db.usuarios[idx].direccion = direccion;
        db.usuarios[idx].contadorModificaciones = (db.usuarios[idx].contadorModificaciones || 0) + 1;
        if (!db.usuarios[idx].historialModificaciones) db.usuarios[idx].historialModificaciones = [];
        db.usuarios[idx].historialModificaciones.push(fechaHoraMod);

        guardarDBLocal(db);
        res.json({ mensaje: 'Perfil actualizado', usuario: db.usuarios[idx] });
    }
});

// ELIMINAR USUARIO
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

// VACIAR USUARIOS
app.delete('/api/usuarios', async (req, res) => {
    if (pool) {
        try {
            await pool.query('TRUNCATE TABLE usuarios');
            res.json({ mensaje: 'Base de datos vaciada' });
        } catch (err) {
            res.status(500).json({ error: 'Error al vaciar base de datos' });
        }
    } else {
        const db = leerDBLocal();
        db.usuarios = [];
        guardarDBLocal(db);
        res.json({ mensaje: 'Base de datos vaciada' });
    }
});

// REGISTRAR Y OBTENER HISTORIAL DE DESCARGAS
app.post('/api/descargas', async (req, res) => {
    const { formato } = req.body;
    const ahora = new Date();
    const fecha = ahora.toLocaleDateString();
    const hora = ahora.toLocaleTimeString();

    if (pool) {
        try {
            const result = await pool.query('INSERT INTO descargas (formato, fecha, hora) VALUES ($1, $2, $3) RETURNING *', [formato, fecha, hora]);
            res.json(result.rows[0]);
        } catch (err) {
            res.status(500).json({ error: 'Error al registrar descarga' });
        }
    } else {
        const db = leerDBLocal();
        const nueva = { id: Date.now(), formato, fecha, hora };
        db.descargas.push(nueva);
        guardarDBLocal(db);
        res.json(nueva);
    }
});

app.get('/api/descargas', async (req, res) => {
    if (pool) {
        try {
            const result = await pool.query('SELECT * FROM descargas ORDER BY id DESC');
            res.json(result.rows);
        } catch (err) {
            res.status(500).json({ error: 'Error al obtener descargas' });
        }
    } else {
        const db = leerDBLocal();
        res.json((db.descargas || []).reverse());
    }
});

app.delete('/api/descargas/:id', async (req, res) => {
    const { id } = req.params;
    if (pool) {
        try {
            await pool.query('DELETE FROM descargas WHERE id = $1', [id]);
            res.json({ mensaje: 'Registro eliminado' });
        } catch (err) {
            res.status(500).json({ error: 'Error al eliminar registro' });
        }
    } else {
        const db = leerDBLocal();
        db.descargas = db.descargas.filter(d => d.id.toString() !== id.toString());
        guardarDBLocal(db);
        res.json({ mensaje: 'Registro eliminado' });
    }
});

app.delete('/api/descargas', async (req, res) => {
    if (pool) {
        try {
            await pool.query('TRUNCATE TABLE descargas');
            res.json({ mensaje: 'Historial vaciado' });
        } catch (err) {
            res.status(500).json({ error: 'Error al vaciar historial' });
        }
    } else {
        const db = leerDBLocal();
        db.descargas = [];
        guardarDBLocal(db);
        res.json({ mensaje: 'Historial vaciado' });
    }
});

app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`Servidor en puerto ${PORT}`));