"use strict";

// ical.js v2 é distribuído como módulo ES (sem global `window.ICAL`),
// por isso este arquivo é carregado como <script type="module"> e importa
// a biblioteca diretamente do CDN.
import ICAL from "https://cdn.jsdelivr.net/npm/ical.js@2.1.0/dist/ical.min.js";

/* ==========================================================================
   CONFIGURAÇÃO CENTRAL
   ========================================================================== */

const CALENDAR_ICS_URL =
  "https://outlook.office365.com/owa/calendar/7390fe9481a141ad939331a8bd576247@saude.ba.gov.br/f56c542fabd0452f9f6c3178fbda6ea23840265162433551595/calendar.ics";

// Link "humano" do mesmo calendário publicado, usado apenas no botão
// "Abrir calendário no Outlook" — nunca como fonte de dados.
const CALENDAR_HTML_URL = CALENDAR_ICS_URL.replace(/calendar\.ics$/, "calendar.html");

// Endpoint intermediário (server.js / função serverless) usado quando o
// fetch direto ao Outlook é bloqueado por CORS.
const CALENDAR_API_URL = "/api/calendar";

const USE_DEMO_DATA = false;

const DISPLAY_TIMEZONE = "America/Bahia";
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutos
const STORAGE_KEY = "agendaSisd.cache.v1";

// Janela de expansão de eventos recorrentes (evita gerar ocorrências infinitas).
const JANELA_MESES_PASSADO = 1;
const JANELA_MESES_FUTURO = 6;
const MAX_OCORRENCIAS_POR_EVENTO = 300;

/* ==========================================================================
   ESTADO DA APLICAÇÃO
   ========================================================================== */

const state = {
  eventos: [],
  usandoCache: false,
  ultimaAtualizacao: null,
  carregando: false,
  filtros: {
    periodo: "dia", // todos | dia | semana | mes — sem filtro explícito, mostra a agenda de hoje
    categorias: new Set(),
    busca: "",
    mostrarConcluidos: true,
    dataInicio: null, // "YYYY-MM-DD" ou null
    dataFim: null, // "YYYY-MM-DD" ou null
  },
  exportacao: {
    formato: "a4", // a4 | mobile
  },
  ui: {
    vista: "timeline", // timeline | tabela
    tabelaOrdenarPor: "data",
    tabelaOrdemAsc: true,
    tabelaPagina: 1,
    tabelaPorPagina: 15,
    sidebarAberta: false, // drawer mobile
    sidebarRecolhida: false, // colapso desktop
  },
};

const SIDEBAR_RECOLHIDA_STORAGE_KEY = "agendaSisd.sidebarRecolhida";

/* ==========================================================================
   DEMO (somente para desenvolvimento local, quando USE_DEMO_DATA = true)
   ========================================================================== */

