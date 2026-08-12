const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de la conexión a PostgreSQL con SSL para Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Detectar la carpeta Public/public dinámicamente
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'Public'))
    ? path.join(__dirname, 'Public')
    : path.join(__dirname, 'public');

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Inicialización automática de la tabla de usuarios en PostgreSQL
async function initDB() {
    if (!process.env.DATABASE_URL) {
        console.warn("⚠️ DATABASE_URL no está definida. Configúrala en Render.");
        return;
    }
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY,
            usuario VARCHAR(100) UNIQUE NOT NULL,
            clave VARCHAR(255) NOT NULL,
            telefono VARCHAR(100),
            direccion TEXT,
            fecha_registro VARCHAR(50),
            contador_modificaciones INT DEFAULT 0
        );
    `;
    try {
        await pool.query(createTableQuery);
        console.log("✅ Conexión exitosa y tabla 'usuarios' lista en PostgreSQL.");
    } catch (err) {
        console.error("❌ Error al conectar o crear tabla en PostgreSQL:", err);
    }
}
initDB();

// Ruta raíz principal
app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Ruta dedicada para el panel de administración
app.get(['/admin', '/admin.html'], (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// API: Obtener todos los usuarios
app.get('/api/usuarios', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT usuario, clave, telefono, direccion, fecha_registro AS "fechaRegistro", contador_modificaciones AS "contadorModificaciones" FROM usuarios ORDER BY id ASC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Error al obtener usuarios:", err);
        res.status(500).json({ error: "Error en la base de datos" });
    }
});

// API: Registrar usuario
app.post('/api/usuarios/registrar', async (req, res) => {
    const { usuario, clave, telefono, direccion } = req.body;
    if (!usuario || !clave) {
        return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
    }

    try {
        const checkUser = await pool.query('SELECT id FROM usuarios WHERE LOWER(usuario) = LOWER($1)', [usuario]);
        if (checkUser.rows.length > 0) {
            return res.status(400).json({ error: 'El usuario ya existe' });
        }

        const fechaRegistro = new Date().toLocaleDateString();
        const insertQuery = `
            INSERT INTO usuarios (usuario, clave, telefono, direccion, fecha_registro, contador_modificaciones)
            VALUES ($1, $2, $3, $4, $5, 0)
            RETURNING usuario, clave, telefono, direccion, fecha_registro AS "fechaRegistro", contador_modificaciones AS "contadorModificaciones";
        `;
        const result = await pool.query(insertQuery, [usuario, clave, telefono, direccion, fechaRegistro]);
        res.json({ mensaje: 'Usuario registrado con éxito', usuario: result.rows[0] });
    } catch (err) {
        console.error("Error al registrar usuario:", err);
        res.status(500).json({ error: 'Error al registrar usuario en la base de datos' });
    }
});

// API: Iniciar sesión
app.post('/api/usuarios/login', async (req, res) => {
    const { usuario, clave } = req.body;
    try {
        const result = await pool.query(
            'SELECT usuario, clave, telefono, direccion, fecha_registro AS "fechaRegistro", contador_modificaciones AS "contadorModificaciones" FROM usuarios WHERE usuario = $1 AND clave = $2',
            [usuario, clave]
        );

        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(401).json({ error: 'Credenciales incorrectas' });
        }
    } catch (err) {
        console.error("Error en login:", err);
        res.status(500).json({ error: 'Error en la base de datos' });
    }
});

// API: Editar perfil de usuario
app.put('/api/usuarios/editar', async (req, res) => {
    const { usuario, clave, telefono, direccion } = req.body;
    try {
        const updateQuery = `
            UPDATE usuarios
            SET clave = $1, telefono = $2, direccion = $3, contador_modificaciones = COALESCE(contador_modificaciones, 0) + 1
            WHERE LOWER(usuario) = LOWER($4)
            RETURNING usuario, clave, telefono, direccion, fecha_registro AS "fechaRegistro", contador_modificaciones AS "contadorModificaciones";
        `;
        const result = await pool.query(updateQuery, [clave, telefono, direccion, usuario]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({ mensaje: 'Perfil actualizado', usuario: result.rows[0] });
    } catch (err) {
        console.error("Error al editar perfil:", err);
        res.status(500).json({ error: 'Error en la base de datos' });
    }
});

// API: Eliminar un usuario específico
app.delete('/api/usuarios/:usuario', async (req, res) => {
    const nombreUsuario = req.params.usuario;
    try {
        await pool.query('DELETE FROM usuarios WHERE LOWER(usuario) = LOWER($1)', [nombreUsuario]);
        res.json({ mensaje: 'Usuario eliminado' });
    } catch (err) {
        console.error("Error al eliminar usuario:", err);
        res.status(500).json({ error: 'Error en la base de datos' });
    }
});

// API: Vaciar toda la base de datos
app.delete('/api/usuarios', async (req, res) => {
    try {
        await pool.query('TRUNCATE TABLE usuarios');
        res.json({ mensaje: 'Base de datos vaciada' });
    } catch (err) {
        console.error("Error al vaciar base de datos:", err);
        res.status(500).json({ error: 'Error en la base de datos' });
    }
});

// Redirección de respaldo para rutas no reconocidas
app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor iniciado en puerto ${PORT}`);
});