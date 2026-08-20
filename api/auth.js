// POST /api/auth  { password: "..." }
<<<<<<< HEAD
// Comparda contra APP_PASSWORD_HASH (bcrypt) guardado en variables de entorno
// de Vercel. Si coincide, devuelve un token simple firmado (HMAC) con
=======
// Compara contra APP_PASSWORD_HASH (bcrypt) guardado en variables de entorno
// de Vercel. Si coigncide, devuelve un token simple firmado (HMAC) con
>>>>>>> b5673ec960cbce80639998d22bf937a40be3442c
// expiración de 30 días, que el frontend guarda en localStorage.
//
// Variables de entorno necesarias:
//   APP_PASSWORD_HASH  -> hash bcrypt de tu contraseña (instrucciones en README)
//   APP_TOKEN_SECRET    -> cualquier string largo random, para firmar el token

import bcrypt from 'bcryptjs';
import crypto from 'crypto';

function firmarToken(secret) {
  const expira = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 días
  const firma = crypto.createHmac('sha256', secret).update(String(expira)).digest('hex');
  return Buffer.from(`${expira}.${firma}`).toString('base64');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Falta la contraseña' });

  const hash = process.env.APP_PASSWORD_HASH;
  const secret = process.env.APP_TOKEN_SECRET;
  if (!hash || !secret) {
    return res.status(500).json({ error: 'Faltan APP_PASSWORD_HASH / APP_TOKEN_SECRET en las variables de entorno.' });
  }

  const coincide = await bcrypt.compare(password, hash);
  if (!coincide) return res.status(401).json({ error: 'Contraseña incorrecta' });

  const token = firmarToken(secret);
  res.status(200).json({ ok: true, token });
}
