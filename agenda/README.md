# Agenda Diego Daltro - SISD/SESAB

Aplicação web responsiva para visualização da agenda institucional, sincronizada automaticamente com o calendário Outlook/Microsoft 365 publicado em formato ICS.

## Interface (identidade "Saúde Digital")

- **Topbar** institucional (azul-marinho `#061A35`) com logotipo, busca global e ações rápidas.
- **Sidebar** de navegação/filtros: drawer com backdrop no mobile (botão ☰), recolhível no desktop (preferência salva em `localStorage`).
- **Breadcrumbs**, **dashboard** com indicadores (total filtrado, hoje, semana, em andamento) e **filtros ativos removíveis** (chip por filtro + "limpar tudo").
- Duas visões alternáveis: **linha do tempo** (cards) e **tabela** (ordenável, paginada; some no mobile, vira cards).
- **Painel lateral** de detalhes por compromisso (botão "Ver detalhes"), com foco preso e retorno de foco ao fechar.
- **Modal de confirmação** antes de exportações grandes (>40 compromissos) e **validação inline** do filtro de datas.
- Acessibilidade: skip-link, `:focus-visible`, landmarks (`header`/`nav`/`main`/`aside`), `aria-live`/`aria-invalid`/`aria-expanded`, tecla Esc fecha painéis/drawer/modal na ordem correta.

## Stack

