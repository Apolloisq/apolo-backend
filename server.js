require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Configuramos la conexión con Google
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// 2. Configuramos la conexión con tu caja fuerte en Supabase
const supabaseUrl = process.env.SUPABASE_URL || 'https://tu-proyecto.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'tu_supabase_key';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.warn("⚠️ Advertencia: Configura SUPABASE_URL y SUPABASE_KEY en las variables de entorno de Render.");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// RUTA 1: Cuando desde el panel le dan a "+ Agregar"
app.get('/conectar-gmail', (req, res) => {
  const { email, nombre } = req.query; 
  const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', // ¡Esto es vital para que Google nos dé la llave permanente!
    prompt: 'consent',
    scope: scopes,
    login_hint: email, 
    state: JSON.stringify({ email, nombre })
  });

  res.redirect(url);
});

// RUTA 2: A donde Google nos devuelve y GUARDAMOS EN SUPABASE
app.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  const state = JSON.parse(req.query.state || '{}');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log(`¡Éxito! Llave capturada para: ${state.email}`);

    // Solo guardamos si Google nos envió la llave permanente (refresh_token)
    if (tokens.refresh_token) {
      const { data, error } = await supabase
        .from('clientes')
        .upsert([
          { 
            email: state.email, 
            nombre: state.nombre, 
            refresh_token: tokens.refresh_token 
          }
        ], { onConflict: 'email' }); // Si el correo ya existe, solo actualiza la llave

      if (error) throw error;
      console.log("✅ ¡Datos guardados exitosamente en Supabase!");
    } else {
      console.log("⚠️ No se recibió llave nueva. (El usuario ya la había generado antes).");
    }

    res.send("<h1>Cuenta vinculada con éxito. Ya puedes cerrar esta ventana y volver a tu panel.</h1>");
  } catch (error) {
    console.error("Error en el proceso:", error);
    res.status(500).send("Error en la vinculación.");
  }
});
// RUTA 0: Health check para Render y monitoreo
app.get('/', (req, res) => {
  res.json({ status: 'ok', server: 'Servidor Apolo 24/7', version: '1.1.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// RUTA 3: Para que tu panel HTML pida la lista de clientes
app.get('/api/clientes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clientes')
      .select('id, email, nombre, creado_en')
      .order('creado_en', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error("Error al obtener los clientes:", error);
    res.status(500).json({ error: "Error al cargar la base de datos" });
  }
});

// RUTA 3B: Eliminar un cliente de la base de datos
app.delete('/api/clientes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('clientes')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ exito: true, mensaje: "Cliente eliminado correctamente." });
  } catch (error) {
    console.error("Error al eliminar el cliente:", error);
    res.status(500).json({ exito: false, mensaje: "Error al eliminar de la base de datos." });
  }
});

// RUTA 4: Validar y "quemar" la llave de acceso de 1 solo uso
app.post('/api/validar-llave', async (req, res) => {
  const { llave } = req.body;
  try {
    const { data: llaveData, error: buscarError } = await supabase
      .from('llaves_acceso')
      .select('*')
      .eq('codigo', llave)
      .single(); 

    if (buscarError || !llaveData) {
      return res.status(401).json({ exito: false, mensaje: "Llave incorrecta o no existe." });
    }
    if (llaveData.usada) {
      return res.status(401).json({ exito: false, mensaje: "Esta llave ya fue utilizada." });
    }
    const { error: actualizarError } = await supabase
      .from('llaves_acceso')
      .update({ usada: true })
      .eq('id', llaveData.id);

    if (actualizarError) throw actualizarError;
    res.json({ exito: true, mensaje: "Acceso concedido." });

  } catch (error) {
    console.error("Error al validar la llave:", error);
    res.status(500).json({ exito: false, mensaje: "Error interno." });
  }
});

