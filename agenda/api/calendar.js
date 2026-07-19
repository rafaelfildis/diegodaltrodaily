"use strict";

/**
 * Função serverless (Vercel) equivalente ao endpoint /api/calendar do
 * server.js — mesma lógica de proxy/cache, adaptada ao formato que a Vercel
 * espera para arquivos dentro de api/ (module.exports = handler(req, res)).
 *
 * Requer runtime Node.js >= 18 (usa o fetch global).
 */

const CALENDAR_ICS_URL =
  process.env.CALENDAR_ICS_URL ||
  "https://outlook.office365.com/owa/calendar/65cfb5623f234028985baccad09b038b@saude.ba.gov.br/3bf59cb231fa445487f965f4bff5857413135215430858372856/calendar.ics";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);

// Cache em memória: só é reaproveitado enquanto a MESMA instância da função
// permanecer "quente" entre invocações — comportamento normal de funções
// serverless, não é um cache persistente garantido entre execuções.
let cache = { body: null, fetchedAt: 0 };

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const agora = Date.now();

  if (cache.body && agora - cache.fetchedAt < CACHE_TTL_MS) {
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=" + Math.floor(CACHE_TTL_MS / 1000));
    res.status(200).send(cache.body);
    return;
  }

  try {
    const upstream = await fetch(CALENDAR_ICS_URL);
    if (!upstream.ok) {
      throw new Error("Servidor do Outlook respondeu " + upstream.status);
    }
    const texto = await upstream.text();
    cache = { body: texto, fetchedAt: agora };

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=" + Math.floor(CACHE_TTL_MS / 1000));
    res.status(200).send(texto);
  } catch (erro) {
    console.error("Erro ao buscar o calendário ICS:", erro.message);

    // Se houver algo em cache (mesmo expirado), serve como último recurso.
    if (cache.body) {
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("X-Cache-Stale", "true");
      res.status(200).send(cache.body);
      return;
    }

    res.status(502).json({ erro: "Não foi possível obter o calendário no momento." });
  }
};
