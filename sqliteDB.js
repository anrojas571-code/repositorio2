const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SQLITE_FILE = path.join(__dirname, 'database.sqlite');
const PRIMARY_JSON_FILE = path.join(__dirname, 'database.json');
const LEGACY_JSON_FILE = path.join(__dirname, 'db.json');

// Inicializar conexión a SQLite
const db = new Database(SQLITE_FILE);

// Activar WAL (Write-Ahead Logging) para máxima concurrencia y velocidad
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// 1. Crear tablas si no existen
db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT UNIQUE NOT NULL COLLATE NOCASE,
    clave TEXT NOT NULL,
    correo TEXT COLLATE NOCASE,
    telefono TEXT,
    direccion TEXT,
    fechaRegistro TEXT,
    contadorModificaciones INTEGER DEFAULT 0,
    rol TEXT DEFAULT 'Cliente',
    estado TEXT DEFAULT 'Activo',
    historialEdiciones TEXT DEFAULT '[]',
    codigoRecuperacion TEXT,
    codigoExpiracion INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usuarios_usuario ON usuarios(usuario);
CREATE INDEX IF NOT EXISTS idx_usuarios_correo ON usuarios(correo);

CREATE TABLE IF NOT EXISTS administradores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT UNIQUE NOT NULL COLLATE NOCASE,
    clave TEXT NOT NULL,
    nombre TEXT,
    correo TEXT
);
CREATE INDEX IF NOT EXISTS idx_admins_usuario ON administradores(usuario);

CREATE TABLE IF NOT EXISTS descargas (
    id INTEGER PRIMARY KEY,
    formato TEXT,
    fecha TEXT,
    hora TEXT
);

