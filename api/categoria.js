// GET /api/categoria?modo=predecir&q=titulo        -> sugiere categoría
// GET /api/categoria?modo=info&category_id=MLA...  -> límites y atributos obligatorios

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
  const { modo, q, category_id } = req.query;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authRow } = await supabase.from('ml_auth').select('*').order('updated_at', { ascending: false }).limit(1).single();
  if (!authRow) return res.status(400).json({ error: 'No hay cuenta de ML conectada' });

  try {
    const accessToken = await refreshTokenIfNeeded(supabase, authRow);

    if (modo === 'predecir') {
      if (!q) return res.status(400).json({ error: 'Falta el título (q)' });
      const resp = await fetch(`https://api.mercadolibre.com/sites/MLA/domain_discovery/search?limit=5&q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json({ error: 'No se pudo predecir la categoría', detail: data });
      return res.status(200).json({ ok: true, predicciones: data });
    }

    if (modo === 'info') {
      if (!category_id) return res.status(400).json({ error: 'Falta category_id' });
      const [respCat, respAttrs] = await Promise.all([
        fetch(`https://api.mercadolibre.com/categories/${category_id}`, { headers: { Authorization: `Bearer ${accessToken}` } }),
        fetch(`https://api.mercadolibre.com/categories/${category_id}/attributes`, { headers: { Authorization: `Bearer ${accessToken}` } }),
      ]);
      const dataCat = await respCat.json();
      const dataAttrs = await respAttrs.json();
      if (!respCat.ok) return res.status(respCat.status).json({ error: 'No se pudo consultar la categoría', detail: dataCat });

      const obligatorios = (Array.isArray(dataAttrs) ? dataAttrs : [])
        .filter(a => (a.tags?.required) === true)
        .map(a => ({
          id: a.id, nombre: a.name, tipo: a.value_type,
          valores: a.value_type === 'list' ? (a.values || []).map(v => ({ id: v.id, nombre: v.name })) : null,
        }));

      return res.status(200).json({
        ok: true, nombre: dataCat.name,
        monedas: dataCat.settings?.currencies || ['ARS'],
        condiciones: dataCat.settings?.item_conditions || ['new'],
        max_fotos: dataCat.settings?.max_pictures_per_item || 6,
        precio_minimo: dataCat.settings?.minimum_price || null,
        max_titulo: dataCat.settings?.max_title_length || 60,
        atributos_obligatorios: obligatorios,
      });
    }

    return res.status(400).json({ error: 'Falta el parámetro modo (predecir o info)' });
  } catch (err) {
    res.status(500).json({ error: 'Error inesperado', detail: String(err) });
  }
}