// Función auxiliar para extraer código, enlace y remitente limpio
function procesarCorreo(msgId, mailInfo) {
  const headers = mailInfo.data.payload.headers || [];
  const asunto = headers.find(h => h.name && h.name.toLowerCase() === 'subject')?.value || 'Sin Asunto';
  const remitenteRaw = headers.find(h => h.name && h.name.toLowerCase() === 'from')?.value || 'Desconocido';
  const fechaRaw = headers.find(h => h.name && h.name.toLowerCase() === 'date')?.value || '';
  const snippet = mailInfo.data.snippet || '';

  // Limpiar remitente
  let remitente = remitenteRaw;
  const matchRemitente = remitenteRaw.match(/^(.*?)(?:<|$)/);
  if (matchRemitente && matchRemitente[1].trim()) {
    remitente = matchRemitente[1].replace(/["']/g, '').trim();
  }

  // Identificar servicio
  let servicio = 'General';
  if (/netflix/i.test(remitenteRaw) || /netflix/i.test(asunto) || /netflix/i.test(snippet)) {
    servicio = 'Netflix';
  } else if (/disney/i.test(remitenteRaw) || /disney/i.test(asunto) || /disney/i.test(snippet)) {
    servicio = 'Disney+';
  }

  // Extraer código numérico de verificación (4 a 8 dígitos)
  let codigo = null;
  const matchKeyword = snippet.match(/(?:código|codigo|code|pin|clave)[\s:a-záéíóú]*([0-9]{4,8})\b/i);
  if (matchKeyword) {
    codigo = matchKeyword[1];
  } else {
    const match6 = snippet.match(/\b([0-9]{6})\b/);
    if (match6) {
      codigo = match6[1];
    } else {
      const matchGeneral = snippet.match(/\b([0-9]{4,8})\b/);
      if (matchGeneral) codigo = matchGeneral[1];
    }
  }

  // Extraer posible enlace de restablecimiento o confirmación
  let enlace = null;
  const matchUrl = snippet.match(/(https?:\/\/[^\s"'<>]+)/i);
  if (matchUrl) enlace = matchUrl[1];

  return {
    id: msgId,
    asunto,
    remitente,
    servicio,
    fecha: fechaRaw,
    resumen: snippet,
    codigo,
    enlace
  };
}

// RUTA 5: Lector de Gmail (Para tu 2da página de clientes)
app.post('/api/leer-correos', async (req, res) => {
  const { email, filtros } = req.body;
  const safeFiltros = Array.isArray(filtros) ? filtros : [true, true, true, false];

  try {
    const { data: cliente, error } = await supabase
      .from('clientes')
      .select('refresh_token')
      .eq('email', email)
      .single();

    if (error || !cliente) return res.status(404).json({ exito: false, mensaje: "Correo no encontrado en la base de datos." });

    oauth2Client.setCredentials({ refresh_token: cliente.refresh_token });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    let query = "";
    if (safeFiltros[3]) {
      query = "from:netflix OR from:disney";
    } else {
      let condiciones = [];
      if (safeFiltros[0]) condiciones.push('("Reset password" OR "restablecimiento de contraseña" OR "Restablece tu contraseña" OR "Reset your password")');
      if (safeFiltros[1]) condiciones.push('("Tu codigo de acceso unico" OR "Ingresá este código para continuar" OR "Usa este código para ver Netflix")');
      if (safeFiltros[2]) condiciones.push('("¿Viajas con frecuencia a la misma ubicación?" OR "acceso temporal")');
      if (condiciones.length === 0) return res.json({ exito: true, correos: [] });
      query = condiciones.join(" OR ");
    }

    const response = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 5 });
    const mensajes = response.data.messages || [];
    let resultados = [];

    for (let msg of mensajes) {
      const mailInfo = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      resultados.push(procesarCorreo(msg.id, mailInfo));
    }
    res.json({ exito: true, correos: resultados });

  } catch (error) {
    console.error("Error al leer correos:", error);
    res.status(500).json({ exito: false, mensaje: "Error al conectar con Gmail." });
  }
});

// Encendemos el motor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Apolo conectado y corriendo en http://localhost:${PORT}`);
});