const DEMO_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Demo//Agenda SISD//PT
BEGIN:VEVENT
UID:demo-1@agenda
DTSTAMP:20260701T120000Z
DTSTART:20260720T120000Z
DTEND:20260720T130000Z
SUMMARY:Reunião de alinhamento (Teams)
DESCRIPTION:Pauta online via Microsoft Teams para discutir indicadores.
LOCATION:Microsoft Teams
END:VEVENT
BEGIN:VEVENT
UID:demo-2@agenda
DTSTAMP:20260701T120000Z
DTSTART;VALUE=DATE:20260722
DTEND;VALUE=DATE:20260725
SUMMARY:Viagem a Brasília
DESCRIPTION:Embarque às 7h, desembarque previsto às 10h.
LOCATION:Aeroporto de Brasília
END:VEVENT
BEGIN:VEVENT
UID:demo-3@agenda
DTSTAMP:20260701T120000Z
DTSTART:20260721T190000Z
DTEND:20260721T210000Z
SUMMARY:Aula de mestrado — Seminário de pesquisa
DESCRIPTION:Disciplina obrigatória, sala 12, universidade.
LOCATION:Sala 12
RRULE:FREQ=WEEKLY;COUNT=4
END:VEVENT
END:VCALENDAR`;

/* ==========================================================================
   UTILITÁRIOS DE TEXTO E DATA
   ========================================================================== */

function normalizarTexto(txt) {
  return (txt || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function extrairPrimeiraUrl(texto) {
  if (!texto) return "";
  const match = texto.match(/https?:\/\/[^\s"'<>]+/i);
  return match ? match[0] : "";
}

function formatarDataHora(date) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: DISPLAY_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatarHora(date) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: DISPLAY_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatarDataLonga(date) {
  const texto = new Intl.DateTimeFormat("pt-BR", {
    timeZone: DISPLAY_TIMEZONE,
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);
  return texto;
}

// Chave "YYYY-MM-DD" do evento no fuso de exibição — usada para agrupar por dia.
function chaveDia(date) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const obj = {};
  partes.forEach((p) => (obj[p.type] = p.value));
  return `${obj.year}-${obj.month}-${obj.day}`;
}

function inicioDoDia(date) {
  const chave = chaveDia(date);
  return new Date(`${chave}T00:00:00${offsetBahia()}`);
}

function fimDoDia(date) {
  const chave = chaveDia(date);
  return new Date(`${chave}T23:59:59.999${offsetBahia()}`);
}

// America/Bahia não observa horário de verão desde 2019: offset fixo -03:00.
function offsetBahia() {
  return "-03:00";
}

function segundaDaSemana(date) {
  const chave = chaveDia(date);
  const d = new Date(`${chave}T12:00:00${offsetBahia()}`);
  const diaSemana = d.getUTCDay(); // 0 = domingo
  const distanciaSegunda = (diaSemana + 6) % 7;
  d.setUTCDate(d.getUTCDate() - distanciaSegunda);
  return inicioDoDia(d);
}

function domingoDaSemana(date) {
  const seg = segundaDaSemana(date);
  const dom = new Date(seg);
  dom.setUTCDate(dom.getUTCDate() + 6);
  return fimDoDia(dom);
}

function inicioDoMes(date) {
  const chave = chaveDia(date);
  const [ano, mes] = chave.split("-");
  return new Date(`${ano}-${mes}-01T00:00:00${offsetBahia()}`);
}

function fimDoMes(date) {
  const inicio = inicioDoMes(date);
  const proximo = new Date(inicio);
  proximo.setUTCMonth(proximo.getUTCMonth() + 1);
  proximo.setUTCMilliseconds(proximo.getUTCMilliseconds() - 1);
  return proximo;
}

/* ==========================================================================
   CLASSIFICAÇÃO AUTOMÁTICA
   ========================================================================== */

const PALAVRAS_VIAGEM = [
  "viagem", "voo", "aeroporto", "hotel", "embarque", "desembarque",
  "deslocamento", "passagem aerea", "passagem",
];

const CIDADES_REFERENCIA = [
  "brasilia", "sao paulo", "rio de janeiro", "feira de santana",
  "vitoria da conquista", "ilheus", "porto seguro", "juazeiro",
  "barreiras", "itabuna", "camacari", "belo horizonte", "recife",
  "fortaleza", "curitiba", "porto alegre", "goiania", "manaus", "belem",
  "salvador",
];

const PALAVRAS_MESTRADO = [
  "mestrado", "aula", "disciplina", "seminario", "orientacao",
  "atividade academica", "universidade", "doutorado", "banca",
  "modulo", "mpsd",
];

const PALAVRAS_ONLINE = [
  "online", "virtual", "teams", "microsoft teams", "google meet",
  "meet", "zoom", "videoconferencia", "webex",
];

const PALAVRAS_PRESENCIAL = [
  "presencial", "forum", "tribunal", "audiencia", "escritorio",
  "sala", "secretaria", "auditorio",
];

const REGEX_LINK_REUNIAO = /https?:\/\/(teams\.microsoft\.com|meet\.google\.com|zoom\.us|webex\.com)/i;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Correspondência por palavra/frase inteira (com \b), não por substring solta.
// Evita falsos positivos como "aula" dentro de "Paula" ou "sala" dentro de
// outra palavra maior.
function contemPalavraChave(texto, palavra) {
  const regex = new RegExp("\\b" + escapeRegex(palavra) + "\\b", "i");
  return regex.test(texto);
}

function contemAlgumaPalavra(texto, lista) {
  return lista.some((p) => contemPalavraChave(texto, p));
}

function classificarEvento(evento) {
  const textoCompleto = normalizarTexto(
    [
      evento.titulo,
      evento.descricao,
      evento.local,
      evento.link,
      (evento.categoriasIcs || []).join(" "),
    ].join(" ")
  );

  // Nomes de cidade só são considerados em título/local: a descrição de
  // reuniões frequentemente carrega rodapés/assinaturas de e-mail que citam
  // cidades (ex.: endereço institucional do organizador) sem relação alguma
  // com deslocamento, o que geraria falsos positivos de "viagem".
  const textoCidade = normalizarTexto([evento.titulo, evento.local].join(" "));

  const temViagem =
    contemAlgumaPalavra(textoCompleto, PALAVRAS_VIAGEM) ||
    contemAlgumaPalavra(textoCidade, CIDADES_REFERENCIA);
  if (temViagem) return "viagem";

  // "Mestrado" só é reconhecido pela nomenclatura do próprio compromisso
  // (título) — "mestrado", "aula", "disciplina" etc. — e não pela descrição,
  // que costuma trazer texto de terceiros (convites, assinaturas) sem
  // relação com a categoria.
  const textoTitulo = normalizarTexto(evento.titulo);
  if (contemAlgumaPalavra(textoTitulo, PALAVRAS_MESTRADO)) return "mestrado";

  const temLinkReuniao = REGEX_LINK_REUNIAO.test(evento.link || "");
  if (contemAlgumaPalavra(textoCompleto, PALAVRAS_ONLINE) || temLinkReuniao) {
    return "pauta-online";
  }

  if (contemAlgumaPalavra(textoCompleto, PALAVRAS_PRESENCIAL)) return "pauta-presencial";

  // Sem link de reunião e sem palavras-chave identificáveis: assume presencial.
  return "pauta-presencial";
}

/* ==========================================================================
   PARSING ICS (ical.js) — VEVENT, RRULE, EXDATE, RECURRENCE-ID, VTIMEZONE
   ========================================================================== */

function mapStatus(raw) {
  switch ((raw || "").toUpperCase()) {
    case "CANCELLED":
      return "cancelado";
    case "TENTATIVE":
      return "tentativo";
    case "CONFIRMED":
    default:
      return "confirmado";
  }
}

function lerCategoriasIcs(icalEvent) {
  try {
    const prop = icalEvent.component.getFirstProperty("categories");
    if (!prop) return [];
    const valor = icalEvent.component.getFirstPropertyValue("categories");
    return valor
      ? valor
          .toString()
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
      : [];
  } catch (e) {
    return [];
  }
}

function lerUrl(icalEvent, descricao, local) {
  try {
    const valor = icalEvent.component.getFirstPropertyValue("url");
    if (valor) return String(valor);
  } catch (e) {
    /* ignora */
  }
  return extrairPrimeiraUrl(descricao) || extrairPrimeiraUrl(local) || "";
}

function construirOcorrencia(icalEvent, startTime, endTime, recorrente) {
  const diaInteiro = !!startTime.isDate;
  const inicioJS = startTime.toJSDate();
  const fimJS = endTime ? endTime.toJSDate() : inicioJS;

  const titulo = icalEvent.summary || "(Sem título)";
  const descricao = icalEvent.description || "";
  const local = icalEvent.location || "";
  const link = lerUrl(icalEvent, descricao, local);

  let statusRaw = "";
  try {
    statusRaw = icalEvent.component.getFirstPropertyValue("status") || "";
  } catch (e) {
    /* ignora */
  }

  const categoriasIcs = lerCategoriasIcs(icalEvent);

  const idBase = icalEvent.uid || Math.random().toString(36).slice(2);
  const id = recorrente ? `${idBase}::${startTime.toString()}` : idBase;

  const evento = {
    id,
    titulo,
    descricao,
    inicio: inicioJS.toISOString(),
    fim: fimJS.toISOString(),
    diaInteiro,
    local,
    link,
    categoria: null,
    categoriasIcs,
    status: mapStatus(statusRaw),
    recorrente: !!recorrente,
  };

  evento.categoria = classificarEvento(evento);
  // Cancelamento real (STATUS:CANCELLED) ou "manual" — muitos organizadores
  // apenas prefixam o título ("Cancelado: ...", "Evento cancelado...") sem
  // atualizar o STATUS do ICS, então o título também é considerado.
  evento.cancelado =
    evento.status === "cancelado" ||
    contemAlgumaPalavra(normalizarTexto(titulo), ["cancelado", "cancelada"]);
  return evento;
}

function parseICSParaEventos(icsTexto) {
  const jcalData = ICAL.parse(icsTexto);
  const comp = new ICAL.Component(jcalData);

  // Registra os fusos horários (VTIMEZONE) definidos no calendário para que
  // ICAL.Time resolva corretamente horários locais antes de converter para UTC.
  comp.getAllSubcomponents("vtimezone").forEach((vt) => {
    try {
      ICAL.TimezoneService.register(vt);
    } catch (e) {
      console.warn("Falha ao registrar VTIMEZONE:", e);
    }
  });

  const veventComponents = comp.getAllSubcomponents("vevent");
  const todosEventos = veventComponents.map((vc) => new ICAL.Event(vc));

  // Separa eventos "mestre" de exceções (RECURRENCE-ID) e religa cada
  // exceção ao seu mestre via relateException — isso faz o iterator()
  // aplicar automaticamente os overrides (inclusive cancelamentos pontuais).
  const mestres = new Map();
  const excecoesOrfas = [];

  todosEventos.forEach((ev) => {
    if (ev.isRecurrenceException()) {
      return;
    }
    mestres.set(ev.uid, ev);
  });

  todosEventos.forEach((ev) => {
    if (!ev.isRecurrenceException()) return;
    const mestre = mestres.get(ev.uid);
    if (mestre) {
      try {
        mestre.relateException(ev.component);
      } catch (e) {
        console.warn("Falha ao relacionar exceção de recorrência:", e);
        excecoesOrfas.push(ev);
      }
    } else {
      excecoesOrfas.push(ev);
    }
  });

  const agora = new Date();
  const janelaInicio = new Date(agora);
  janelaInicio.setMonth(janelaInicio.getMonth() - JANELA_MESES_PASSADO);
  const janelaFim = new Date(agora);
  janelaFim.setMonth(janelaFim.getMonth() + JANELA_MESES_FUTURO);

  const ocorrencias = [];

  mestres.forEach((event) => {
    if (event.isRecurring()) {
      const iterator = event.iterator();
      let next;
      let contagem = 0;
      // eslint-disable-next-line no-cond-assign
      while ((next = iterator.next()) && contagem < MAX_OCORRENCIAS_POR_EVENTO) {
        contagem++;
        const dataOcorrencia = next.toJSDate();
        if (dataOcorrencia > janelaFim) break;
        if (dataOcorrencia < janelaInicio) continue;

        const detalhes = event.getOccurrenceDetails(next);
        ocorrencias.push(
          construirOcorrencia(detalhes.item, detalhes.startDate, detalhes.endDate, true)
        );
      }
    } else {
      const inicioJS = event.startDate.toJSDate();
      const fimJS = (event.endDate || event.startDate).toJSDate();
      if (fimJS >= janelaInicio && inicioJS <= janelaFim) {
        ocorrencias.push(construirOcorrencia(event, event.startDate, event.endDate, false));
      }
    }
  });

  excecoesOrfas.forEach((ev) => {
    const inicioJS = ev.startDate.toJSDate();
    const fimJS = (ev.endDate || ev.startDate).toJSDate();
    if (fimJS >= janelaInicio && inicioJS <= janelaFim) {
      ocorrencias.push(construirOcorrencia(ev, ev.startDate, ev.endDate, true));
    }
  });

  ocorrencias.sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
  return ocorrencias;
}

/* ==========================================================================
   BUSCA DOS DADOS (fetch direto → fallback via proxy) + CACHE LOCAL
   ========================================================================== */

async function buscarIcsTexto() {
  if (USE_DEMO_DATA) {
    return DEMO_ICS;
  }

  try {
    const resposta = await fetch(CALENDAR_ICS_URL, { mode: "cors", cache: "no-store" });
    if (!resposta.ok) throw new Error("HTTP " + resposta.status);
    return await resposta.text();
  } catch (erroDireto) {
    console.warn("Fetch direto ao Outlook falhou (provável bloqueio de CORS):", erroDireto);
  }

  const respostaProxy = await fetch(CALENDAR_API_URL, { cache: "no-store" });
  if (!respostaProxy.ok) {
    throw new Error("HTTP " + respostaProxy.status + " ao buscar via " + CALENDAR_API_URL);
  }
  return await respostaProxy.text();
}

function salvarCache(eventos) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ savedAt: new Date().toISOString(), events: eventos })
    );
  } catch (e) {
    console.warn("Não foi possível salvar o cache local:", e);
  }
}

function carregarCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.events)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

/* ==========================================================================
   CONFLITOS, STATUS DE TEMPO (em andamento / concluído)
   ========================================================================== */

function marcarConflitos(eventos) {
  eventos.forEach((e) => (e.conflito = false));

  const comHorario = eventos.filter((e) => !e.diaInteiro);
  const porDia = new Map();
  comHorario.forEach((e) => {
    const chave = chaveDia(new Date(e.inicio));
    if (!porDia.has(chave)) porDia.set(chave, []);
    porDia.get(chave).push(e);
  });

  porDia.forEach((lista) => {
    lista.sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
    for (let i = 0; i < lista.length; i++) {
      for (let j = i + 1; j < lista.length; j++) {
        const a = lista[i];
        const b = lista[j];
        const inicioA = new Date(a.inicio).getTime();
        const fimA = new Date(a.fim).getTime();
        const inicioB = new Date(b.inicio).getTime();
        if (inicioB >= fimA) break;
        if (inicioB < fimA && inicioA < new Date(b.fim).getTime()) {
          a.conflito = true;
          b.conflito = true;
        }
      }
    }
  });
}

function situacaoTemporal(evento) {
  const agora = Date.now();
  const inicio = new Date(evento.inicio).getTime();
  const fim = new Date(evento.fim).getTime();
  if (fim < agora) return "concluido";
  if (inicio <= agora && agora <= fim) return "andamento";
  return "futuro";
}

/* ==========================================================================
   FILTROS
   ========================================================================== */

// Intervalo [início, fim] correspondente ao período selecionado, ou null
// para "todos" (sem restrição). Centralizado aqui para ser reaproveitado
// tanto na decisão de inclusão do evento quanto no recorte dos dias
// exibidos de compromissos de vários dias (ver agruparPorDia).
function janelaDoPeriodo(periodo) {
  if (periodo === "todos") return null;

  const agora = new Date();
  if (periodo === "dia") return { inicio: inicioDoDia(agora), fim: fimDoDia(agora) };
  if (periodo === "semana") return { inicio: segundaDaSemana(agora), fim: domingoDaSemana(agora) };
  if (periodo === "mes") return { inicio: inicioDoMes(agora), fim: fimDoMes(agora) };
  return null;
}

function eventoNoPeriodo(evento, periodo) {
  const janela = janelaDoPeriodo(periodo);
  if (!janela) return true;

  const inicioEvento = new Date(evento.inicio).getTime();
  const fimEvento = new Date(evento.fim).getTime();

  // Interseção de intervalos — cobre eventos que atravessam mais de um dia.
  return inicioEvento <= janela.fim.getTime() && fimEvento >= janela.inicio.getTime();
}

function eventoNoIntervaloDeData(evento, dataInicio, dataFim) {
  if (!dataInicio && !dataFim) return true;

  const inicioEvento = new Date(evento.inicio).getTime();
  const fimEvento = new Date(evento.fim).getTime();

  const inicioFiltro = dataInicio
    ? new Date(`${dataInicio}T00:00:00${offsetBahia()}`).getTime()
    : -Infinity;
  const fimFiltro = dataFim
    ? new Date(`${dataFim}T23:59:59.999${offsetBahia()}`).getTime()
    : Infinity;

  return inicioEvento <= fimFiltro && fimEvento >= inicioFiltro;
}

function obterEventosFiltrados() {
  const { periodo, categorias, busca, mostrarConcluidos, dataInicio, dataFim } = state.filtros;
  const buscaNormalizada = normalizarTexto(busca);

  return state.eventos.filter((evento) => {
    // Nenhuma categoria marcada = nenhum filtro de categoria ativo (mostra tudo).
    if (categorias.size > 0 && !categorias.has(evento.categoria)) return false;
    if (!eventoNoPeriodo(evento, periodo)) return false;
    if (!eventoNoIntervaloDeData(evento, dataInicio, dataFim)) return false;

    if (!mostrarConcluidos && situacaoTemporal(evento) === "concluido") return false;

    if (buscaNormalizada) {
      const alvo = normalizarTexto(`${evento.titulo} ${evento.descricao} ${evento.local}`);
      if (!alvo.includes(buscaNormalizada)) return false;
    }

    return true;
  });
}

/* ==========================================================================
   RENDERIZAÇÃO
   ========================================================================== */

const CATEGORIA_LABEL = {
  viagem: "Viagem",
  mestrado: "Mestrado",
  "pauta-online": "Pauta online",
  "pauta-presencial": "Pauta presencial",
};

// Todas as chaves "YYYY-MM-DD" que um compromisso atravessa (do dia de
// início ao dia de fim, inclusive). Compromissos de um único dia retornam
// apenas uma chave — usado para que compromissos de vários dias (viagens,
// módulos de mestrado etc.) apareçam na agenda de cada dia que ocupam, não
// somente no dia em que começam.
const LIMITE_DIAS_ABRANGIDOS = 90; // proteção contra datas malformadas no ICS

function diasQueEventoAbrange(evento) {
  const inicioChave = chaveDia(new Date(evento.inicio));
  const fimChave = chaveDia(new Date(evento.fim));
  if (inicioChave === fimChave) return [inicioChave];

  const dias = [];
  let cursor = inicioDoDia(new Date(evento.inicio));
  const fimCursor = inicioDoDia(new Date(evento.fim)).getTime();
  let contador = 0;
  while (cursor.getTime() <= fimCursor && contador < LIMITE_DIAS_ABRANGIDOS) {
    dias.push(chaveDia(cursor));
    const proximo = new Date(cursor);
    proximo.setUTCDate(proximo.getUTCDate() + 1);
    cursor = proximo;
    contador++;
  }
  return dias;
}

function eventoEhContinuo(evento) {
  return chaveDia(new Date(evento.inicio)) !== chaveDia(new Date(evento.fim));
}

// Janela de dias atualmente visível na tela (interseção do período
// selecionado com o filtro manual de datas "De"/"Até"), como chaves
// "YYYY-MM-DD". Retorna null nos limites em que não há restrição (ex.:
// período "Todos" sem filtro de data manual). Usada para recortar quais
// dias de um compromisso de vários dias devem ser exibidos — sem isso, um
// compromisso que só passa perto do período filtrado (ex.: começa antes do
// intervalo "De"/"Até" escolhido) reapareceria em dias fora do filtro.
function janelaDeExibicaoAtual() {
  const { periodo, dataInicio, dataFim } = state.filtros;
  const janelaPeriodo = janelaDoPeriodo(periodo);

  let inicioChave = janelaPeriodo ? chaveDia(janelaPeriodo.inicio) : null;
  let fimChave = janelaPeriodo ? chaveDia(janelaPeriodo.fim) : null;

  if (dataInicio && (!inicioChave || dataInicio > inicioChave)) inicioChave = dataInicio;
  if (dataFim && (!fimChave || dataFim < fimChave)) fimChave = dataFim;

  return { inicioChave, fimChave };
}

function agruparPorDia(eventos) {
  const { inicioChave, fimChave } = janelaDeExibicaoAtual();
  const grupos = new Map();
  eventos.forEach((evento) => {
    diasQueEventoAbrange(evento)
      .filter((chave) => (!inicioChave || chave >= inicioChave) && (!fimChave || chave <= fimChave))
      .forEach((chave) => {
        if (!grupos.has(chave)) grupos.set(chave, []);
        grupos.get(chave).push({ evento, diaChave: chave });
      });
  });

  return Array.from(grupos.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([chave, lista]) => ({
      chave,
      rotulo: formatarDataLonga(new Date(`${chave}T12:00:00${offsetBahia()}`)),
      eventos: lista.sort((a, b) => new Date(a.evento.inicio) - new Date(b.evento.inicio)),
    }));
}

function duracaoLegivel(evento) {
  const ms = new Date(evento.fim) - new Date(evento.inicio);
  const minutos = Math.round(ms / 60000);
  if (evento.diaInteiro) {
    const dias = Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)));
    return dias > 1 ? `${dias} dias` : "dia inteiro";
  }
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return resto ? `${horas}h${String(resto).padStart(2, "0")}` : `${horas}h`;
}

function formatarDataCurta(date) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: DISPLAY_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}

// Horário exibido no bloco de tempo do cartão (linha do tempo), ajustado ao
// dia específico dentro do intervalo — nos dias intermediários e no dia
// final de um compromisso de vários dias, o horário "bruto" de início/fim
// do evento não faz sentido isolado, então cada dia mostra a informação
// relevante para si.
function tempoCartaoPorDia(evento, diaChave) {
  if (evento.diaInteiro) {
    return { horaInicio: "Dia inteiro", horaFim: duracaoLegivel(evento) };
  }
  if (!eventoEhContinuo(evento)) {
    return {
      horaInicio: formatarHora(new Date(evento.inicio)),
      horaFim: `até ${formatarHora(new Date(evento.fim))}`,
    };
  }

  const diaInicioChave = chaveDia(new Date(evento.inicio));
  const diaFimChave = chaveDia(new Date(evento.fim));
  if (diaChave === diaInicioChave) {
    return { horaInicio: formatarHora(new Date(evento.inicio)), horaFim: "continua no(s) dia(s) seguinte(s)" };
  }
  if (diaChave === diaFimChave) {
    return { horaInicio: "Continuação", horaFim: `até ${formatarHora(new Date(evento.fim))}` };
  }
  return { horaInicio: "Dia inteiro", horaFim: "compromisso contínuo" };
}

// Equivalente resumido em uma linha só, usado nas exportações (PDF/JPEG/texto).
function horarioResumoPorDia(evento, diaChave) {
  if (evento.diaInteiro) return "Dia inteiro";
  if (!eventoEhContinuo(evento)) {
    return `${formatarHora(new Date(evento.inicio))} – ${formatarHora(new Date(evento.fim))}`;
  }

  const diaInicioChave = chaveDia(new Date(evento.inicio));
  const diaFimChave = chaveDia(new Date(evento.fim));
  if (diaChave === diaInicioChave) return `A partir das ${formatarHora(new Date(evento.inicio))}`;
  if (diaChave === diaFimChave) return `Até às ${formatarHora(new Date(evento.fim))}`;
  return "Dia inteiro (contínuo)";
}

function criarCardElemento(evento, diaChave) {
  const situacao = situacaoTemporal(evento);
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.eventoId = evento.id;
  if (situacao === "andamento") card.classList.add("card--em-andamento");
  if (situacao === "concluido") card.classList.add("card--concluido");
  if (evento.cancelado) card.classList.add("card--cancelado");
  if (evento.conflito && situacao !== "concluido") card.classList.add("card--conflito");

  const continuo = eventoEhContinuo(evento);
  const { horaInicio, horaFim } = tempoCartaoPorDia(evento, diaChave);

  const badges = [];
  if (situacao === "andamento") badges.push(`<span class="badge badge--agora">● Agora</span>`);
  badges.push(`<span class="badge badge--${evento.categoria}">${CATEGORIA_LABEL[evento.categoria]}</span>`);
  if (continuo) {
    badges.push(
      `<span class="badge badge--continuo">📅 ${formatarDataCurta(new Date(evento.inicio))}–${formatarDataCurta(new Date(evento.fim))}</span>`
    );
  }
  if (evento.recorrente) badges.push(`<span class="badge badge--recorrente">Recorrente</span>`);
  if (situacao === "concluido") badges.push(`<span class="badge badge--concluido">Concluído</span>`);
  if (evento.conflito && situacao !== "concluido") {
    badges.push(`<span class="badge badge--conflito">⚠ Conflito de horário</span>`);
  }

  card.innerHTML = `
    ${evento.cancelado ? `<div class="card__banner-cancelado">⚠ Compromisso cancelado</div>` : ""}
    <div class="card__linha">
      <div class="card__tempo">
        <span class="card__hora-inicio">${horaInicio}</span>
        <span class="card__hora-fim">${horaFim}</span>
      </div>
      <div class="card__conteudo">
        <div class="card__titulo-linha">
          <h3 class="card__titulo">${escapeHtml(evento.titulo)}</h3>
          <span class="card__badges">${badges.join("")}</span>
        </div>
        <div class="card__meta">
          <span>⏱ ${duracaoLegivel(evento)}</span>
          ${evento.local ? `<span>📍 ${escapeHtml(evento.local)}</span>` : ""}
        </div>
        ${evento.descricao ? `<p class="card__descricao">${escapeHtml(evento.descricao)}</p>` : ""}
        <div class="card__rodape">
          ${evento.link ? `<a class="card__link" href="${escapeAttr(evento.link)}" target="_blank" rel="noopener">🔗 Entrar na reunião</a>` : ""}
          <button class="card__detalhes-btn" type="button" data-abrir-detalhes="${escapeAttr(evento.id)}">Ver detalhes</button>
        </div>
      </div>
    </div>
  `;

  return card;
}

function escapeHtml(str) {
  return (str || "")
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

function preencherTimeline(filtrados) {
  const container = document.getElementById("timeline");
  const vazio = document.getElementById("timeline-vazio");

  container.innerHTML = "";

  if (filtrados.length === 0) {
    vazio.hidden = false;
    return;
  }
  vazio.hidden = true;

  const grupos = agruparPorDia(filtrados);
  grupos.forEach((grupo) => {
    const grupoEl = document.createElement("div");
    grupoEl.className = "timeline__grupo";

    const dataEl = document.createElement("div");
    dataEl.className = "timeline__data";
    dataEl.textContent = grupo.rotulo;
    grupoEl.appendChild(dataEl);

    const listaEl = document.createElement("div");
    listaEl.className = "timeline__lista";
    grupo.eventos.forEach(({ evento, diaChave }) => listaEl.appendChild(criarCardElemento(evento, diaChave)));
    grupoEl.appendChild(listaEl);

    container.appendChild(grupoEl);
  });
}

// Placeholders animados exibidos apenas na primeira carga (sem cache local
// disponível ainda) para reduzir a sensação de espera enquanto o ICS é buscado.
function mostrarEsqueletos(quantidade) {
  const container = document.getElementById("timeline");
  const vazio = document.getElementById("timeline-vazio");
  vazio.hidden = true;
  container.innerHTML = "";

  for (let i = 0; i < quantidade; i++) {
    const card = document.createElement("div");
    card.className = "skeleton-card";
    card.innerHTML = `
      <div class="skeleton-linha skeleton-card__tempo"></div>
      <div class="skeleton-card__conteudo">
        <div class="skeleton-linha skeleton-card__titulo"></div>
        <div class="skeleton-linha skeleton-card__meta"></div>
        <div class="skeleton-linha skeleton-card__descricao"></div>
      </div>
    `;
    container.appendChild(card);
  }
}

/* ==========================================================================
   DASHBOARD (INDICADORES)
   ========================================================================== */

function renderizarDashboard(filtrados) {
  const agora = new Date();
  const hojeInicio = inicioDoDia(agora).getTime();
  const hojeFim = fimDoDia(agora).getTime();

  let contagemAndamento = 0;
  let contagemProximos = 0;
  let contagemConcluidos = 0;
  let conflitosAtivos = 0;

  state.eventos.forEach((evento) => {
    const inicio = new Date(evento.inicio).getTime();
    const fim = new Date(evento.fim).getTime();
    if (inicio <= hojeFim && fim >= hojeInicio) {
      const situacao = situacaoTemporal(evento);
      if (situacao === "andamento") contagemAndamento++;
      else if (situacao === "futuro") contagemProximos++;
      else if (situacao === "concluido") contagemConcluidos++;
    }
    if (evento.conflito && situacaoTemporal(evento) !== "concluido") conflitosAtivos++;
  });

  document.getElementById("stat-andamento").textContent = contagemAndamento;
  document.getElementById("stat-proximos").textContent = contagemProximos;
  document.getElementById("stat-concluidos").textContent = contagemConcluidos;

  document.getElementById("page-title").textContent = PERIODO_TITULO[state.filtros.periodo] || "Agenda";

  const alerta = document.getElementById("conflict-alert");
  const detalhe = document.getElementById("conflict-alert-detalhe");
  if (conflitosAtivos > 0) {
    detalhe.textContent = `${conflitosAtivos} compromisso${conflitosAtivos === 1 ? "" : "s"} sobreposto${conflitosAtivos === 1 ? "" : "s"} na agenda.`;
    alerta.hidden = false;
  } else {
    alerta.hidden = true;
  }
}

/* ==========================================================================
   FILTROS ATIVOS REMOVÍVEIS
   ========================================================================== */

const PERIODO_LABEL = { todos: "Todos", dia: "Hoje", semana: "Esta semana", mes: "Este mês" };
const PERIODO_TITULO = { todos: "Agenda — todos os compromissos", dia: "Agenda de Hoje", semana: "Agenda da Semana", mes: "Agenda do Mês" };

function sincronizarChipsPeriodo() {
  document.querySelectorAll("#periodo-group .chip").forEach((chip) => {
    chip.classList.toggle("is-active", chip.dataset.periodo === state.filtros.periodo);
  });
}

function sincronizarChipsCategoria() {
  document.querySelectorAll("#categoria-group .chip").forEach((chip) => {
    chip.classList.toggle("is-active", state.filtros.categorias.has(chip.dataset.categoria));
  });
}

function limparFiltroDeData() {
  state.filtros.dataInicio = null;
  state.filtros.dataFim = null;
  document.getElementById("filtro-data-inicio").value = "";
  document.getElementById("filtro-data-fim").value = "";
  document.getElementById("btn-limpar-datas").hidden = true;
  esconderErroData();
}

function mostrarErroData(mensagem) {
  const erroEl = document.getElementById("erro-data");
  erroEl.textContent = mensagem;
  erroEl.hidden = false;
  document.getElementById("filtro-data-inicio").setAttribute("aria-invalid", "true");
  document.getElementById("filtro-data-fim").setAttribute("aria-invalid", "true");
}

function esconderErroData() {
  document.getElementById("erro-data").hidden = true;
  document.getElementById("filtro-data-inicio").removeAttribute("aria-invalid");
  document.getElementById("filtro-data-fim").removeAttribute("aria-invalid");
}

function limparTodosFiltros() {
  state.filtros.periodo = "dia";
  state.filtros.categorias = new Set();
  state.filtros.busca = "";
  state.filtros.mostrarConcluidos = true;
  document.getElementById("busca").value = "";
  document.getElementById("mostrar-concluidos").checked = true;
  limparFiltroDeData();
  sincronizarChipsPeriodo();
  sincronizarChipsCategoria();
  renderizarConteudo();
}

function renderizarFiltrosAtivos() {
  const { periodo, categorias, busca, dataInicio, dataFim, mostrarConcluidos } = state.filtros;
  const container = document.getElementById("active-filters");
  const lista = document.getElementById("active-filters-lista");
  const tags = [];

  if (periodo !== "dia") {
    tags.push({
      label: `Período: ${PERIODO_LABEL[periodo]}`,
      remover: () => {
        state.filtros.periodo = "dia";
        sincronizarChipsPeriodo();
      },
    });
  }

  categorias.forEach((categoria) => {
    tags.push({
      label: CATEGORIA_LABEL[categoria],
      remover: () => {
        state.filtros.categorias.delete(categoria);
        sincronizarChipsCategoria();
      },
    });
  });

  if (dataInicio || dataFim) {
    tags.push({
      label: `Data: ${dataInicio || "…"} a ${dataFim || "…"}`,
      remover: () => limparFiltroDeData(),
    });
  }

  if (busca) {
    tags.push({
      label: `Busca: "${busca}"`,
      remover: () => {
        state.filtros.busca = "";
        document.getElementById("busca").value = "";
      },
    });
  }

  if (!mostrarConcluidos) {
    tags.push({
      label: "Ocultando concluídos",
      remover: () => {
        state.filtros.mostrarConcluidos = true;
        document.getElementById("mostrar-concluidos").checked = true;
      },
    });
  }

  container.hidden = tags.length === 0;
  lista.innerHTML = "";
  tags.forEach((tag) => {
    const el = document.createElement("span");
    el.className = "filter-tag";
    el.innerHTML = `<span>${escapeHtml(tag.label)}</span> <button type="button" aria-label="Remover filtro: ${escapeAttr(tag.label)}">×</button>`;
    el.querySelector("button").addEventListener("click", () => {
      tag.remover();
      renderizarConteudo();
    });
    lista.appendChild(el);
  });
}

/* ==========================================================================
   VISÃO EM TABELA (ordenação e paginação)
   ========================================================================== */

function compararEventosTabela(a, b, campo) {
  switch (campo) {
    case "titulo":
      return a.titulo.localeCompare(b.titulo, "pt-BR");
    case "categoria":
      return CATEGORIA_LABEL[a.categoria].localeCompare(CATEGORIA_LABEL[b.categoria], "pt-BR");
    case "local":
      return (a.local || "").localeCompare(b.local || "", "pt-BR");
    case "status":
      return situacaoTemporal(a).localeCompare(situacaoTemporal(b), "pt-BR");
    case "horario":
    case "data":
    default:
      return new Date(a.inicio) - new Date(b.inicio);
  }
}

function rotuloStatus(evento) {
  if (evento.cancelado) return "Cancelado";
  const situacao = situacaoTemporal(evento);
  if (situacao === "andamento") return "Em andamento";
  if (situacao === "concluido") return "Concluído";
  return "Agendado";
}

function preencherTabela(filtrados) {
  const corpo = document.getElementById("tabela-corpo");
  const infoPagina = document.getElementById("pagina-info");
  const btnAnterior = document.getElementById("btn-pagina-anterior");
  const btnProxima = document.getElementById("btn-pagina-proxima");

  document.querySelectorAll(".th-sort").forEach((btn) => {
    const ativo = btn.dataset.sort === state.ui.tabelaOrdenarPor;
    btn.classList.toggle("is-ativo", ativo);
    const icone = btn.querySelector(".th-sort__icon");
    icone.textContent = ativo ? (state.ui.tabelaOrdemAsc ? "↑" : "↓") : "↕";
  });

  const ordenados = [...filtrados].sort((a, b) => {
    const resultado = compararEventosTabela(a, b, state.ui.tabelaOrdenarPor);
    return state.ui.tabelaOrdemAsc ? resultado : -resultado;
  });

  const porPagina = state.ui.tabelaPorPagina;
  const totalPaginas = Math.max(1, Math.ceil(ordenados.length / porPagina));
  if (state.ui.tabelaPagina > totalPaginas) state.ui.tabelaPagina = totalPaginas;
  if (state.ui.tabelaPagina < 1) state.ui.tabelaPagina = 1;

  const inicioIdx = (state.ui.tabelaPagina - 1) * porPagina;
  const pagina = ordenados.slice(inicioIdx, inicioIdx + porPagina);

  corpo.innerHTML = "";

  if (pagina.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="7" style="text-align:center;color:var(--color-text-secondary);padding:24px;">Nenhum compromisso encontrado para os filtros selecionados.</td>`;
    corpo.appendChild(tr);
  }

  pagina.forEach((evento) => {
    const tr = document.createElement("tr");
    const horario = evento.diaInteiro
      ? "Dia inteiro"
      : `${formatarHora(new Date(evento.inicio))} – ${formatarHora(new Date(evento.fim))}`;
    const dataFormatada = new Intl.DateTimeFormat("pt-BR", {
      timeZone: DISPLAY_TIMEZONE,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date(evento.inicio));

    tr.innerHTML = `
      <td>${dataFormatada}</td>
      <td>${horario}</td>
      <td class="td-titulo">${escapeHtml(evento.titulo)}</td>
      <td><span class="badge badge--${evento.categoria}">${CATEGORIA_LABEL[evento.categoria]}</span></td>
      <td class="td-local">${escapeHtml(evento.local || "—")}</td>
      <td>${rotuloStatus(evento)}</td>
      <td><button class="btn btn--tiny-outline" type="button" data-abrir-detalhes="${escapeAttr(evento.id)}">Detalhes</button></td>
    `;
    corpo.appendChild(tr);
  });

  infoPagina.textContent = `Página ${state.ui.tabelaPagina} de ${totalPaginas} (${ordenados.length} compromisso${ordenados.length === 1 ? "" : "s"})`;
  btnAnterior.disabled = state.ui.tabelaPagina <= 1;
  btnProxima.disabled = state.ui.tabelaPagina >= totalPaginas;
}

