const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// Credenciales del administrador inicial
const ADMIN_DEFAULT = {
    usuario: 'Admin',
    clave: 'An12345*'
};

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
            // Tabla de usuarios regulares
            await pool.query(`
                CREATE TABLE IF NOT EXISTS usuarios (
                    usuario VARCHAR(255) PRIMARY KEY,
                    clave TEXT NOT NULL,
                    telefono TEXT,
                    direccion TEXT,
                    fecha_registro TEXT,
                    contador_modificaciones INT DEFAULT 0
                );
            `);

            // Tabla de administradores (preparada para agregar más en el futuro)
            await pool.query(`
                CREATE TABLE IF NOT EXISTS administradores (
                    usuario VARCHAR(255) PRIMARY KEY,
                    clave TEXT NOT NULL,
                    rol VARCHAR(50) DEFAULT 'admin'
                );
            `);

            // Insertar o actualizar el admin por defecto
            await pool.query(`
                INSERT INTO administradores (usuario, clave) 
                VALUES ($1, $2)
                ON CONFLICT (usuario) DO UPDATE SET clave = EXCLUDED.clave;
            `, [ADMIN_DEFAULT.usuario, ADMIN_DEFAULT.clave]);

            console.log('Tablas "usuarios" y "administradores" listas en PostgreSQL');
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
        fs.writeFileSync(DB_FILE, JSON.stringify({ usuarios: [], administradores: [ADMIN_DEFAULT] }));
    }
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
        // Compatibilidad si db.json antes era solo un array
        if (Array.isArray(data)) {
            return { usuarios: data, administradores: [ADMIN_DEFAULT] };
        }
        if (!data.administradores) {
            data.administradores = [ADMIN_DEFAULT];
        }
        return data;
    } catch (e) {
        return { usuarios: [], administradores: [ADMIN_DEFAULT] };
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
                res.status(401).json({ error: 'Credenciales de administrador no válidas' });
            }
        } catch (err) {
            console.error('Error en POST /api/admin/login:', err);
            res.status(500).json({ error: 'Error en el servidor' });
        }
    } else {
        const db = leerDBLocal();
        const adminExiste = db.administradores.find(a => a.usuario === usuario && a.clave === clave);

        if (adminExiste) {
            res.json({ ok: true, usuario: adminExiste.usuario });
        } else {
            res.status(401).json({ error: 'Credenciales de administrador no válidas' });
        }
    }
});

// API: Obtener todos los usuarios (Para el panel de admin)
app.get('/api/usuarios', async (req, res) => {
    if (pool) {
        try {
            const result = await pool.query(
                `SELECT usuario, clave, telefono, direccion, 
                        fecha_registro AS "fechaRegistro", 
                        contador_modificaciones AS "contadorModificaciones" 
                 FROM usuarios ORDER BY usuario ASC`
            );
            return res.json(result.rows);
        } catch (err) {
            console.error('Error en GET /api/usuarios:', err);
            return res.status(500).json({ error: 'Error al consultar PostgreSQL' });
        }
    } else {
        const db = leerDBLocal();
        res.json(db.usuarios || []);
    }
});

// API: Registrar usuario normal
app.post('/api/usuarios/registrar', async (req, res) => {
    const { usuario, clave, telefono, direccion } = req.body;
    if (!usuario || !clave) {
        return res.status(400).json({ error: 'Usuario y clave son requeridos' });
    }

    const fechaRegistro = new Date().toLocaleDateString();

    if (pool) {
        try {
            const existe = await pool.query('SELECT usuario FROM usuarios WHERE LOWER(usuario) = LOWER($1)', [usuario]);
            if (existe.rows.length > 0) {
                return res.status(400).json({ error: 'El usuario ya existe' });
            }

            const insertResult = await pool.query(
                `INSERT INTO usuarios (usuario, clave, telefono, direccion, fecha_registro, contador_modificaciones)
                 VALUES ($1, $2, $3, $4, $5, 0)
                 RETURNING usuario, clave, telefono, direccion, fecha_registro AS "fechaRegistro", contador_modificaciones AS "contadorModificaciones"`,
                [usuario, clave, telefono || '', direccion || '', fechaRegistro]
            );

            return res.json({ mensaje: 'Usuario registrado con éxito', usuario: insertResult.rows[0] });
        } catch (err) {
            console.error('Error en POST /api/usuarios/registrar:', err);
            return res.status(500).json({ error: 'Error en la base de datos PostgreSQL' });
        }
    } else {
        const db = leerDBLocal();
        const yaExiste = db.usuarios.some(u => u.usuario.toLowerCase() === usuario.toLowerCase());
        if (yaExiste) {
            return res.status(400).json({ error: 'El usuario ya existe' });
        }

        const nuevoUsuario = {
            usuario,
            clave,
            telefono,
            direccion,
            fechaRegistro,
            contadorModificaciones: 0
        };

        db.usuarios.push(nuevoUsuario);
        guardarDBLocal(db);
        res.json({ mensaje: 'Usuario registrado con éxito', usuario: nuevoUsuario });
    }
});

