// GET /api/callback?code=...
// Mercado Libre vuelve acá después del login. Cambiamos el "code" por
// un access_token + refresh_token y los guardamos en Supabase (tabla ml_auth).
//
// Variables de entorno necesarias en Vercel:
//   ML_CLIENT_ID, ML_CLIENT_SECRET, ML_REDIRECT_URI
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const { code } = req.query;
  if (!code) return res.status(400).send('Falta el parámetro code.');

  try {
    const tokenResp = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.ML_CLIENT_ID,
        client_secret: process.env.ML_CLIENT_SECRET,
        code,
        redirect_uri: process.env.ML_REDIRECT_URI,
      }),
    });

    const tokenData = await tokenResp.json();

    if (!tokenResp.ok) {
      console.error('Error de ML al pedir token:', tokenData);
      return res.status(400).json({ error: 'No se pudo obtener el token', detail: tokenData });
    }

    // tokenData incluye: access_token, refresh_token, user_id, expires_in
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { error } = await supabase.from('ml_auth').upsert({
      user_id: tokenData.user_id,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    if (error) {
      console.error('Error guardando en Supabase:', error);
      return res.status(500).json({ error: 'No se pudo guardar el token', detail: error });
    }

    // Redirigimos al home ya conectado
    res.writeHead(302, { Location: '/?conectado=1' });
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error inesperado', detail: String(err) });
  }
}
