const { z } = require('zod');

// Esquemas rigurosos de entrada con Zod
const registroSchema = z.object({
    usuario: z.string({ required_error: 'El nombre de usuario es obligatorio' })
        .trim()
        .min(2, 'El nombre de usuario debe tener al menos 2 caracteres')
        .max(50, 'El nombre de usuario no puede exceder 50 caracteres'),
    clave: z.string({ required_error: 'La contraseña es obligatoria' })
        .min(6, 'La contraseña debe contener al menos 6 caracteres'),
    correo: z.string().trim().email('Formato de correo electrónico no válido').optional().or(z.literal('')),
    telefono: z.string().trim().optional().or(z.literal('')),
    direccion: z.string().trim().optional().or(z.literal(''))
});

const loginSchema = z.object({
    usuario: z.string({ required_error: 'Ingresa tu usuario o correo' }).trim().min(1, 'Ingresa tu usuario o correo'),
    clave: z.string({ required_error: 'Ingresa tu contraseña' }).min(1, 'Ingresa tu contraseña')
});

const adminLoginSchema = z.object({
    usuario: z.string({ required_error: 'Credencial de administrador requerida' }).trim().min(1, 'Usuario admin requerido'),
    clave: z.string({ required_error: 'Contraseña requerida' }).min(1, 'Contraseña requerida')
});

const cambiarClaveSchema = z.object({
    usuario: z.string().trim().min(1, 'El nombre de usuario es requerido'),
    claveActual: z.string().min(1, 'Debes ingresar tu contraseña actual'),
    claveNueva: z.string().min(6, 'La nueva contraseña debe tener al menos 6 caracteres')
});

const recuperarSolicitarSchema = z.object({
    busqueda: z.string().trim().optional(),
    correo: z.string().trim().optional(),
    usuario: z.string().trim().optional()
}).refine(data => Boolean(data.busqueda || data.correo || data.usuario), {
    message: 'Ingresa tu nombre de usuario o correo electrónico'
});

const restablecerClaveSchema = z.object({
    usuario: z.string().trim().min(1, 'El usuario es requerido'),
    codigo: z.string().trim().min(4, 'El código OTP es requerido').optional(),
    otp: z.string().trim().min(4).optional(),
    claveNueva: z.string().min(6, 'La nueva contraseña debe tener al menos 6 caracteres').optional(),
    nuevaClave: z.string().min(6, 'La nueva contraseña debe tener al menos 6 caracteres').optional()
}).refine(data => Boolean(data.claveNueva || data.nuevaClave), {
    message: 'La nueva contraseña es requerida y debe tener al menos 6 caracteres'
});

const editarPerfilSchema = z.object({
    usuario: z.string().trim().min(1, 'Nombre de usuario requerido'),
    correo: z.string().trim().email('Formato de correo inválido').optional().or(z.literal('')),
    telefono: z.string().trim().optional().or(z.literal('')),
    direccion: z.string().trim().optional().or(z.literal(''))
});

const soporteMensajeSchema = z.object({
    usuario: z.string().trim().optional(),
    usuario_origen: z.string().trim().optional(),
    remitente: z.string().trim().optional(),
    motivo: z.string().trim().optional(),
    mensaje: z.string({ required_error: 'El mensaje es obligatorio' }).trim().min(1, 'El mensaje no puede estar vacío').max(1000, 'El mensaje no puede superar 1000 caracteres'),
    emisor: z.string().trim().optional()
}).refine(data => Boolean(data.usuario || data.usuario_origen || data.remitente), {
    message: 'El usuario remitente es requerido'
});

const soporteRespuestaSchema = z.object({
    usuario: z.string({ required_error: 'El usuario destinatario es requerido' }).trim().min(1, 'El usuario destinatario es requerido'),
    mensaje: z.string({ required_error: 'El mensaje de respuesta es requerido' }).trim().min(1, 'El mensaje de respuesta no puede estar vacío').max(1000, 'Máximo 1000 caracteres'),
    motivo: z.string().trim().optional(),
    emisor: z.string().trim().optional()
});

// Middleware factory para validar req.body
function validar(schema) {
    return (req, res, next) => {
        const resultado = schema.safeParse(req.body);
        if (!resultado.success) {
            const issues = resultado.error.issues || [];
            const mensajes = issues.map(e => e.message).join(' | ');
            return res.status(400).json({
                error: mensajes || 'Error de validación de datos',
                detalles: issues
            });
        }
        req.body = { ...req.body, ...resultado.data };
        next();
    };
}

module.exports = {
    validar,
    registroSchema,
    loginSchema,
    adminLoginSchema,
    cambiarClaveSchema,
    recuperarSolicitarSchema,
    restablecerClaveSchema,
    editarPerfilSchema,
    soporteMensajeSchema,
    soporteRespuestaSchema
};
