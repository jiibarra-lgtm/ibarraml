// GET /api/sync
// Trae TODOS los pedidos del usuario (paginando de a 50, que es el máximo
// de ML por request), con su categoría, y los guarda/actualiza en Supabase.

import { createClient } from '@supabase/supabase-js';

const categoriaCache = new Map(); // evita pedir la misma categoría repetidas veces

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
  if (!resp.ok) throw new Error('No se pudo refrescar el token: ' + JSON.stringify(data));

  await supabase.from('ml_auth').update({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('user_id', auth.user_id);

  return data.access_token;
}

async function getCategoriaNombre(categoryId, accessToken) {
  if (!categoryId) return null;
  if (categoriaCache.has(categoryId)) return categoriaCache.get(categoryId);
  try {
    const resp = await fetch(`https://api.mercadolibre.com/categories/${categoryId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    categoriaCache.set(categoryId, data.name);
    return data.name;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: authRow, error: authErr } = await supabase
    .from('ml_auth').select('*').order('updated_at', { ascending: false }).limit(1).single();

  if (authErr || !authRow) {
    return res.status(400).json({ error: 'Todavía no conectaste tu cuenta de Mercado Libre. Andá a /api/login primero.' });
  }

  try {
    const accessToken = await refreshTokenIfNeeded(supabase, authRow);

    let offset = 0;
    const limit = 50;
    let total = Infinity;
    let guardados = 0;
    let procesados = 0;

    while (offset < total) {
      const ordersResp = await fetch(
        `https://api.mercadolibre.com/orders/search?buyer=${authRow.user_id}&sort=date_desc&offset=${offset}&limit=${limit}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const ordersData = await ordersResp.json();
      if (!ordersResp.ok) {
        return res.status(400).json({ error: 'Error consultando pedidos', detail: ordersData });
      }

      total = ordersData.paging?.total ?? (ordersData.results?.length || 0);

      for (const order of ordersData.results || []) {
        procesados++;

        let shipping = null;
        if (order.shipping?.id) {
          try {
            const shipResp = await fetch(
              `https://api.mercadolibre.com/orders/${order.id}/shipments`,
              { headers: { Authorization: `Bearer ${accessToken}`, 'X-New-Domain': 'true' } }
            );
            if (shipResp.ok) shipping = await shipResp.json();
          } catch (e) {
            console.error('Error trayendo shipment de la orden', order.id, e);
          }
        }
        const shipInfo = Array.isArray(shipping) ? shipping.find(s => s.type === 'forward') : shipping;

        const primerItem = order.order_items?.[0]?.item;
        const categoriaId = primerItem?.category_id || null;
        const categoriaNombre = await getCategoriaNombre(categoriaId, accessToken);

        const { error: upsertErr } = await supabase.from('pedidos').upsert({
          order_id: order.id,
          pack_id: order.pack_id || null,
          titulo: primerItem?.title || null,
          cantidad_items: order.order_items?.length || 1,
          total: order.total_amount,
          moneda: order.currency_id,
          vendedor_nickname: order.seller?.nickname || null,
          status_orden: order.status,
          status_envio: shipInfo?.status || null,
          substatus_envio: shipInfo?.substatus || null,
          tracking_number: shipInfo?.tracking_number || null,
          categoria_id: categoriaId,
          categoria_nombre: categoriaNombre,
          fecha_creacion: order.date_created,
          fecha_entrega: shipInfo?.status_history?.date_delivered || null,
          entregado_confirmado: shipInfo?.status === 'delivered',
          raw_order: order,
          raw_shipping: shipInfo,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'order_id' });

        if (!upsertErr) guardados++;
      }

      offset += limit;
      if (!ordersData.results || ordersData.results.length === 0) break; // corte de seguridad
    }

    res.status(200).json({ ok: true, total_ml: total, procesados, guardados });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error inesperado', detail: String(err) });
  }
}
