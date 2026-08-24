// GET /api/mensajes?order_id=...
// Trae el historial de mensajes posventa reales de ese pedido (solo lectura).

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
  const { order_id } = req.query;
  if (!order_id) return res.status(400).json({ error: 'Falta order_id' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authRow } = await supabase.from('ml_auth').select('*').order('updated_at', { ascending: false }).limit(1).single();
  if (!authRow) return res.status(400).json({ error: 'No hay cuenta de ML conectada' });

  const { data: pedido } = await supabase.from('pedidos').select('pack_id, order_id, seller_id, vendedor_nickname').eq('order_id', order_id).single();
  if (!pedido || !pedido.seller_id) return res.status(400).json({ error: 'No se encontró el vendedor de este pedido' });

  const packId = pedido.pack_id || pedido.order_id;

  try {
    const accessToken = await refreshTokenIfNeeded(supabase, authRow);
    const resp = await fetch(`https://api.mercadolibre.com/messages/packs/${packId}/sellers/${pedido.seller_id}?tag=post_sale&mark_as_read=false`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({ error: 'No se pudieron traer los mensajes', detail: data });
    }
    res.status(200).json({
      ok: true,
      vendedor: pedido.vendedor_nickname,
      mi_user_id: String(authRow.user_id),
      conversation_status: data.conversation_status,
      messages: data.messages || [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Error inesperado', detail: String(err) });
  }
}
