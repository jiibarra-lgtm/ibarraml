// GET /api/test-mensaje
// Busca el pedido más reciente sin factura del vendedor y le manda el
// mensaje automático ahora mismo (usando la misma lógica del sync), para
// que puedas confirmar que el permiso de mensajería está bien configurado
// sin esperar una compra nueva.

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

  const { data: pedido } = await supabase.from('pedidos')
    .select('order_id, pack_id, seller_id, vendedor_nickname, titulo, numero_operacion, fecha_creacion')
    .is('factura_ml_id', null)
    .not('seller_id', 'is', null)
    .order('fecha_creacion', { ascending: false })
    .limit(1)
    .single();

  if (!pedido) return res.status(400).json({ error: 'No encontré ningún pedido sin factura para probar. Sincronizá primero.' });

  const { data: configRow } = await supabase.from('config').select('plantilla_factura').eq('id', 1).single();
  const plantilla = configRow?.plantilla_factura || 'Hola! Te escribo por la compra "{titulo}" (pedido #{numero}) del {fecha}.\n\n¿Me podrías enviar la factura correspondiente a esta compra? La necesito para mi contabilidad. ¡Gracias!';
  const texto = plantilla
    .replaceAll('{titulo}', pedido.titulo || '')
    .replaceAll('{numero}', String(pedido.numero_operacion || pedido.order_id))
    .replaceAll('{fecha}', pedido.fecha_creacion ? new Date(pedido.fecha_creacion).toLocaleDateString('es-AR') : '')
    .slice(0, 350);

  try {
    const accessToken = await refreshTokenIfNeeded(supabase, authRow);
    const packId = pedido.pack_id || pedido.order_id;
    const resp = await fetch(`https://api.mercadolibre.com/messages/packs/${packId}/sellers/${pedido.seller_id}?tag=post_sale`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { user_id: String(authRow.user_id) }, to: { user_id: String(pedido.seller_id) }, text: texto }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return res.status(200).json({ ok: false, funciona: false, pedido: pedido.titulo, error: data });
    }
    await supabase.from('pedidos').update({ mensaje_factura_enviado: true }).eq('order_id', pedido.order_id);
    res.status(200).json({ ok: true, funciona: true, pedido: pedido.titulo, vendedor: pedido.vendedor_nickname, texto });
  } catch (err) {
    res.status(200).json({ ok: false, funciona: false, error: String(err) });
  }
}