function atualizarVisibilidadeVista() {
  const timelineEl = document.getElementById("vista-timeline");
  const tabelaEl = document.getElementById("vista-tabela");
  const btnTimeline = document.getElementById("btn-vista-timeline");
  const btnTabela = document.getElementById("btn-vista-tabela");
  const emTabela = state.ui.vista === "tabela";

  timelineEl.hidden = emTabela;
  tabelaEl.hidden = !emTabela;
  btnTimeline.classList.toggle("is-active", !emTabela);
  btnTabela.classList.toggle("is-active", emTabela);
}

/* ==========================================================================
   DISPARADOR CENTRAL DE RENDERIZAÇÃO
   ========================================================================== */

function renderizarConteudo() {
  const filtrados = obterEventosFiltrados();
  document.getElementById("filtros-resumo").textContent =
    `${filtrados.length} compromisso${filtrados.length === 1 ? "" : "s"}`;

  preencherTimeline(filtrados);
  preencherTabela(filtrados);
  renderizarDashboard(filtrados);
  renderizarFiltrosAtivos();
  atualizarVisibilidadeVista();
}

/* ==========================================================================
   PAINEL LATERAL DE DETALHES
   ========================================================================== */

let elementoComFocoAntesDoPainel = null;

function abrirPainelDetalhes(eventoId) {
  const evento = state.eventos.find((e) => e.id === eventoId);
  if (!evento) return;

  elementoComFocoAntesDoPainel = document.activeElement;

  const situacao = situacaoTemporal(evento);
  const continuo = eventoEhContinuo(evento);
  const horario = evento.diaInteiro
    ? "Dia inteiro"
    : `${formatarHora(new Date(evento.inicio))} – ${formatarHora(new Date(evento.fim))}`;
  const dataHorarioTexto = continuo
    ? `${formatarDataLonga(new Date(evento.inicio))} (${formatarHora(new Date(evento.inicio))}) até ${formatarDataLonga(new Date(evento.fim))} (${formatarHora(new Date(evento.fim))})`
    : `${formatarDataLonga(new Date(evento.inicio))} — ${horario}`;

  const badges = [];
  if (situacao === "andamento") badges.push(`<span class="badge badge--agora">● Agora</span>`);
  badges.push(`<span class="badge badge--${evento.categoria}">${CATEGORIA_LABEL[evento.categoria]}</span>`);
  if (continuo) {
    badges.push(
      `<span class="badge badge--continuo">📅 ${formatarDataCurta(new Date(evento.inicio))}–${formatarDataCurta(new Date(evento.fim))}</span>`
    );
  }
  if (evento.recorrente) badges.push(`<span class="badge badge--recorrente">Recorrente</span>`);
  if (evento.cancelado) badges.push(`<span class="badge badge--cancelado">Cancelado</span>`);
  if (situacao === "concluido") badges.push(`<span class="badge badge--concluido">Concluído</span>`);
  if (evento.conflito && situacao !== "concluido") {
    badges.push(`<span class="badge badge--conflito">⚠ Conflito de horário</span>`);
  }

  document.getElementById("detail-panel-titulo").textContent = evento.titulo;
  document.getElementById("detail-panel-corpo").innerHTML = `
    <div class="detail-panel__badges">${badges.join("")}</div>
    <div class="detail-panel__linha">
      <span class="detail-panel__linha-rotulo">Data e horário</span>
      <span class="detail-panel__linha-valor">${dataHorarioTexto} (${duracaoLegivel(evento)})</span>
    </div>
    ${evento.local ? `<div class="detail-panel__linha"><span class="detail-panel__linha-rotulo">Local</span><span class="detail-panel__linha-valor">${escapeHtml(evento.local)}</span></div>` : ""}
    ${evento.descricao ? `<div class="detail-panel__linha"><span class="detail-panel__linha-rotulo">Descrição</span><span class="detail-panel__linha-valor">${escapeHtml(evento.descricao)}</span></div>` : ""}
    ${evento.link ? `<a class="detail-panel__link" href="${escapeAttr(evento.link)}" target="_blank" rel="noopener">🔗 Entrar na reunião</a>` : ""}
  `;

  const painel = document.getElementById("detail-panel");
  const backdrop = document.getElementById("panel-backdrop");
  painel.setAttribute("aria-hidden", "false");
  backdrop.hidden = false;
  setTimeout(() => painel.classList.add("is-aberto"), 0);
  document.getElementById("btn-fechar-painel").focus();
}