- **Frontend**: HTML5 + CSS3 + JavaScript puro (sem framework/bundler), bibliotecas carregadas via CDN:
  - [ical.js](https://github.com/kewisch/ical.js) — parsing do arquivo ICS (VEVENT, RRULE, EXDATE, RECURRENCE-ID, VTIMEZONE).
  - [html2canvas](https://html2canvas.hertzen.com/) + [jsPDF](https://github.com/parallax/jsPDF) — exportação em JPEG e PDF.
- **Backend**: Node.js + Express (`server.js`), camada intermediária para contornar CORS ao buscar o ICS do Outlook.

## Executando localmente

```bash
cd agenda
npm install
npm start
```

Acesse `http://localhost:3000`.

Opcionalmente, copie `.env.example` para `.env` e ajuste `CALENDAR_ICS_URL`, `ALLOWED_ORIGIN` e `CACHE_TTL_MS` conforme o ambiente.

## Como funciona a leitura do calendário

1. O frontend tenta `fetch(CALENDAR_ICS_URL)` diretamente do navegador.
2. Se o navegador bloquear por CORS (o esperado, já que o Outlook não libera a origem da aplicação), o frontend recorre a `fetch(CALENDAR_API_URL)`, isto é, `/api/calendar`.
3. `server.js` busca o ICS no servidor (sem restrição de CORS, pois é uma chamada servidor-servidor), aplica um cache curto em memória (`CACHE_TTL_MS`, padrão 5 min) e devolve o conteúdo com `Content-Type: text/calendar`, liberando apenas a origem configurada em `ALLOWED_ORIGIN`.
4. O conteúdo ICS é interpretado inteiramente no cliente com `ical.js`.

Nenhuma credencial é usada ou exposta — o link ICS já é público (URL de calendário publicado do Outlook).

## Decisões de implementação

- **Por que só `ical.js` e não também `rrule.js`**: `ical.js` já implementa internamente a expansão de `RRULE` (via `ICAL.Event.iterator()` / `ICAL.Recur`), além de tratar `EXDATE` e overrides de `RECURRENCE-ID` através de `event.relateException()`. Adicionar `rrule.js` como um segundo motor de recorrência introduziria risco de resultados divergentes entre as duas bibliotecas sem ganho real, então a expansão de recorrência usa exclusivamente `ical.js`.
- **Fuso horário**: os horários são resolvidos a partir dos `VTIMEZONE` do calendário (registrados via `ICAL.TimezoneService.register`) e exibidos sempre em `America/Bahia` (`Intl.DateTimeFormat`), independente do fuso do navegador do usuário.
- **Janela de expansão de recorrência**: eventos recorrentes são expandidos de 1 mês no passado a 6 meses no futuro (configurável em `script.js`, constantes `JANELA_MESES_PASSADO` / `JANELA_MESES_FUTURO`), para evitar séries infinitas.
- **Eventos que atravessam vários dias**: são agrupados na data de início da timeline; o card mostra a duração total (ex.: "3 dias"). Já para os filtros de dia/semana/mês, o evento aparece se o seu intervalo *intersecta* o período filtrado — ou seja, um evento de 3 dias aparece também nos filtros dos dias intermediários.
- **Classificação automática**: função centralizada `classificarEvento(evento)` em `script.js`, avaliando título, descrição, local, link e categorias ICS por palavras-chave. Prioridade: viagem → mestrado → pauta online → pauta presencial (fallback quando nada é identificado).
- **Cache local**: a última lista de eventos processada é salva em `localStorage` a cada atualização bem-sucedida. Se a busca falhar (rede/CORS/indisponibilidade do Outlook), a interface exibe os dados salvos com aviso de que podem estar desatualizados.
- **`server.js` como camada intermediária**: entre as opções sugeridas (Vercel/Netlify/Cloudflare Worker/Express), optou-se por um endpoint Express por ser executável localmente e em qualquer provedor Node (Render, Railway, VPS, etc.) sem exigir uma plataforma específica. Para deploy em Vercel/Netlify, o mesmo código de `app.get("/api/calendar", ...)` pode ser adaptado para uma função serverless (`api/calendar.js`) reaproveitando a mesma lógica de fetch + cache + CORS.

## Estrutura de dados do evento

```js
{
  id: "identificador-unico",
  titulo: "Título do compromisso",
  descricao: "Descrição do compromisso",
  inicio: "2026-07-20T09:00:00-03:00",
  fim: "2026-07-20T10:00:00-03:00",
  diaInteiro: false,
  local: "Local do compromisso",
  link: "Link da reunião",
  categoria: "pauta-online",
  categoriasIcs: ["..."],
  status: "confirmado",
  recorrente: false,
  conflito: false
}
```

## Filtros disponíveis

- Período: todos / hoje / semana (segunda a domingo) / mês.
- Categorias (seleção múltipla): viagem, mestrado, pauta online, pauta presencial. Com nenhuma categoria marcada, todos os compromissos são exibidos; marcar uma ou mais categorias restringe a lista a elas.
- Busca textual (título, descrição, local).
- Mostrar/ocultar compromissos concluídos.

## Exportação

- **PDF**: A4 retrato ou "mobile vertical" (tira estreita), com cabeçalho repetido em cada página, margens e paginação que nunca corta um cartão no meio (cada cartão é renderizado como uma imagem atômica antes de decidir se cabe na página atual).
- **JPEG**: imagem única, escala 3x, nos mesmos dois formatos.
- Conteúdo: agenda completa (com descrição e link), apenas compromissos (sem descrição/link) ou apenas resumo (lista textual compacta).
- A exportação sempre respeita os filtros ativos (período, categorias, busca, concluídos).

## Checklist de testes realizados

- [x] Carregamento da agenda (fallback para `/api/calendar` quando o fetch direto ao Outlook é bloqueado por CORS).
- [x] Eventos com horário.
- [x] Eventos de dia inteiro.
- [x] Eventos recorrentes (RRULE) com exceções (EXDATE/RECURRENCE-ID).
- [x] Eventos cancelados (STATUS:CANCELLED).
- [x] Eventos com link de reunião (Teams/Meet/Zoom) → classificados como "pauta online".
- [x] Filtro diário, semanal (segunda a domingo) e mensal.
- [x] Filtros de categoria combinados.
- [x] Exportação em PDF (A4 e mobile vertical).
- [x] Exportação em JPEG.
- [x] Layout responsivo (mobile: timeline vertical em coluna única / desktop: filtros fixos ao lado).
- [x] Exibição em `America/Bahia` independente do fuso do dispositivo.

> Nota: os testes de carregamento contra o link real do Outlook dependem de o link ICS estar acessível no momento do teste e de a rede permitir a saída HTTP do servidor até `outlook.office365.com`. Se o link expirar ou for revogado, o endpoint `/api/calendar` retornará erro 502 e a interface cairá automaticamente para os dados em cache local, exibindo o aviso correspondente.