// API: Iniciar sesión de usuario regular
app.post('/api/usuarios/login', async (req, res) => {
    const { usuario, clave } = req.body;

    if (pool) {
        try {
            const result = await pool.query(
                `SELECT usuario, clave, telefono, direccion, 
                        fecha_registro AS "fechaRegistro", 
                        contador_modificaciones AS "contadorModificaciones" 
                 FROM usuarios WHERE usuario = $1 AND clave = $2`,
                [usuario, clave]
            );

            if (result.rows.length > 0) {
                res.json(result.rows[0]);
            } else {
                res.status(401).json({ error: 'Credenciales incorrectas' });
            }
        } catch (err) {
            console.error('Error en POST /api/usuarios/login:', err);
            res.status(500).json({ error: 'Error en PostgreSQL' });
        }
    } else {
        const db = leerDBLocal();
        const encontrado = db.usuarios.find(u => u.usuario === usuario && u.clave === clave);

        if (encontrado) {
            res.json(encontrado);
        } else {
            res.status(401).json({ error: 'Credenciales incorrectas' });
        }
    }
});

// API: Editar perfil de usuario
app.put('/api/usuarios/editar', async (req, res) => {
    const { usuario, clave, telefono, direccion } = req.body;

    if (pool) {
        try {
            const updateResult = await pool.query(
                `UPDATE usuarios 
                 SET clave = $2, telefono = $3, direccion = $4, contador_modificaciones = COALESCE(contador_modificaciones, 0) + 1 
                 WHERE LOWER(usuario) = LOWER($1)
                 RETURNING usuario, clave, telefono, direccion, fecha_registro AS "fechaRegistro", contador_modificaciones AS "contadorModificaciones"`,
                [usuario, clave, telefono, direccion]
            );

            if (updateResult.rows.length === 0) {
                return res.status(404).json({ error: 'Usuario no encontrado' });
            }

            res.json({ mensaje: 'Perfil actualizado', usuario: updateResult.rows[0] });
        } catch (err) {
            console.error('Error en PUT /api/usuarios/editar:', err);
            res.status(500).json({ error: 'Error al actualizar usuario' });
        }
    } else {
        const db = leerDBLocal();
        const idx = db.usuarios.findIndex(u => u.usuario.toLowerCase() === usuario.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

        db.usuarios[idx].clave = clave;
        db.usuarios[idx].telefono = telefono;
        db.usuarios[idx].direccion = direccion;
        db.usuarios[idx].contadorModificaciones = (db.usuarios[idx].contadorModificaciones || 0) + 1;

        guardarDBLocal(db);
        res.json({ mensaje: 'Perfil actualizado', usuario: db.usuarios[idx] });
    }
});

// API: Eliminar un usuario específico
app.delete('/api/usuarios/:usuario', async (req, res) => {
    const nombreUsuario = req.params.usuario;

    if (pool) {
        try {
            await pool.query('DELETE FROM usuarios WHERE LOWER(usuario) = LOWER($1)', [nombreUsuario]);
            res.json({ mensaje: 'Usuario eliminado' });
        } catch (err) {
            console.error('Error en DELETE /api/usuarios/:usuario:', err);
            res.status(500).json({ error: 'Error al eliminar usuario' });
        }
    } else {
        const db = leerDBLocal();
        db.usuarios = db.usuarios.filter(u => u.usuario.toLowerCase() !== nombreUsuario.toLowerCase());
        guardarDBLocal(db);
        res.json({ mensaje: 'Usuario eliminado' });
    }
});

// API: Vaciar toda la base de datos de usuarios
app.delete('/api/usuarios', async (req, res) => {
    if (pool) {
        try {
            await pool.query('TRUNCATE TABLE usuarios');
            res.json({ mensaje: 'Base de datos vaciada' });
        } catch (err) {
            console.error('Error en DELETE /api/usuarios:', err);
            res.status(500).json({ error: 'Error al vaciar la base de datos' });
        }
    } else {
        const db = leerDBLocal();
        db.usuarios = [];
        guardarDBLocal(db);
        res.json({ mensaje: 'Base de datos vaciada' });
    }
});

// Redirección de respaldo para rutas no reconocidas
app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor iniciado en puerto ${PORT}`);
});