function fecharPainelDetalhes() {
  const painel = document.getElementById("detail-panel");
  const backdrop = document.getElementById("panel-backdrop");
  if (painel.getAttribute("aria-hidden") === "true") return;

  painel.classList.remove("is-aberto");
  backdrop.hidden = true;
  setTimeout(() => painel.setAttribute("aria-hidden", "true"), 200);

  if (elementoComFocoAntesDoPainel && document.contains(elementoComFocoAntesDoPainel)) {
    elementoComFocoAntesDoPainel.focus();
  }
}

/* ==========================================================================
   MODAL DE CONFIRMAÇÃO (ações críticas / exportações grandes)
   ========================================================================== */

function confirmarAcao(mensagem, titulo) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const backdrop = document.getElementById("confirm-backdrop");
    document.getElementById("confirm-titulo").textContent = titulo || "Confirmar ação";
    document.getElementById("confirm-mensagem").textContent = mensagem;

    const elementoAnterior = document.activeElement;
    modal.hidden = false;
    backdrop.hidden = false;

    const btnCancelar = document.getElementById("confirm-cancelar");
    const btnContinuar = document.getElementById("confirm-continuar");
    btnContinuar.focus();

    function limpar(resultado) {
      modal.hidden = true;
      backdrop.hidden = true;
      btnCancelar.removeEventListener("click", aoCancelar);
      btnContinuar.removeEventListener("click", aoContinuar);
      if (elementoAnterior && document.contains(elementoAnterior)) elementoAnterior.focus();
      resolve(resultado);
    }
    function aoCancelar() {
      limpar(false);
    }
    function aoContinuar() {
      limpar(true);
    }

    btnCancelar.addEventListener("click", aoCancelar);
    btnContinuar.addEventListener("click", aoContinuar);
  });
}

