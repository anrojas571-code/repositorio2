const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

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

    // Crear tabla si no existe automáticamente
    const initDb = async () => {
        try {
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
            console.log('Tabla "usuarios" lista en PostgreSQL');
        } catch (err) {
            console.error('Error al inicializar la tabla PostgreSQL:', err);
        }
    };
    initDb();
} else {
    console.log('DATABASE_URL no definida. Modo fallback a db.json local');
}

// Ruta dinámica para la carpeta Public (compatible con Linux/Render)
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
        fs.writeFileSync(DB_FILE, JSON.stringify([]));
    }
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    } catch (e) {
        return [];
    }
}

function guardarDBLocal(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- API ENDPOINTS (COMPATIBLES CON POSTGRES Y JSON) ---

// API: Obtener todos los usuarios
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
        res.json(leerDBLocal());
    }
});

// API: Registrar usuario
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
        const usuarios = leerDBLocal();
        const yaExiste = usuarios.some(u => u.usuario.toLowerCase() === usuario.toLowerCase());
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

        usuarios.push(nuevoUsuario);
        guardarDBLocal(usuarios);
        res.json({ mensaje: 'Usuario registrado con éxito', usuario: nuevoUsuario });
    }
});

// API: Iniciar sesión
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
        const usuarios = leerDBLocal();
        const encontrado = usuarios.find(u => u.usuario === usuario && u.clave === clave);

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
        let usuarios = leerDBLocal();
        const idx = usuarios.findIndex(u => u.usuario.toLowerCase() === usuario.toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

        usuarios[idx].clave = clave;
        usuarios[idx].telefono = telefono;
        usuarios[idx].direccion = direccion;
        usuarios[idx].contadorModificaciones = (usuarios[idx].contadorModificaciones || 0) + 1;

        guardarDBLocal(usuarios);
        res.json({ mensaje: 'Perfil actualizado', usuario: usuarios[idx] });
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
        let usuarios = leerDBLocal();
        usuarios = usuarios.filter(u => u.usuario.toLowerCase() !== nombreUsuario.toLowerCase());
        guardarDBLocal(usuarios);
        res.json({ mensaje: 'Usuario eliminado' });
    }
});

// API: Vaciar toda la base de datos
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
        guardarDBLocal([]);
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