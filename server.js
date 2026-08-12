const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

app.use(cors());
app.use(express.json());
app.use(express.static('Public'));

// Leer base de datos local JSON
function leerDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify([]));
    }
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    } catch (e) {
        return [];
    }
}

// Guardar en la base de datos local JSON
function guardarDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Obtener todos los usuarios (para admin.html)
app.get('/api/usuarios', (req, res) => {
    res.json(leerDB());
});

// Registrar usuario
app.post('/api/usuarios/registrar', (req, res) => {
    const { usuario, clave, telefono, direccion } = req.body;
    const usuarios = leerDB();

    const yaExiste = usuarios.some(u => u.usuario.toLowerCase() === usuario.toLowerCase());
    if (yaExiste) {
        return res.status(400).json({ error: 'El usuario ya existe' });
    }

    const nuevoUsuario = {
        usuario,
        clave,
        telefono,
        direccion,
        fechaRegistro: new Date().toLocaleDateString(),
        contadorModificaciones: 0
    };

    usuarios.push(nuevoUsuario);
    guardarDB(usuarios);
    res.json({ mensaje: 'Usuario registrado con éxito', usuario: nuevoUsuario });
});

// Iniciar sesión
app.post('/api/usuarios/login', (req, res) => {
    const { usuario, clave } = req.body;
    const usuarios = leerDB();
    const encontrado = usuarios.find(u => u.usuario === usuario && u.clave === clave);

    if (encontrado) {
        res.json(encontrado);
    } else {
        res.status(401).json({ error: 'Credenciales incorrectas' });
    }
});

// Editar perfil de usuario
app.put('/api/usuarios/editar', (req, res) => {
    const { usuario, clave, telefono, direccion } = req.body;
    let usuarios = leerDB();

    const idx = usuarios.findIndex(u => u.usuario.toLowerCase() === usuario.toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });

    usuarios[idx].clave = clave;
    usuarios[idx].telefono = telefono;
    usuarios[idx].direccion = direccion;
    usuarios[idx].contadorModificaciones = (usuarios[idx].contadorModificaciones || 0) + 1;

    guardarDB(usuarios);
    res.json({ mensaje: 'Perfil actualizado', usuario: usuarios[idx] });
});

// Eliminar un usuario específico
app.delete('/api/usuarios/:usuario', (req, res) => {
    const nombreUsuario = req.params.usuario;
    let usuarios = leerDB();
    usuarios = usuarios.filter(u => u.usuario.toLowerCase() !== nombreUsuario.toLowerCase());
    guardarDB(usuarios);
    res.json({ mensaje: 'Usuario eliminado' });
});

// Vaciar toda la base de datos
app.delete('/api/usuarios', (req, res) => {
    guardarDB([]);
    res.json({ mensaje: 'Base de datos vaciada' });
});

app.listen(PORT, () => {
    console.log(`Servidor iniciado en puerto ${PORT}`);
});