/* ==========================================================================
   TEMA CLARO/ESCURO
   ========================================================================== */

const TEMA_STORAGE_KEY = "agendaSisd.tema";

function sistemaPrefereTemaEscuro() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// tema: "dark" | "light" | null (null = segue a preferência do sistema).
function aplicarTema(tema) {
  if (tema === "dark" || tema === "light") {
    document.documentElement.setAttribute("data-theme", tema);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }

  const efetivoEscuro = tema ? tema === "dark" : sistemaPrefereTemaEscuro();

  const btn = document.getElementById("btn-tema");
  if (btn) btn.setAttribute("aria-pressed", String(efetivoEscuro));

  const metaTema = document.getElementById("meta-theme-color");
  if (metaTema) metaTema.setAttribute("content", efetivoEscuro ? "#0B2545" : "#061A35");
}

function alternarTema() {
  const efetivoEscuro = document.documentElement.getAttribute("data-theme")
    ? document.documentElement.getAttribute("data-theme") === "dark"
    : sistemaPrefereTemaEscuro();
  const novoTema = efetivoEscuro ? "light" : "dark";

  aplicarTema(novoTema);
  try {
    localStorage.setItem(TEMA_STORAGE_KEY, novoTema);
  } catch (e) {
    /* ignora */
  }
}

function inicializarTema() {
  let salvo = null;
  try {
    salvo = localStorage.getItem(TEMA_STORAGE_KEY);
  } catch (e) {
    /* ignora */
  }
  aplicarTema(salvo);

  // Sem preferência salva, acompanha mudanças ao vivo na preferência do
  // sistema (ex.: o SO alterna para modo escuro ao anoitecer).
  if (!salvo && window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      let aindaSemPreferencia = true;
      try {
        aindaSemPreferencia = !localStorage.getItem(TEMA_STORAGE_KEY);
      } catch (e) {
        /* ignora */
      }
      if (aindaSemPreferencia) aplicarTema(null);
    });
  }
}

/* ==========================================================================
   SIDEBAR: DRAWER MOBILE E COLAPSO NO DESKTOP
   ========================================================================== */

function abrirSidebarMobile() {
  state.ui.sidebarAberta = true;
  document.getElementById("app-shell").classList.add("is-sidebar-aberta");
  document.getElementById("sidebar-backdrop").hidden = false;
  document.getElementById("btn-menu").setAttribute("aria-expanded", "true");
  document.body.style.overflow = "hidden";
}

function fecharSidebarMobile() {
  state.ui.sidebarAberta = false;
  document.getElementById("app-shell").classList.remove("is-sidebar-aberta");
  document.getElementById("sidebar-backdrop").hidden = true;
  document.getElementById("btn-menu").setAttribute("aria-expanded", "false");
  document.body.style.overflow = "";
}

function alternarSidebarDesktop() {
  state.ui.sidebarRecolhida = !state.ui.sidebarRecolhida;
  document.getElementById("app-shell").classList.toggle("is-sidebar-recolhida", state.ui.sidebarRecolhida);
  document.getElementById("btn-recolher-sidebar").setAttribute("aria-expanded", String(!state.ui.sidebarRecolhida));
  try {
    localStorage.setItem(SIDEBAR_RECOLHIDA_STORAGE_KEY, state.ui.sidebarRecolhida ? "1" : "0");
  } catch (e) {
    /* ignora */
  }
}

function renderizarUltimaAtualizacao() {
  const el = document.getElementById("ultima-atualizacao");
  el.textContent = state.ultimaAtualizacao ? formatarDataHora(state.ultimaAtualizacao) : "—";
}

function definirCarregando(valor) {
  state.carregando = valor;
  document.getElementById("status-loading").hidden = !valor;
  document.getElementById("btn-atualizar").disabled = valor;
}

function limparMensagens() {
  document.getElementById("status-success").hidden = true;
  document.getElementById("status-error").hidden = true;
  document.getElementById("status-cache").hidden = true;
}

function mostrarSucesso() {
  limparMensagens();
  document.getElementById("status-success").hidden = false;
  setTimeout(() => {
    document.getElementById("status-success").hidden = true;
  }, 4000);
}

function mostrarErro(erro) {
  limparMensagens();
  document.getElementById("status-error-msg").textContent =
    "Não foi possível atualizar a agenda: " + (erro && erro.message ? erro.message : "erro desconhecido");
  document.getElementById("status-error").hidden = false;
}

