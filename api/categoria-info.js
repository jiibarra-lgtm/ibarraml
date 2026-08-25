// GET /api/categoria-info?category_id=MLA...
// Trae los límites y condiciones aceptadas de una categoría (moneda,
// stock mínimo, si acepta "usado", máximo de fotos, etc.)

import { createClient } from '@supabase/supabase-js';

async function refreshTokenIfNeeded(supabase, auth) {
  const expiresAt = new Date(auth.expires_at).getTime();
  if (Date.now() < expiresAt - 60_000) return auth.access_token;
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: auth.refresh_token,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('No se pudo refrescar el token');
  await supabase.from('ml_auth').update({
    access_token: data.access_token, refresh_token: data.refresh_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(), updated_at: new Date().toISOString(),
  }).eq('user_id', auth.user_id);
  return data.access_token;
}

export default async function handler(req, res) {
  const { category_id } = req.query;
  if (!category_id) return res.status(400).json({ error: 'Falta category_id' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authRow } = await supabase.from('ml_auth').select('*').order('updated_at', { ascending: false }).limit(1).single();
  if (!authRow) return res.status(400).json({ error: 'No hay cuenta de ML conectada' });

  try {
    const accessToken = await refreshTokenIfNeeded(supabase, authRow);
    const resp = await fetch(`https://api.mercadolibre.com/categories/${category_id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: 'No se pudo consultar la categoría', detail: data });
    res.status(200).json({
      ok: true,
      nombre: data.name,
      monedas: data.settings?.currencies || ['ARS'],
      condiciones: data.settings?.item_conditions || ['new'],
      max_fotos: data.settings?.max_pictures_per_item || 6,
      precio_minimo: data.settings?.minimum_price || null,
      requiere_stock: data.settings?.stock === 'required',
      max_titulo: data.settings?.max_title_length || 60,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error inesperado', detail: String(err) });
  }
}
