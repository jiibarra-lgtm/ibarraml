// GET /api/sync?offset=0&limit=40&from=2026-08-01T00:00:00.000-00:00&to=2026-09-01T00:00:00.000-00:00
//
// Trae pedidos DE UN RANGO DE FECHAS puntual (normalmente un mes), de a
// lotes. Buscar por rango en vez de pedirle "todo" a ML de una evita
// cualquier límite interno que tenga /orders/search sobre el total de
// resultados de una sola búsqueda — partiendo por mes, cada búsqueda
// individual es chica.
//
// Si no se manda from/to, busca sin filtro de fecha (comportamiento viejo,
// se usa para el chequeo liviano de "lo más reciente").

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
  try {
    const resp = await fetch(`https://api.mercadolibre.com/categories/${categoryId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.name;
  } catch { return null; }
}

async function getInfoProducto(itemId, accessToken) {
  if (!itemId) return { foto: null, sku: null, link: null };
  try {
    // Intento 1: pedido liviano, solo los campos que necesitamos
    const resp = await fetch(`https://api.mercadolibre.com/items/${itemId}?attributes=thumbnail,secure_thumbnail,seller_custom_field,permalink,pictures`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (resp.ok) {
      const data = await resp.json();
      const foto = data.secure_thumbnail || data.thumbnail || data.pictures?.[0]?.secure_url || data.pictures?.[0]?.url || null;
      if (foto) return { foto, sku: data.seller_custom_field || null, link: data.permalink || null };
    }
    // Intento 2 (respaldo): pedido del ítem completo, por si la publicación está pausada/cerrada
    // y el filtro de atributos liviano no devuelve nada
    const resp2 = await fetch(`https://api.mercadolibre.com/items/${itemId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp2.ok) return { foto: null, sku: null, link: null };
    const data2 = await resp2.json();
    return {
      foto: data2.secure_thumbnail || data2.thumbnail || data2.pictures?.[0]?.secure_url || data2.pictures?.[0]?.url || null,
      sku: data2.seller_custom_field || null,
      link: data2.permalink || null,
    };
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
      if (d.type === 'coupon') cupon += monto; else descuento += monto;
    }
    return { descuento, cupon };
  } catch { return { descuento: 0, cupon: 0 }; }
}

async function getFacturaVendedor(packId, accessToken) {
  if (!packId) return null;
  try {
    const resp = await fetch(`https://api.mercadolibre.com/packs/${packId}/fiscal_documents`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return null;
    const data = await resp.json();
    const doc = (data.fiscal_documents || [])[0];
    if (!doc) return null;
    return { id: doc.id, filename: doc.filename, fecha: doc.date };
  } catch { return null; }
}

const PLANTILLA_FACTURA_DEFAULT = 'Hola! Te escribo por la compra "{titulo}" (pedido #{numero}) del {fecha}.\n\n¿Me podrías enviar la factura correspondiente a esta compra? La necesito para mi contabilidad. ¡Gracias!';

function armarTextoFactura(plantilla, datos) {
  return (plantilla || PLANTILLA_FACTURA_DEFAULT)
    .replaceAll('{titulo}', datos.titulo || '')
    .replaceAll('{numero}', String(datos.numero || ''))
    .replaceAll('{fecha}', datos.fecha || '')
    .replaceAll('{vendedor}', datos.vendedor || '')
    .slice(0, 350); // límite real de ML por mensaje
}