function mostrarAvisoCache() {
  document.getElementById("status-cache").hidden = false;
}

function renderizarTudo() {
  renderizarConteudo();
  renderizarUltimaAtualizacao();
}

/* ==========================================================================
   CICLO DE ATUALIZAÇÃO
   ========================================================================== */

async function atualizarAgenda() {
  definirCarregando(true);
  limparMensagens();
  // Só mostra o esqueleto na carga inicial (sem nada em tela ainda) — em
  // atualizações seguintes é melhor manter os dados já exibidos até a
  // resposta chegar, em vez de "piscar" a tela.
  if (state.eventos.length === 0) mostrarEsqueletos(3);

  try {
    const icsTexto = await buscarIcsTexto();
    const eventos = parseICSParaEventos(icsTexto);
    marcarConflitos(eventos);

    state.eventos = eventos;
    state.usandoCache = false;
    state.ultimaAtualizacao = new Date();

    salvarCache(eventos);
    renderizarTudo();
    mostrarSucesso();
  } catch (erro) {
    console.error("Erro ao atualizar agenda:", erro);
    mostrarErro(erro);

    const cache = carregarCache();
    if (cache) {
      marcarConflitos(cache.events);
      state.eventos = cache.events;
      state.usandoCache = true;
      state.ultimaAtualizacao = new Date(cache.savedAt);
      renderizarTudo();
      mostrarAvisoCache();
    } else {
      // Sem cache para exibir: substitui os esqueletos de carregamento pelo
      // estado vazio real, em vez de deixá-los "girando" indefinidamente.
      renderizarTudo();
    }
  } finally {
    definirCarregando(false);
  }
}

/* ==========================================================================
   EXPORTAÇÃO — PDF (jsPDF + html2canvas) e JPEG (html2canvas)
   ========================================================================== */

// Cores por categoria usadas no resumo minimalista das exportações — a cor
// já comunica visualmente se é viagem, mestrado, pauta online ou presencial,
// sem precisar de um segundo indicador redundante.
const CATEGORIA_CORES_EXPORT = {
  viagem: { borda: "#174D83", fundo: "#E9F1FA", texto: "#174D83" },
  mestrado: { borda: "#2E8B68", fundo: "#E6F4EE", texto: "#2E8B68" },
  "pauta-online": { borda: "#55A9E8", fundo: "#E7F3FD", texto: "#1F6FB0" },
  "pauta-presencial": { borda: "#D99A2B", fundo: "#FBF1DF", texto: "#B9821F" },
};

// Cartão de exportação minimalista: mostra somente horário, título e
// categoria (que já indica presencial/online/viagem). Sem descrição, link,
// local ou duração — o dia/data já aparecem no cabeçalho de cada grupo.
//
// Quando `detalhado` é true (exportação JPEG no formato mobile vertical), usa
// um layout empilhado que exibe todos os dados do compromisso — título,
// horário, duração, local, descrição e link — já que há espaço vertical de
// sobra e o objetivo é uma agenda completa para consulta no celular.
function construirCardExportacao(evento, diaChave, detalhado) {
  if (detalhado) return construirCardExportacaoDetalhado(evento, diaChave);

  const cores = CATEGORIA_CORES_EXPORT[evento.categoria] || CATEGORIA_CORES_EXPORT["pauta-presencial"];
  const corBorda = evento.cancelado ? "#C94B4B" : cores.borda;
  const div = document.createElement("div");
  div.style.cssText = `font-family:'Segoe UI', Arial, sans-serif; width:700px; padding:10px 16px; margin-bottom:8px; background:#fff; border:1px solid #DCE5EF; border-left:4px solid ${corBorda}; border-radius:8px;`;

  const continuo = eventoEhContinuo(evento);
  const horario = horarioResumoPorDia(evento, diaChave);

  // Pauta online: o link da reunião é informação essencial para participar,
  // então continua aparecendo mesmo no resumo minimalista.
  const mostrarLink = evento.categoria === "pauta-online" && !!evento.link;

  const bannerCancelado = evento.cancelado
    ? `<div style="background:#C94B4B;color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.3px;padding:5px 12px;margin:-10px -16px 8px;border-radius:6px 6px 0 0;">⚠ Compromisso cancelado</div>`
    : "";

  const estiloTitulo = evento.cancelado
    ? "flex:1;min-width:0;font-size:14px;font-weight:600;color:#607086;text-decoration:line-through;"
    : "flex:1;min-width:0;font-size:14px;font-weight:600;color:#10233C;";

  div.innerHTML = `
    ${bannerCancelado}
    <div style="display:flex;align-items:center;gap:14px;">
      <div style="min-width:118px;flex-shrink:0;font-size:12.5px;font-weight:700;color:#174D83;">${horario}</div>
      <div style="${estiloTitulo}">${escapeHtml(evento.titulo)}</div>
      <span style="flex-shrink:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.3px;padding:4px 10px;border-radius:999px;background:${cores.fundo};color:${cores.texto};white-space:nowrap;">${CATEGORIA_LABEL[evento.categoria] || ""}</span>
    </div>
    ${
      continuo
        ? `<div style="margin-top:4px;padding-left:132px;font-size:10.5px;color:#607086;">Compromisso de vários dias: ${formatarDataCurta(new Date(evento.inicio))} a ${formatarDataCurta(new Date(evento.fim))}</div>`
        : ""
    }
    ${mostrarLink ? `<div style="margin-top:6px;padding-left:132px;font-size:11.5px;color:#1F6FB0;word-break:break-all;">🔗 ${escapeHtml(evento.link)}</div>` : ""}
  `;

  return div;
}

// Cartão de exportação completo (mobile vertical): layout empilhado com todos
// os dados do compromisso.
function construirCardExportacaoDetalhado(evento, diaChave) {
  const cores = CATEGORIA_CORES_EXPORT[evento.categoria] || CATEGORIA_CORES_EXPORT["pauta-presencial"];
  const corBorda = evento.cancelado ? "#C94B4B" : cores.borda;
  const div = document.createElement("div");
  div.style.cssText = `font-family:'Segoe UI', Arial, sans-serif; width:100%; padding:12px 14px; margin-bottom:10px; background:#fff; border:1px solid #DCE5EF; border-left:4px solid ${corBorda}; border-radius:8px; box-sizing:border-box;`;

  const continuo = eventoEhContinuo(evento);
  const horario = horarioResumoPorDia(evento, diaChave);
  const duracao = duracaoLegivel(evento);
  const mostrarLink = evento.categoria === "pauta-online" && !!evento.link;

  const bannerCancelado = evento.cancelado
    ? `<div style="background:#C94B4B;color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.3px;padding:5px 12px;margin:-12px -14px 10px;border-radius:6px 6px 0 0;">⚠ Compromisso cancelado</div>`
    : "";

  const estiloTitulo = evento.cancelado
    ? "flex:1;min-width:0;font-size:15px;font-weight:700;line-height:1.3;color:#607086;text-decoration:line-through;"
    : "flex:1;min-width:0;font-size:15px;font-weight:700;line-height:1.3;color:#10233C;";

  const metas = [`<span>🕐 ${horario}</span>`, `<span>⏱ ${escapeHtml(duracao)}</span>`];
  if (evento.local) metas.push(`<span>📍 ${escapeHtml(evento.local)}</span>`);

  div.innerHTML = `
    ${bannerCancelado}
    <div style="display:flex;align-items:flex-start;gap:10px;">
      <div style="${estiloTitulo}">${escapeHtml(evento.titulo)}</div>
      <span style="flex-shrink:0;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.3px;padding:4px 9px;border-radius:999px;background:${cores.fundo};color:${cores.texto};white-space:nowrap;">${CATEGORIA_LABEL[evento.categoria] || ""}</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:7px;font-size:11.5px;color:#607086;">${metas.join("")}</div>
    ${
      continuo
        ? `<div style="margin-top:5px;font-size:11px;color:#0E7C86;font-weight:600;">📅 Compromisso de vários dias: ${formatarDataCurta(new Date(evento.inicio))} a ${formatarDataCurta(new Date(evento.fim))}</div>`
        : ""
    }
    ${
      evento.descricao
        ? `<div style="margin-top:8px;font-size:12px;line-height:1.5;color:#10233C;white-space:pre-line;">${escapeHtml(evento.descricao)}</div>`
        : ""
    }
    ${mostrarLink ? `<div style="margin-top:8px;font-size:11.5px;color:#1F6FB0;word-break:break-all;">🔗 ${escapeHtml(evento.link)}</div>` : ""}
  `;

  return div;
}

// Carrega o logotipo institucional (SISD) como data URL uma única vez, para
// uso nos cabeçalhos do PDF (jsPDF) e do JPEG (HTML/html2canvas).
let logoDataUrlCache = null;
async function obterLogoDataUrl() {
  if (logoDataUrlCache) return logoDataUrlCache;
  try {
    const resposta = await fetch("logo-sisd.png");
    const blob = await resposta.blob();
    logoDataUrlCache = await new Promise((resolve, reject) => {
      const leitor = new FileReader();
      leitor.onload = () => resolve(leitor.result);
      leitor.onerror = reject;
      leitor.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn("Não foi possível carregar o logotipo para a exportação:", e);
    logoDataUrlCache = null;
  }
  return logoDataUrlCache;
}

async function aguardarImagensCarregadas(container) {
  const imagens = Array.from(container.querySelectorAll("img"));
  await Promise.all(
    imagens.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            img.onload = resolve;
            img.onerror = resolve;
          })
    )
  );
}

async function renderizarCanvasElemento(el, escala) {
  document.getElementById("export-sandbox").appendChild(el);
  // setTimeout em vez de requestAnimationFrame: rAF não dispara em abas
  // em segundo plano/sem foco, o que travaria a exportação indefinidamente.
  await new Promise((r) => setTimeout(r, 0));
  await aguardarImagensCarregadas(el);
  const canvas = await html2canvas(el, { scale: escala, backgroundColor: "#ffffff", useCORS: true });
  el.remove();
  return canvas;
}