CREATE TABLE IF NOT EXISTS soporte (
    id TEXT PRIMARY KEY,
    usuario TEXT NOT NULL,
    mensaje TEXT NOT NULL,
    respuesta TEXT DEFAULT '',
    fecha TEXT,
    hora TEXT,
    respondido INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_soporte_usuario ON soporte(usuario);

CREATE TABLE IF NOT EXISTS auditoria (
    id TEXT PRIMARY KEY,
    fecha TEXT,
    hora TEXT,
    tipo TEXT,
    usuario TEXT,
    detalle TEXT,
    ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_auditoria_id ON auditoria(id);
`);

// 2. Migración inicial automática desde database.json si SQLite está vacía
function migrarDesdeJSONSiAplica() {
    const totalUsuarios = db.prepare('SELECT COUNT(*) as count FROM usuarios').get().count;
    if (totalUsuarios === 0 && fs.existsSync(PRIMARY_JSON_FILE)) {
        try {
            const raw = fs.readFileSync(PRIMARY_JSON_FILE, 'utf-8');
            const data = JSON.parse(raw);
            console.log('🔄 [MIGRACIÓN SQLite] Migrando datos desde database.json a database.sqlite...');

            const insertUsuario = db.prepare(`
                INSERT OR REPLACE INTO usuarios 
                (usuario, clave, correo, telefono, direccion, fechaRegistro, contadorModificaciones, rol, estado, historialEdiciones, codigoRecuperacion, codigoExpiracion)
                VALUES (@usuario, @clave, @correo, @telefono, @direccion, @fechaRegistro, @contadorModificaciones, @rol, @estado, @historialEdiciones, @codigoRecuperacion, @codigoExpiracion)
            `);

            const insertAdmin = db.prepare(`
                INSERT OR REPLACE INTO administradores (usuario, clave, nombre, correo)
                VALUES (@usuario, @clave, @nombre, @correo)
            `);

            const insertDescarga = db.prepare(`
                INSERT OR REPLACE INTO descargas (id, formato, fecha, hora)
                VALUES (@id, @formato, @fecha, @hora)
            `);

            const insertSoporte = db.prepare(`
                INSERT OR REPLACE INTO soporte (id, usuario, mensaje, respuesta, fecha, hora, respondido)
                VALUES (@id, @usuario, @mensaje, @respuesta, @fecha, @hora, @respondido)
            `);

            const insertAuditoria = db.prepare(`
                INSERT OR REPLACE INTO auditoria (id, fecha, hora, tipo, usuario, detalle, ip)
                VALUES (@id, @fecha, @hora, @tipo, @usuario, @detalle, @ip)
            `);

            const transaccion = db.transaction(() => {
                if (Array.isArray(data.usuarios)) {
                    for (const u of data.usuarios) {
                        insertUsuario.run({
                            usuario: u.usuario || '',
                            clave: u.clave || '',
                            correo: u.correo || '',
                            telefono: u.telefono || '',
                            direccion: u.direccion || '',
                            fechaRegistro: u.fechaRegistro || '',
                            contadorModificaciones: u.contadorModificaciones || 0,
                            rol: u.rol || 'Cliente',
                            estado: u.estado || 'Activo',
                            historialEdiciones: typeof u.historialEdiciones === 'string' ? u.historialEdiciones : JSON.stringify(u.historialEdiciones || []),
                            codigoRecuperacion: u.codigoRecuperacion || null,
                            codigoExpiracion: u.codigoExpiracion || null
                        });
                    }
                }

                if (Array.isArray(data.administradores)) {
                    for (const a of data.administradores) {
                        insertAdmin.run({
                            usuario: a.usuario || '',
                            clave: a.clave || '',
                            nombre: a.nombre || a.usuario || '',
                            correo: a.correo || ''
                        });
                    }
                }

                if (Array.isArray(data.descargas)) {
                    for (const d of data.descargas) {
                        insertDescarga.run({
                            id: d.id,
                            formato: d.formato || '',
                            fecha: d.fecha || '',
                            hora: d.hora || ''
                        });
                    }
                }

                if (Array.isArray(data.soporte)) {
                    for (const s of data.soporte) {
                        insertSoporte.run({
                            id: String(s.id),
                            usuario: s.usuario || '',
                            mensaje: s.mensaje || '',
                            respuesta: s.respuesta || '',
                            fecha: s.fecha || '',
                            hora: s.hora || '',
                            respondido: s.respondido ? 1 : 0
                        });
                    }
                }

                if (Array.isArray(data.auditoria)) {
                    for (const ev of data.auditoria) {
                        insertAuditoria.run({
                            id: String(ev.id),
                            fecha: ev.fecha || '',
                            hora: ev.hora || '',
                            tipo: ev.tipo || 'GENERAL',
                            usuario: ev.usuario || 'Sistema',
                            detalle: ev.detalle || '',
                            ip: ev.ip || '127.0.0.1'
                        });
                    }
                }
            });

            transaccion();
            console.log('✅ [MIGRACIÓN SQLite] Migración a base de datos relacional SQLite completada exitosamente.');
        } catch (err) {
            console.error('❌ [ERROR MIGRACIÓN SQLite]:', err.message);
        }
    }
}

migrarDesdeJSONSiAplica();

// 3. Lectura reactiva desde SQLite (con parse de JSON en historial)
function leerDBDesdeSQLite() {
    const usuariosRaw = db.prepare('SELECT * FROM usuarios ORDER BY id ASC').all();
    const usuarios = usuariosRaw.map(u => {
        let historial = [];
        try {
            historial = JSON.parse(u.historialEdiciones || '[]');
        } catch (e) {
            historial = [];
        }
        return {
            ...u,
            historialEdiciones: historial
        };
    });

    const administradores = db.prepare('SELECT * FROM administradores ORDER BY id ASC').all();
    const descargas = db.prepare('SELECT * FROM descargas ORDER BY id DESC').all();
    const soporte = db.prepare('SELECT * FROM soporte ORDER BY CAST(id AS INTEGER) ASC').all().map(s => ({
        ...s,
        respondido: Boolean(s.respondido)
    }));
    const auditoria = db.prepare('SELECT * FROM auditoria ORDER BY rowid DESC LIMIT 1000').all();

    return {
        usuarios,
        administradores,
        descargas,
        soporte,
        auditoria
    };
}

// 4. Guardado transaccional y sincronización espejo con SQLite y JSON
function guardarDBEnSQLite(data) {
    const insertOrReplaceUsuario = db.prepare(`
        INSERT INTO usuarios (usuario, clave, correo, telefono, direccion, fechaRegistro, contadorModificaciones, rol, estado, historialEdiciones, codigoRecuperacion, codigoExpiracion)
        VALUES (@usuario, @clave, @correo, @telefono, @direccion, @fechaRegistro, @contadorModificaciones, @rol, @estado, @historialEdiciones, @codigoRecuperacion, @codigoExpiracion)
    `);

    const insertOrReplaceAdmin = db.prepare(`
        INSERT INTO administradores (usuario, clave, nombre, correo)
        VALUES (@usuario, @clave, @nombre, @correo)
    `);

    const insertDescarga = db.prepare(`
        INSERT INTO descargas (id, formato, fecha, hora)
        VALUES (@id, @formato, @fecha, @hora)
    `);

    const insertSoporte = db.prepare(`
        INSERT INTO soporte (id, usuario, mensaje, respuesta, fecha, hora, respondido)
        VALUES (@id, @usuario, @mensaje, @respuesta, @fecha, @hora, @respondido)
    `);

    const insertAuditoria = db.prepare(`
        INSERT INTO auditoria (id, fecha, hora, tipo, usuario, detalle, ip)
        VALUES (@id, @fecha, @hora, @tipo, @usuario, @detalle, @ip)
    `);

    const transaccion = db.transaction(() => {
        db.exec('DELETE FROM usuarios;');
        if (Array.isArray(data.usuarios)) {
            for (const u of data.usuarios) {
                insertOrReplaceUsuario.run({
                    usuario: u.usuario || '',
                    clave: u.clave || '',
                    correo: u.correo || '',
                    telefono: u.telefono || '',
                    direccion: u.direccion || '',
                    fechaRegistro: u.fechaRegistro || '',
                    contadorModificaciones: u.contadorModificaciones || 0,
                    rol: u.rol || 'Cliente',
                    estado: u.estado || 'Activo',
                    historialEdiciones: typeof u.historialEdiciones === 'string' ? u.historialEdiciones : JSON.stringify(u.historialEdiciones || []),
                    codigoRecuperacion: u.codigoRecuperacion || null,
                    codigoExpiracion: u.codigoExpiracion || null
                });
            }
        }

        db.exec('DELETE FROM administradores;');
        if (Array.isArray(data.administradores)) {
            for (const a of data.administradores) {
                insertOrReplaceAdmin.run({
                    usuario: a.usuario || '',
                    clave: a.clave || '',
                    nombre: a.nombre || a.usuario || '',
                    correo: a.correo || ''
                });
            }
        }

        db.exec('DELETE FROM descargas;');
        if (Array.isArray(data.descargas)) {
            for (const d of data.descargas) {
                insertDescarga.run({
                    id: d.id,
                    formato: d.formato || '',
                    fecha: d.fecha || '',
                    hora: d.hora || ''
                });
            }
        }

        db.exec('DELETE FROM soporte;');
        if (Array.isArray(data.soporte)) {
            for (const s of data.soporte) {
                insertSoporte.run({
                    id: String(s.id),
                    usuario: s.usuario || '',
                    mensaje: s.mensaje || '',
                    respuesta: s.respuesta || '',
                    fecha: s.fecha || '',
                    hora: s.hora || '',
                    respondido: s.respondido ? 1 : 0
                });
            }
        }

        db.exec('DELETE FROM auditoria;');
        if (Array.isArray(data.auditoria)) {
            for (const ev of data.auditoria) {
                insertAuditoria.run({
                    id: String(ev.id),
                    fecha: ev.fecha || '',
                    hora: ev.hora || '',
                    tipo: ev.tipo || 'GENERAL',
                    usuario: ev.usuario || 'Sistema',
                    detalle: ev.detalle || '',
                    ip: ev.ip || '127.0.0.1'
                });
            }
        }
    });

    transaccion();

    // Guardar copia espejo en database.json para mantener compatibilidad y respaldos
    try {
        const jsonStr = JSON.stringify(data, null, 2);
        fs.writeFileSync(PRIMARY_JSON_FILE, jsonStr, 'utf-8');
        fs.writeFileSync(LEGACY_JSON_FILE, jsonStr, 'utf-8');
    } catch (e) {
        // Silencioso
    }
}

module.exports = {
    dbSqlite: db,
    leerDBDesdeSQLite,
    guardarDBEnSQLite
};