async function enviarMensajeAutomatico(accessToken, buyerUserId, packId, sellerId, texto) {
  try {
    const resp = await fetch(`https://api.mercadolibre.com/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { user_id: String(buyerUserId) }, to: { user_id: String(sellerId) }, text: texto }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: authRow, error: authErr } = await supabase
    .from('ml_auth').select('*').order('updated_at', { ascending: false }).limit(1).single();

  if (authErr || !authRow) {
    return res.status(400).json({ error: 'Todavía no conectaste tu cuenta de Mercado Libre. Andá a /api/login primero.' });
  }

  const offset = Number(req.query?.offset) || 0;
  const limit = Math.min(Number(req.query?.limit) || 40, 50);
  const { from, to } = req.query || {};

  let procesados = 0, guardados = 0, nuevos = 0, cambiosEstado = 0;

  try {
    const accessToken = await refreshTokenIfNeeded(supabase, authRow);

    // Traemos la plantilla configurada (si el usuario la personalizó) para el mensaje automático
    const { data: configRow } = await supabase.from('config').select('plantilla_factura').eq('id', 1).single();
    const plantillaFactura = configRow?.plantilla_factura || PLANTILLA_FACTURA_DEFAULT;

    let url = `https://api.mercadolibre.com/orders/search?buyer=${authRow.user_id}&sort=date_desc&offset=${offset}&limit=${limit}`;
    if (from) url += `&order.date_created.from=${encodeURIComponent(from)}`;
    if (to) url += `&order.date_created.to=${encodeURIComponent(to)}`;

    let ordersResp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (ordersResp.status === 429) {
      // ML nos frenó por exceso de consultas: esperamos un momento y reintentamos una vez
      await new Promise(r => setTimeout(r, 3000));
      ordersResp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    }
    const ordersData = await ordersResp.json();
    if (!ordersResp.ok) {
      return res.status(400).json({ error: 'Error consultando pedidos', detail: ordersData });
    }
    const total = ordersData.paging?.total ?? (ordersData.results?.length || 0);

    for (const order of ordersData.results || []) {
      procesados++;

      const { data: existente } = await supabase.from('pedidos')
        .select('status_envio, imagen_url, categoria_nombre, sku, link_publicacion, factura_ml_id, fecha_estimada')
        .eq('order_id', order.id).single();
      const esNuevo = !existente;

      let shipping = null;
      if (order.shipping?.id) {
        try {
          const shipResp = await fetch(`https://api.mercadolibre.com/orders/${order.id}/shipments?views=origin,destination`, { headers: { Authorization: `Bearer ${accessToken}`, 'X-New-Domain': 'true', 'X-Api-Version': '2' } });
          if (shipResp.ok) shipping = await shipResp.json();
        } catch (e) { console.error('shipment error', order.id, e); }
      }
      const shipInfo = Array.isArray(shipping) ? shipping.find(s => s.type === 'forward') : shipping;
      if (existente && existente.status_envio !== (shipInfo?.status || null)) cambiosEstado++;

      const primerItem = order.order_items?.[0]?.item;

      let categoriaNombre = existente?.categoria_nombre || null;
      let infoProducto = { foto: existente?.imagen_url || null, sku: existente?.sku || null, link: existente?.link_publicacion || null };
      let descuentoInfo = { descuento: null, cupon: null };

      if (!existente || !existente.imagen_url) infoProducto = await getInfoProducto(primerItem?.id, accessToken);
      if (!existente || !existente.categoria_nombre) categoriaNombre = await getCategoriaNombre(primerItem?.category_id, accessToken);
      if (esNuevo) descuentoInfo = await getDescuentos(order.id, accessToken);

      let facturaVendedor = null;
      if (!existente || !existente.factura_ml_id) {
        facturaVendedor = await getFacturaVendedor(order.pack_id || order.id, accessToken);
      }

      const metodoPago = order.payments?.[0]?.payment_type || null;
      const cuotas = order.payments?.[0]?.installments || null;
      const fechaPago = order.payments?.[0]?.date_approved || null;
      const precioUnitario = order.order_items?.[0]?.unit_price ?? null;
      const cantidadUnidades = order.order_items?.[0]?.quantity ?? 1;
      const variante = (primerItem?.variation_attributes || []).map(a => a.value_name).join(' / ') || null;
      const logisticType = shipInfo?.logistic_type || null;
      const destinoTipo = shipInfo?.destination?.type || null;
      const destinoDireccion = shipInfo?.destination?.shipping_address?.address_line || null;
      const destinoCalle = shipInfo?.receiver_address?.address_line || null;
      const destinoCiudad = shipInfo?.receiver_address?.city?.name || null;
      const destinoProvincia = shipInfo?.receiver_address?.state?.name || null;
      const destinoLat = shipInfo?.receiver_address?.latitude ?? null;
      const destinoLon = shipInfo?.receiver_address?.longitude ?? null;
      const origenProvincia = shipInfo?.sender_address?.state?.name || null;
      const costoEnvio = shipInfo?.shipping_option?.cost ?? null;
      const fechaEstimadaNueva = shipInfo?.shipping_option?.estimated_delivery_time?.date || null;
      const fechaEstimadaCambio = !!(existente?.fecha_estimada && fechaEstimadaNueva && existente.fecha_estimada !== fechaEstimadaNueva);

      const payload = {
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
        cuotas,
        fecha_pago: fechaPago,
        vendedor_nickname: order.seller?.nickname || null,
        status_orden: order.status,
        status_envio: shipInfo?.status || null,
        substatus_envio: shipInfo?.substatus || null,
        tipo_envio: shipInfo?.type || null,
        logistic_type: logisticType,
        destino_tipo: destinoTipo,
        destino_direccion: destinoDireccion,
        destino_calle: destinoCalle,
        destino_ciudad: destinoCiudad,
        destino_provincia: destinoProvincia,
        destino_lat: destinoLat,
        destino_lon: destinoLon,
        origen_provincia: origenProvincia,
        costo_envio: costoEnvio,
        fecha_estimada: fechaEstimadaNueva,
        fecha_estimada_cambio: fechaEstimadaCambio,
        tracking_number: shipInfo?.tracking_number || null,
        categoria_id: primerItem?.category_id || null,
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
      };
      if (descuentoInfo.descuento !== null) payload.descuento_monto = descuentoInfo.descuento;
      if (descuentoInfo.cupon !== null) payload.cupon_monto = descuentoInfo.cupon;
      if (facturaVendedor) {
        payload.factura_ml_id = facturaVendedor.id;
        payload.factura_ml_filename = facturaVendedor.filename;
        payload.factura_ml_fecha = facturaVendedor.fecha;
      }

      // El envío automático silencioso se sacó — ahora se manda desde la
      // sección "Solicitar facturas", donde elegís vos cuáles mandar.

      const { error: upsertErr } = await supabase.from('pedidos').upsert(payload, { onConflict: 'order_id' });

      if (!upsertErr) {
        guardados++;
        if (esNuevo) nuevos++;
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
      } else {
        console.error('upsert error', order.id, upsertErr);
      }
    }

    const done = offset + limit >= total;
    res.status(200).json({ ok: true, total_ml: total, procesados, guardados, nuevos, cambios_estado: cambiosEstado, offset, limit, next_offset: offset + limit, done });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error inesperado', detail: String(err) });
  }
}