async function exportarPDF() {
  const { formato } = state.exportacao;
  const eventos = obterEventosFiltrados();
  const grupos = agruparPorDia(eventos);
  const logoDataUrl = await obterLogoDataUrl();

  const { jsPDF } = window.jspdf;
  const pdf =
    formato === "a4"
      ? new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" })
      : new jsPDF({ orientation: "portrait", unit: "mm", format: [100, 200] });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 10;
  const usableWidth = pageWidth - margin * 2;
  const alturaFaixa = formato === "a4" ? 24 : 20;

  let cursorY = margin;

  // Cabeçalho institucional: faixa azul-marinho com o logotipo SISD,
  // título e data de geração, encerrada por uma linha de destaque azul-claro.
  function desenharCabecalho() {
    pdf.setFillColor(6, 26, 53);
    pdf.rect(0, 0, pageWidth, alturaFaixa, "F");

    const logoTamanho = alturaFaixa - 10;
    const logoY = (alturaFaixa - logoTamanho) / 2;
    let textoX = margin;
    if (logoDataUrl) {
      pdf.addImage(logoDataUrl, "PNG", margin, logoY, logoTamanho, logoTamanho);
      textoX = margin + logoTamanho + 5;
    }

    pdf.setFontSize(formato === "a4" ? 14 : 12);
    pdf.setTextColor(255, 255, 255);
    pdf.text("Agenda Diego Daltro", textoX, alturaFaixa / 2 - 1);
    pdf.setFontSize(8.5);
    pdf.setTextColor(175, 198, 224);
    pdf.text("SISD/SESAB — Gerado em " + formatarDataHora(new Date()), textoX, alturaFaixa / 2 + 5);

    pdf.setDrawColor(85, 169, 232);
    pdf.setLineWidth(0.8);
    pdf.line(0, alturaFaixa, pageWidth, alturaFaixa);
    pdf.setLineWidth(0.2);
    pdf.setDrawColor(0);

    cursorY = alturaFaixa + 8;
  }

  desenharCabecalho();

  if (eventos.length === 0) {
    pdf.setFontSize(11);
    pdf.setTextColor(90);
    pdf.text("Nenhum compromisso encontrado para os filtros selecionados.", margin, cursorY + 4);
  }

  for (const grupo of grupos) {
    if (cursorY + 10 > pageHeight - margin) {
      pdf.addPage();
      cursorY = margin;
      desenharCabecalho();
    }
    pdf.setFontSize(11);
    pdf.setTextColor(6, 26, 53);
    pdf.text(grupo.rotulo, margin, cursorY + 4);
    cursorY += 8;

    for (const { evento, diaChave } of grupo.eventos) {
      const cardEl = construirCardExportacao(evento, diaChave);
      const canvas = await renderizarCanvasElemento(cardEl, 3);
      const imgWidthMm = usableWidth;
      const imgHeightMm = (canvas.height * imgWidthMm) / canvas.width;

      if (cursorY + imgHeightMm > pageHeight - margin) {
        pdf.addPage();
        cursorY = margin;
        desenharCabecalho();
      }

      pdf.addImage(canvas.toDataURL("image/png"), "PNG", margin, cursorY, imgWidthMm, imgHeightMm);
      cursorY += imgHeightMm + 4;
    }
    cursorY += 2;
  }

  pdf.save(`agenda-${Date.now()}.pdf`);
}

// Altura máxima (em px, antes da escala 3x) de conteúdo por imagem JPEG.
// Um único canvas gigante (ex.: 70+ cartões empilhados) pode ultrapassar o
// limite de área/dimensão de canvas do navegador e gerar um arquivo
// corrompido — por isso o conteúdo é paginado em várias imagens quando
// necessário, do mesmo jeito que a exportação em PDF já faz por cartão.
const JPEG_ALTURA_MAXIMA_POR_PAGINA_PX = 4000;

function criarCabecalhoExportacao(logoDataUrl) {
  const header = document.createElement("div");
  header.style.cssText =
    "padding: 16px 18px; margin-bottom: 16px; background: #061A35; display: flex; align-items: center; gap: 12px; border-radius: 12px; border-bottom: 3px solid #55A9E8;";

  const logoHtml = logoDataUrl
    ? `<img src="${logoDataUrl}" alt="" style="width:44px;height:44px;border-radius:50%;flex-shrink:0;" />`
    : "";

  header.innerHTML = `
    ${logoHtml}
    <div>
      <div style="font-size:17px;font-weight:700;color:#ffffff;line-height:1.2;">Agenda Diego Daltro</div>
      <div style="font-size:10.5px;color:#AFC6E0;margin-top:2px;">SISD/SESAB — Gerado em ${formatarDataHora(new Date())}</div>
    </div>
  `;
  return header;
}

async function exportarJPEG() {
  const { formato } = state.exportacao;
  const eventos = obterEventosFiltrados();
  const grupos = agruparPorDia(eventos);
  const largura = formato === "a4" ? 794 : 420;
  // Formato mobile vertical: usa o cartão completo (título, horário, duração,
  // local, descrição e link), aproveitando o espaço vertical do celular.
  const detalhado = formato === "mobile";
  const logoDataUrl = await obterLogoDataUrl();

  // Monta a lista plana de unidades (cabeçalho de data + cartões/linhas) na
  // ordem em que devem aparecer, para depois decidir os cortes de página.
  const unidades = [];

  if (eventos.length === 0) {
    const vazio = document.createElement("div");
    vazio.style.cssText = "color:#607086;font-size:13px;padding:20px 0;";
    vazio.textContent = "Nenhum compromisso encontrado para os filtros selecionados.";
    unidades.push(vazio);
  }

  grupos.forEach((grupo) => {
    const dataEl = document.createElement("div");
    dataEl.style.cssText = "font-size:13px;font-weight:700;color:#061A35;margin:14px 0 8px;";
    dataEl.textContent = grupo.rotulo;
    unidades.push(dataEl);

    grupo.eventos.forEach(({ evento, diaChave }) => {
      const card = construirCardExportacao(evento, diaChave, detalhado);
      card.style.width = "100%";
      unidades.push(card);
    });
  });

  // Mede a altura real de cada unidade e do cabeçalho fora da tela, antes de
  // decidir os cortes de página.
  const medidor = document.createElement("div");
  medidor.style.cssText = `width:${largura}px; padding:0 20px; background:#fff; font-family:'Segoe UI', Arial, sans-serif;`;
  const headerMedicao = criarCabecalhoExportacao(logoDataUrl);
  medidor.appendChild(headerMedicao);
  unidades.forEach((el) => medidor.appendChild(el));
  document.getElementById("export-sandbox").appendChild(medidor);
  // setTimeout em vez de requestAnimationFrame: rAF não dispara em abas
  // em segundo plano/sem foco, o que travaria a exportação indefinidamente.
  await new Promise((r) => setTimeout(r, 0));

  const alturaCabecalho = headerMedicao.getBoundingClientRect().height;
  const alturas = unidades.map((el) => el.getBoundingClientRect().height);
  medidor.remove();

  // Agrupa as unidades em páginas respeitando o limite de altura, sem
  // nunca cortar uma unidade (cartão/linha) no meio.
  const paginas = [];
  let paginaAtual = [];
  let alturaAtual = alturaCabecalho;

  unidades.forEach((el, i) => {
    const altura = alturas[i] || 0;
    if (alturaAtual + altura > JPEG_ALTURA_MAXIMA_POR_PAGINA_PX && paginaAtual.length > 0) {
      paginas.push(paginaAtual);
      paginaAtual = [];
      alturaAtual = alturaCabecalho;
    }
    paginaAtual.push(el);
    alturaAtual += altura;
  });
  if (paginaAtual.length > 0) paginas.push(paginaAtual);

  const timestamp = Date.now();

  for (let i = 0; i < paginas.length; i++) {
    const container = document.createElement("div");
    container.style.cssText = `width:${largura}px; padding:20px; background:#fff; font-family:'Segoe UI', Arial, sans-serif;`;
    container.appendChild(criarCabecalhoExportacao(logoDataUrl));
    paginas[i].forEach((el) => container.appendChild(el));

    const canvas = await renderizarCanvasElemento(container, 3);
    const sufixo = paginas.length > 1 ? `-parte${i + 1}-de-${paginas.length}` : "";
    const link = document.createElement("a");
    link.download = `agenda-${timestamp}${sufixo}.jpg`;
    link.href = canvas.toDataURL("image/jpeg", 0.95);
    link.click();

    // Pequena pausa entre downloads sucessivos para o navegador processá-los.
    if (i < paginas.length - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/* ==========================================================================
   EXPORTAÇÃO EM TEXTO (modal)
   ========================================================================== */

// Mesmo conteúdo minimalista das exportações em PDF/JPEG (horário, título,
// categoria, link só para pauta online, aviso de cancelamento), em texto
// simples — respeita os filtros ativos, igual às demais exportações.
function construirTextoAgenda() {
  const eventos = obterEventosFiltrados();
  const grupos = agruparPorDia(eventos);
  const linhas = [];

  linhas.push("Agenda Diego Daltro - SISD/SESAB");
  linhas.push("Gerado em " + formatarDataHora(new Date()));
  linhas.push("");

  if (eventos.length === 0) {
    linhas.push("Nenhum compromisso encontrado para os filtros selecionados.");
    return linhas.join("\n");
  }

  grupos.forEach((grupo) => {
    linhas.push(grupo.rotulo.toUpperCase());
    grupo.eventos.forEach(({ evento, diaChave }) => {
      const horario = horarioResumoPorDia(evento, diaChave);
      const aviso = evento.cancelado ? "  [⚠ CANCELADO]" : "";
      const continuo = eventoEhContinuo(evento)
        ? `  [vários dias: ${formatarDataCurta(new Date(evento.inicio))} a ${formatarDataCurta(new Date(evento.fim))}]`
        : "";
      linhas.push(`  ${horario} | ${CATEGORIA_LABEL[evento.categoria]} | ${evento.titulo}${aviso}${continuo}`);
      if (evento.categoria === "pauta-online" && evento.link) {
        linhas.push(`      Link: ${evento.link}`);
      }
    });
    linhas.push("");
  });

  return linhas.join("\n").trim();
}

function abrirModalTexto() {
  document.getElementById("text-export-conteudo").value = construirTextoAgenda();
  document.getElementById("text-export-copiado").hidden = true;
  document.getElementById("text-export-modal").hidden = false;
  document.getElementById("text-export-backdrop").hidden = false;
  document.getElementById("text-export-conteudo").focus();
}

function fecharModalTexto() {
  document.getElementById("text-export-modal").hidden = true;
  document.getElementById("text-export-backdrop").hidden = true;
}

/* ==========================================================================
   LIGAÇÃO DE EVENTOS DE INTERFACE
   ========================================================================== */

function configurarChipGroup(seletor, callback, multipla) {
  const grupo = document.querySelector(seletor);
  grupo.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".chip");
    if (!btn) return;

    if (multipla) {
      btn.classList.toggle("is-active");
    } else {
      grupo.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-active"));
      btn.classList.add("is-active");
    }
    callback(btn, grupo);
  });
}

