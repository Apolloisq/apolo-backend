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
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

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
// RUTA 3: Para que tu panel HTML pida la lista de clientes
app.get('/api/clientes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clientes')
      .select('id, email, nombre, creado_en');

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error("Error al obtener los clientes:", error);
    res.status(500).json({ error: "Error al cargar la base de datos" });
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

// RUTA 5: Lector de Gmail (Para tu 2da página de clientes)
app.post('/api/leer-correos', async (req, res) => {
  const { email, filtros } = req.body; 
  try {
    const { data: cliente, error } = await supabase
      .from('clientes')
      .select('refresh_token')
      .eq('email', email)
      .single();

    if (error || !cliente) return res.status(404).json({ exito: false, mensaje: "Correo no encontrado." });

    oauth2Client.setCredentials({ refresh_token: cliente.refresh_token });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    let query = "";
    if (filtros[3]) {
      query = "from:netflix OR from:disney";
    } else {
      let condiciones = [];
      if (filtros[0]) condiciones.push('("Reset password" OR "restablecimiento de contraseña" OR "Restablece tu contraseña" OR "Reset your password")');
      if (filtros[1]) condiciones.push('("Tu codigo de acceso unico" OR "Ingresá este código para continuar" OR "Usa este código para ver Netflix")');
      if (filtros[2]) condiciones.push('("¿Viajas con frecuencia a la misma ubicación?" OR "acceso temporal")');
      if (condiciones.length === 0) return res.json({ exito: true, correos: [] });
      query = condiciones.join(" OR ");
    }

    const response = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 3 });
    const mensajes = response.data.messages || [];
    let resultados = [];

    for (let msg of mensajes) {
      const mailInfo = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = mailInfo.data.payload.headers;
      const asunto = headers.find(h => h.name === 'Subject')?.value || 'Sin Asunto';
      resultados.push({ id: msg.id, asunto: asunto, resumen: mailInfo.data.snippet });
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