// GET /api/publicaciones                -> trae todas tus publicaciones reales de ML
// PUT /api/publicaciones  { item_id, precio?, stock?, status? } -> edita una

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
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authRow } = await supabase.from('ml_auth').select('*').order('updated_at', { ascending: false }).limit(1).single();
  if (!authRow) return res.status(400).json({ error: 'No hay cuenta de ML conectada' });

  try {
    const accessToken = await refreshTokenIfNeeded(supabase, authRow);

    if (req.method === 'PUT' || req.method === 'POST') {
      const { item_id, precio, stock, status } = req.body || {};
      if (!item_id) return res.status(400).json({ error: 'Falta item_id' });
      const cambios = {};
      if (precio !== undefined && precio !== null) cambios.price = Number(precio);
      if (stock !== undefined && stock !== null) cambios.available_quantity = Number(stock);
      if (status) cambios.status = status;
      if (Object.keys(cambios).length === 0) return res.status(400).json({ error: 'No hay nada para actualizar' });

      const resp = await fetch(`https://api.mercadolibre.com/items/${item_id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cambios),
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json({ error: 'ML rechazó el cambio', detail: data });

      await supabase.from('mis_publicaciones').update({
        precio: data.price, stock: data.available_quantity, status: data.status, updated_at: new Date().toISOString(),
      }).eq('item_id', item_id);

      return res.status(200).json({ ok: true, item: data });
    }

    // GET: sincronizar todas las publicaciones reales
    const respIds = await fetch(`https://api.mercadolibre.com/users/${authRow.user_id}/items/search?limit=100`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const dataIds = await respIds.json();
    if (!respIds.ok) return res.status(respIds.status).json({ error: 'No se pudieron traer tus publicaciones', detail: dataIds });

    const ids = dataIds.results || [];
    let guardadas = 0;
    for (const itemId of ids) {
      const respItem = await fetch(`https://api.mercadolibre.com/items/${itemId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!respItem.ok) continue;
      const item = await respItem.json();
      const { error } = await supabase.from('mis_publicaciones').upsert({
        item_id: item.id, titulo: item.title, category_id: item.category_id, precio: item.price,
        moneda: item.currency_id, stock: item.available_quantity, condicion: item.condition,
        fotos: (item.pictures || []).map(p => p.secure_url || p.url), permalink: item.permalink,
        status: item.status, sold_quantity: item.sold_quantity || 0, attributes: item.attributes || [],
        sincronizado_desde_ml: true, updated_at: new Date().toISOString(),
      }, { onConflict: 'item_id' });
      if (!error) guardadas++;
    }
    res.status(200).json({ ok: true, total: ids.length, guardadas });
  } catch (err) {
    res.status(500).json({ error: 'Error inesperado', detail: String(err) });
  }
}