function inicializarInterface() {
  inicializarTema();
  document.getElementById("btn-tema").addEventListener("click", alternarTema);

  document.getElementById("btn-abrir-outlook").href = CALENDAR_HTML_URL;

  document.getElementById("btn-atualizar").addEventListener("click", () => atualizarAgenda());
  document.getElementById("btn-tentar-novamente").addEventListener("click", () => atualizarAgenda());

  document.getElementById("busca").addEventListener("input", (ev) => {
    state.filtros.busca = ev.target.value;
    renderizarConteudo();
  });

  document.getElementById("mostrar-concluidos").addEventListener("change", (ev) => {
    state.filtros.mostrarConcluidos = ev.target.checked;
    renderizarConteudo();
  });

  const inputDataInicio = document.getElementById("filtro-data-inicio");
  const inputDataFim = document.getElementById("filtro-data-fim");
  const btnLimparDatas = document.getElementById("btn-limpar-datas");

  function atualizarVisibilidadeBtnLimparDatas() {
    btnLimparDatas.hidden = !state.filtros.dataInicio && !state.filtros.dataFim;
  }

  // Valida o intervalo (Até >= De) antes de aplicar ao filtro — em caso de
  // erro, mantém o filtro anterior válido e exibe uma mensagem clara.
  function aplicarFiltroDeData() {
    const inicio = inputDataInicio.value || null;
    const fim = inputDataFim.value || null;

    if (inicio && fim && fim < inicio) {
      mostrarErroData('A data "Até" precisa ser igual ou posterior à data "De".');
      return;
    }

    esconderErroData();
    state.filtros.dataInicio = inicio;
    state.filtros.dataFim = fim;
    atualizarVisibilidadeBtnLimparDatas();
    renderizarConteudo();
  }

  inputDataInicio.addEventListener("change", aplicarFiltroDeData);
  inputDataFim.addEventListener("change", aplicarFiltroDeData);

  btnLimparDatas.addEventListener("click", () => {
    limparFiltroDeData();
    renderizarConteudo();
  });

  configurarChipGroup(
    "#periodo-group",
    (btn) => {
      state.filtros.periodo = btn.dataset.periodo;
      renderizarConteudo();
    },
    false
  );

  configurarChipGroup(
    "#categoria-group",
    (btn) => {
      const categoria = btn.dataset.categoria;
      if (state.filtros.categorias.has(categoria)) {
        state.filtros.categorias.delete(categoria);
      } else {
        state.filtros.categorias.add(categoria);
      }
      renderizarConteudo();
    },
    true
  );

  configurarChipGroup(
    "#export-formato-group",
    (btn) => {
      state.exportacao.formato = btn.dataset.formato;
    },
    false
  );

  const LIMITE_CONFIRMACAO_EXPORTACAO = 40;

  document.getElementById("btn-exportar-pdf").addEventListener("click", async (ev) => {
    const quantidade = obterEventosFiltrados().length;
    if (quantidade > LIMITE_CONFIRMACAO_EXPORTACAO) {
      const prosseguir = await confirmarAcao(
        `A exportação em PDF vai incluir ${quantidade} compromissos e pode levar alguns segundos, gerando várias páginas. Deseja continuar?`,
        "Confirmar exportação em PDF"
      );
      if (!prosseguir) return;
    }

    const btn = ev.currentTarget;
    btn.disabled = true;
    const textoOriginal = btn.textContent;
    btn.textContent = "Gerando PDF…";
    try {
      await exportarPDF();
    } catch (erro) {
      console.error("Erro ao exportar PDF:", erro);
      alert("Não foi possível gerar o PDF: " + erro.message);
    } finally {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  });

  document.getElementById("btn-exportar-jpeg").addEventListener("click", async (ev) => {
    const quantidade = obterEventosFiltrados().length;
    if (quantidade > LIMITE_CONFIRMACAO_EXPORTACAO) {
      const prosseguir = await confirmarAcao(
        `A exportação em JPEG vai incluir ${quantidade} compromissos e pode gerar múltiplas imagens. Deseja continuar?`,
        "Confirmar exportação em JPEG"
      );
      if (!prosseguir) return;
    }

    const btn = ev.currentTarget;
    btn.disabled = true;
    const textoOriginal = btn.textContent;
    btn.textContent = "Gerando JPEG…";
    try {
      await exportarJPEG();
    } catch (erro) {
      console.error("Erro ao exportar JPEG:", erro);
      alert("Não foi possível gerar o JPEG: " + erro.message);
    } finally {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  });

  // ---------------------------------------------------------------------
  // Sidebar: drawer mobile e colapso no desktop
  // ---------------------------------------------------------------------

  document.getElementById("btn-menu").addEventListener("click", () => {
    if (state.ui.sidebarAberta) fecharSidebarMobile();
    else abrirSidebarMobile();
  });
  document.getElementById("sidebar-backdrop").addEventListener("click", fecharSidebarMobile);
  document.getElementById("btn-recolher-sidebar").addEventListener("click", alternarSidebarDesktop);

  try {
    if (localStorage.getItem(SIDEBAR_RECOLHIDA_STORAGE_KEY) === "1") {
      alternarSidebarDesktop();
    }
  } catch (e) {
    /* ignora */
  }

  // Fecha o drawer mobile automaticamente ao escolher um filtro, já que a
  // sidebar cobre o conteúdo nesse modo.
  document.getElementById("sidebar").addEventListener("click", (ev) => {
    if (window.innerWidth > 860) return;
    if (ev.target.closest(".chip, .switch, #btn-limpar-datas")) {
      fecharSidebarMobile();
    }
  });

  // ---------------------------------------------------------------------
  // Filtros ativos: botão "limpar todos"
  // ---------------------------------------------------------------------

  document.getElementById("btn-limpar-filtros").addEventListener("click", limparTodosFiltros);

  // ---------------------------------------------------------------------
  // Alternância entre linha do tempo e tabela
  // ---------------------------------------------------------------------

  document.getElementById("btn-vista-timeline").addEventListener("click", () => {
    state.ui.vista = "timeline";
    atualizarVisibilidadeVista();
  });
  document.getElementById("btn-vista-tabela").addEventListener("click", () => {
    state.ui.vista = "tabela";
    atualizarVisibilidadeVista();
  });

  // ---------------------------------------------------------------------
  // Tabela: ordenação e paginação
  // ---------------------------------------------------------------------

  document.querySelectorAll(".th-sort").forEach((btn) => {
    btn.addEventListener("click", () => {
      const campo = btn.dataset.sort;
      if (state.ui.tabelaOrdenarPor === campo) {
        state.ui.tabelaOrdemAsc = !state.ui.tabelaOrdemAsc;
      } else {
        state.ui.tabelaOrdenarPor = campo;
        state.ui.tabelaOrdemAsc = true;
      }
      state.ui.tabelaPagina = 1;
      renderizarConteudo();
    });
  });

  document.getElementById("btn-pagina-anterior").addEventListener("click", () => {
    state.ui.tabelaPagina -= 1;
    renderizarConteudo();
  });
  document.getElementById("btn-pagina-proxima").addEventListener("click", () => {
    state.ui.tabelaPagina += 1;
    renderizarConteudo();
  });

  // ---------------------------------------------------------------------
  // Painel lateral de detalhes (delegação para cartões e linhas da tabela)
  // ---------------------------------------------------------------------

  document.addEventListener("click", (ev) => {
    const btnDetalhes = ev.target.closest("[data-abrir-detalhes]");
    if (btnDetalhes) {
      abrirPainelDetalhes(btnDetalhes.dataset.abrirDetalhes);
    }
  });

  document.getElementById("btn-fechar-painel").addEventListener("click", fecharPainelDetalhes);
  document.getElementById("panel-backdrop").addEventListener("click", fecharPainelDetalhes);

  // ---------------------------------------------------------------------
  // Exportação em texto (modal)
  // ---------------------------------------------------------------------

  document.getElementById("btn-exportar-texto").addEventListener("click", abrirModalTexto);
  document.getElementById("btn-fechar-texto").addEventListener("click", fecharModalTexto);
  document.getElementById("btn-fechar-texto-2").addEventListener("click", fecharModalTexto);
  document.getElementById("text-export-backdrop").addEventListener("click", fecharModalTexto);

  document.getElementById("btn-copiar-texto").addEventListener("click", async () => {
    const textarea = document.getElementById("text-export-conteudo");
    const aviso = document.getElementById("text-export-copiado");
    try {
      await navigator.clipboard.writeText(textarea.value);
    } catch (e) {
      // Sem permissão/API de clipboard: seleciona o texto para copiar manualmente.
      textarea.focus();
      textarea.select();
    }
    aviso.hidden = false;
    setTimeout(() => {
      aviso.hidden = true;
    }, 2500);
  });

  // ---------------------------------------------------------------------
  // Tecla Esc: fecha o overlay mais recente (confirmação > texto > painel > drawer)
  // ---------------------------------------------------------------------

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;

    const confirmModal = document.getElementById("confirm-modal");
    if (!confirmModal.hidden) {
      document.getElementById("confirm-cancelar").click();
      return;
    }
    if (!document.getElementById("text-export-modal").hidden) {
      fecharModalTexto();
      return;
    }
    if (document.getElementById("detail-panel").getAttribute("aria-hidden") === "false") {
      fecharPainelDetalhes();
      return;
    }
    if (state.ui.sidebarAberta) {
      fecharSidebarMobile();
    }
  });
}

/* ==========================================================================
   INICIALIZAÇÃO
   ========================================================================== */

function iniciar() {
  inicializarInterface();

  // Pré-carrega o cache local para uma primeira renderização instantânea,
  // antes mesmo da resposta da rede chegar.
  const cache = carregarCache();
  if (cache) {
    marcarConflitos(cache.events);
    state.eventos = cache.events;
    state.usandoCache = true;
    state.ultimaAtualizacao = new Date(cache.savedAt);
    renderizarTudo();
    mostrarAvisoCache();
  }

  atualizarAgenda();
  setInterval(atualizarAgenda, REFRESH_INTERVAL_MS);
}

document.addEventListener("DOMContentLoaded", iniciar);
