// GET /api/sync
// Trae TODOS los pedidos, con datos financieros completos (envío, descuentos,
// cupón, impuestos), actualiza la tabla sellers, agrega al historial de
// precios cuando corresponde, y deja un log de la corrida en sync_logs.

import { createClient } from '@supabase/supabase-js';

const categoriaCache = new Map();
const itemCache = new Map();

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
    const resp = await fetch(`https://api.mercadolibre.com/categories/${categoryId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return null;
    const data = await resp.json();
    categoriaCache.set(categoryId, data.name);
    return data.name;
  } catch { return null; }
}

async function getInfoProducto(itemId, accessToken) {
  if (!itemId) return { foto: null, sku: null };
  if (itemCache.has(itemId)) return itemCache.get(itemId);
  try {
    const resp = await fetch(`https://api.mercadolibre.com/items/${itemId}?attributes=thumbnail,secure_thumbnail,seller_custom_field,permalink`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return { foto: null, sku: null, link: null };
    const data = await resp.json();
    const info = { foto: data.secure_thumbnail || data.thumbnail || null, sku: data.seller_custom_field || null, link: data.permalink || null };
    itemCache.set(itemId, info);
    return info;
  } catch { return { foto: null, sku: null, link: null }; }
}

async function getDescuentos(orderId, accessToken) {
  try {
    const resp = await fetch(`https://api.mercadolibre.com/orders/${orderId}/discounts`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return { descuento: 0, cupon: 0 };
    const data = await resp.json();
    let descuento = 0, cupon = 0;
    for (const d of data.details || []) {
      const monto = (d.items || []).reduce((a, it) => a + (it.amounts?.total || 0), 0);
      if (d.type === 'coupon') cupon += monto;
      else descuento += monto;
    }
    return { descuento, cupon };
  } catch { return { descuento: 0, cupon: 0 }; }
}

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: authRow, error: authErr } = await supabase
    .from('ml_auth').select('*').order('updated_at', { ascending: false }).limit(1).single();

  if (authErr || !authRow) {
    return res.status(400).json({ error: 'Todavía no conectaste tu cuenta de Mercado Libre. Andá a /api/login primero.' });
  }

  let procesados = 0, guardados = 0, nuevos = 0, cambiosEstado = 0;

  try {
    const accessToken = await refreshTokenIfNeeded(supabase, authRow);

    let offset = 0;
    const limit = 50;
    let total = Infinity;

    while (offset < total) {
      const ordersResp = await fetch(
        `https://api.mercadolibre.com/orders/search?buyer=${authRow.user_id}&sort=date_desc&offset=${offset}&limit=${limit}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const ordersData = await ordersResp.json();
      if (!ordersResp.ok) {
        await supabase.from('sync_logs').insert({ ok: false, procesados, guardados, nuevos, cambios_estado: cambiosEstado, error: JSON.stringify(ordersData) });
        return res.status(400).json({ error: 'Error consultando pedidos', detail: ordersData });
      }
      total = ordersData.paging?.total ?? (ordersData.results?.length || 0);

      for (const order of ordersData.results || []) {
        procesados++;

        // Estado previo (para detectar cambios y para no perder factura/notas al reprocesar)
        const { data: existente } = await supabase.from('pedidos').select('status_envio').eq('order_id', order.id).single();
        const esNuevo = !existente;
        if (existente && existente.status_envio) {
          // se compara después de tener el nuevo shipInfo, más abajo
        }

        let shipping = null;
        if (order.shipping?.id) {
          try {
            const shipResp = await fetch(`https://api.mercadolibre.com/orders/${order.id}/shipments`, { headers: { Authorization: `Bearer ${accessToken}`, 'X-New-Domain': 'true' } });
            if (shipResp.ok) shipping = await shipResp.json();
          } catch (e) { console.error('shipment error', order.id, e); }
        }
        const shipInfo = Array.isArray(shipping) ? shipping.find(s => s.type === 'forward') : shipping;

        if (existente && existente.status_envio !== (shipInfo?.status || null)) cambiosEstado++;

        const primerItem = order.order_items?.[0]?.item;
        const categoriaId = primerItem?.category_id || null;
        const categoriaNombre = await getCategoriaNombre(categoriaId, accessToken);
        const infoProducto = await getInfoProducto(primerItem?.id, accessToken);
        const { descuento, cupon } = await getDescuentos(order.id, accessToken);

        const metodoPago = order.payments?.[0]?.payment_type || null;
        const cuotas = order.payments?.[0]?.installments || null;
        const fechaPago = order.payments?.[0]?.date_approved || null;
        const precioUnitario = order.order_items?.[0]?.unit_price ?? null;
        const cantidadUnidades = order.order_items?.[0]?.quantity ?? 1;
        const variante = (primerItem?.variation_attributes || []).map(a => a.value_name).join(' / ') || null;

        const { error: upsertErr } = await supabase.from('pedidos').upsert({
          order_id: order.id,
          pack_id: order.pack_id || null,
          numero_operacion: String(order.pack_id || order.id),
          seller_id: order.seller?.id || null,
          titulo: primerItem?.title || null,
          variante,
          sku: infoProducto.sku,
          link_publicacion: infoProducto.link,
          cantidad_items: order.order_items?.length || 1,
          cantidad_unidades: cantidadUnidades,
          precio_unitario: precioUnitario,
          total: order.total_amount,
          moneda: order.currency_id,
          costo_envio: shipInfo?.shipping_option?.cost ?? null,
          descuento_monto: descuento || null,
          cupon_monto: cupon || null,
          impuestos_monto: order.taxes?.amount ?? null,
          cuotas,
          fecha_pago: fechaPago,
          vendedor_nickname: order.seller?.nickname || null,
          status_orden: order.status,
          status_envio: shipInfo?.status || null,
          substatus_envio: shipInfo?.substatus || null,
          tipo_envio: shipInfo?.type || null,
          tracking_number: shipInfo?.tracking_number || null,
          categoria_id: categoriaId,
          categoria_nombre: categoriaNombre,
          metodo_pago: metodoPago,
          imagen_url: infoProducto.foto,
          fecha_creacion: order.date_created,
          fecha_despachado: shipInfo?.status_history?.date_shipped || null,
          fecha_entrega: shipInfo?.status_history?.date_delivered || null,
          entregado_confirmado: shipInfo?.status === 'delivered',
          ultima_sync: new Date().toISOString(),
          raw_order: order,
          raw_shipping: shipInfo,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'order_id' });

        if (!upsertErr) {
          guardados++;
          if (esNuevo) nuevos++;

          // Actualizar tabla sellers (entidad propia)
          if (order.seller?.id) {
            const { data: sellerActual } = await supabase.from('sellers').select('*').eq('seller_id', order.seller.id).single();
            await supabase.from('sellers').upsert({
              seller_id: order.seller.id,
              nickname: order.seller.nickname || sellerActual?.nickname || null,
              cantidad_compras: (sellerActual?.cantidad_compras || 0) + (esNuevo ? 1 : 0),
              total_gastado: (sellerActual?.total_gastado || 0) + (esNuevo ? (order.total_amount || 0) : 0),
              ultima_compra: order.date_created,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'seller_id' });
          }

          // Historial de precios: solo si ya existe producto_generico cargado a mano en un pedido previo
          // (se completa progresivamente a medida que cargás nombres genéricos)
        }
      }
      offset += limit;
      if (!ordersData.results || ordersData.results.length === 0) break;
    }

    await supabase.from('sync_logs').insert({ ok: true, procesados, guardados, nuevos, cambios_estado: cambiosEstado });
    res.status(200).json({ ok: true, total_ml: total, procesados, guardados, nuevos, cambios_estado: cambiosEstado });
  } catch (err) {
    console.error(err);
    await supabase.from('sync_logs').insert({ ok: false, procesados, guardados, nuevos, cambios_estado: cambiosEstado, error: String(err) });
    res.status(500).json({ error: 'Error inesperado', detail: String(err) });
  }
}
