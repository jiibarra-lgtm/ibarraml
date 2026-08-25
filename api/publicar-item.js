// POST /api/publicar-item
// Body: { titulo, category_id, precio, moneda, stock, condicion, fotos: [urls], descripcion }
// Crea la publicación real en Mercado Libre. Requiere que la app tenga el
// permiso "Publicación y sincronización" en Lectura y escritura.

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { titulo, category_id, precio, moneda, stock, condicion, fotos, descripcion } = req.body || {};
  if (!titulo || !category_id || !precio || !stock) {
    return res.status(400).json({ error: 'Faltan campos obligatorios (título, categoría, precio, stock)' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authRow } = await supabase.from('ml_auth').select('*').order('updated_at', { ascending: false }).limit(1).single();
  if (!authRow) return res.status(400).json({ error: 'No hay cuenta de ML conectada' });

  try {
    const accessToken = await refreshTokenIfNeeded(supabase, authRow);

    // Paso 1: crear la publicación (sin descripción, como pide ML)
    const bodyItem = {
      title: titulo,
      category_id,
      price: Number(precio),
      currency_id: moneda || 'ARS',
      available_quantity: Number(stock),
      buying_mode: 'buy_it_now',
      condition: condicion || 'new',
      listing_type_id: 'gold_special',
      channels: ['marketplace'],
      pictures: (fotos || []).map(url => ({ source: url })),
    };

    const respItem = await fetch('https://api.mercadolibre.com/items', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyItem),
    });
    const dataItem = await respItem.json();
    if (!respItem.ok) {
      return res.status(respItem.status).json({ error: 'ML rechazó la publicación', detail: dataItem });
    }

    // Paso 2: agregar la descripción, en un pedido aparte (así lo pide ML)
    if (descripcion) {
      await fetch(`https://api.mercadolibre.com/items/${dataItem.id}/description`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ plain_text: descripcion }),
      }).catch(() => {}); // si falla la descripción, no rompemos la publicación ya creada
    }

    // Guardamos referencia en nuestra base
    await supabase.from('mis_publicaciones').insert({
      item_id: dataItem.id,
      titulo: dataItem.title,
      category_id: dataItem.category_id,
      precio: dataItem.price,
      moneda: dataItem.currency_id,
      stock: dataItem.available_quantity,
      condicion: dataItem.condition,
      descripcion: descripcion || null,
      fotos: fotos || [],
      permalink: dataItem.permalink,
      status: dataItem.status,
    });

    res.status(200).json({ ok: true, item: dataItem });
  } catch (err) {
    res.status(500).json({ error: 'Error inesperado', detail: String(err) });
  }
}
