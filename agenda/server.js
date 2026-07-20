"use strict";

/**
 * Servidor Express da Agenda SISD.
 *
 * Responsabilidades:
 *  - Servir os arquivos estáticos da aplicação (index.html, styles.css, script.js).
 *  - Expor /api/calendar como camada intermediária que busca o ICS do Outlook
 *    no servidor (evitando o bloqueio de CORS do navegador), com cache curto
 *    em memória e CORS restrito à origem configurada.
 *
 * Requer Node.js >= 18 (usa o fetch global).
 */

const express = require("express");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const CALENDAR_ICS_URL =
  process.env.CALENDAR_ICS_URL ||
  "https://outlook.office365.com/owa/calendar/7390fe9481a141ad939331a8bd576247@saude.ba.gov.br/f56c542fabd0452f9f6c3178fbda6ea23840265162433551595/calendar.ics";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);

// Cache em memória simples (válido por processo/instância).
let cache = { body: null, fetchedAt: 0 };

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.get("/api/calendar", async (req, res) => {
  const agora = Date.now();

  if (cache.body && agora - cache.fetchedAt < CACHE_TTL_MS) {
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=" + Math.floor(CACHE_TTL_MS / 1000));
    return res.send(cache.body);
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
    return res.send(texto);
  } catch (erro) {
    console.error("Erro ao buscar o calendário ICS:", erro.message);

    // Se houver algo em cache (mesmo expirado), serve como último recurso.
    if (cache.body) {
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("X-Cache-Stale", "true");
      return res.send(cache.body);
    }

    return res.status(502).json({ erro: "Não foi possível obter o calendário no momento." });
  }
});

app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => {
  console.log(`Agenda SISD disponível em http://localhost:${PORT}`);
});
