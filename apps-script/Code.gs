/**
 * TG Publicações · robô no Google Apps Script
 *
 * - Lê os botões do Telegram a cada minuto: Aprovar / Suspender / Pedir alteração.
 * - A cada 5 minutos: envia posts novos para aprovação, publica os aprovados à hora certa
 *   no Facebook e no Instagram, e 10 minutos depois manda os botões para partilhar no perfil pessoal.
 * - Os posts vêm do GitHub (repositório público tg-publicacoes, ficheiro posts/posts.json).
 * - O estado fica no ficheiro "TG Publicações · estado.json" no Google Drive.
 *
 * Propriedades do script (Definições do projeto > Propriedades do script):
 *   TELEGRAM_TOKEN, META_TOKEN_TODOSGANHAM (uma por página: META_TOKEN_<CHAVE>)
 */

var REPO = 'cristianosousa67-rgb/tg-publicacoes';
var RAW = 'https://raw.githubusercontent.com/' + REPO + '/main/';
var GRAPH = 'https://graph.facebook.com/v26.0/';
var ESTADO_NOME = 'TG Publicações · estado.json';
var ATRASO_PARTILHA_MIN = 10;
var JANELA_MAX_H = 6;
var NOMES = { todosganham: 'TodosGanham' };
var SEED = {"offset": 160493729, "chat_id": 9178633178, "posts": {"2026-11-02-impressora-brother": {"estado": "aprovado", "versao": 1, "msg": 6}, "2026-11-03-embaixadores": {"estado": "aprovado", "versao": 1, "msg": 7}, "2026-11-04-velas": {"estado": "aprovado", "versao": 1, "msg": 8}, "2026-11-05-ups": {"estado": "aprovado", "versao": 1, "msg": 9}, "2026-11-06-vinhos": {"estado": "aprovado", "versao": 1, "msg": 10}, "2026-11-07-tinteiros": {"estado": "aprovado", "versao": 1, "msg": 11}, "2026-11-08-boas-vindas-5": {"estado": "aprovado", "versao": 1, "msg": 12}}};

// ---------- utilitários ----------
function prop(k) { return PropertiesService.getScriptProperties().getProperty(k); }

function tg(metodo, dados) {
  var payload = {};
  for (var k in dados) payload[k] = (typeof dados[k] === 'object') ? JSON.stringify(dados[k]) : String(dados[k]);
  var r = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop('TELEGRAM_TOKEN') + '/' + metodo,
    { method: 'post', payload: payload, muteHttpExceptions: true });
  var j = JSON.parse(r.getContentText());
  if (!j.ok) console.log('Telegram ' + metodo + ': ' + r.getContentText());
  return j;
}

function graph(caminho, dados, metodo) {
  var opt = { muteHttpExceptions: true, method: metodo || (dados ? 'post' : 'get') };
  if (dados) { opt.payload = {}; for (var k in dados) opt.payload[k] = String(dados[k]); }
  var r = UrlFetchApp.fetch(GRAPH + caminho, opt);
  var j = JSON.parse(r.getContentText());
  if (j.error) throw new Error('Meta: ' + j.error.message);
  return j;
}

function ficheiroEstado() {
  var it = DriveApp.getFilesByName(ESTADO_NOME);
  if (it.hasNext()) return it.next();
  var e = SEED; e.vistos = [];
  return DriveApp.createFile(ESTADO_NOME, JSON.stringify(e, null, 1), 'application/json');
}
function lerEstado() { return JSON.parse(ficheiroEstado().getBlob().getDataAsString()); }
function guardarEstado(e) { ficheiroEstado().setContent(JSON.stringify(e, null, 1)); }

function lerPosts() {
  var lista = JSON.parse(UrlFetchApp.fetch(RAW + 'posts/posts.json?t=' + Date.now()).getContentText());
  var posts = {};
  lista.forEach(function (p) { posts[p.id] = p; });
  return posts;
}

function quando(p) {  // "2026-11-02T19:00" em hora de Lisboa
  return Utilities.parseDate(p.quando, 'Europe/Lisbon', "yyyy-MM-dd'T'HH:mm");
}
function fmt(d, f) { return Utilities.formatDate(d, 'Europe/Lisbon', f); }

var DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
var ROTULO = { por_aprovar: '⏳ Por aprovar', aprovado: '✅ APROVADO', suspenso: '⏸ SUSPENSO',
  alterar: '✏️ ALTERAÇÃO PEDIDA', publicado: '📣 PUBLICADO', erro: '⚠️ ERRO', expirado: '⌛ NÃO SAIU' };

function legenda(p, est) {
  var q = quando(p);
  var dia = DIAS[Number(fmt(q, 'u')) % 7];
  var pags = p.paginas.map(function (k) { return NOMES[k] || k; }).join(', ');
  return (ROTULO[est] || est) + '\n🗓 ' + dia + ', ' + fmt(q, 'dd/MM') + ' às ' + fmt(q, 'HH:mm') +
    '\n📍 ' + pags + ' · Facebook e Instagram\n\n' + p.texto_fb;
}

function teclado(pid, est) {
  if (est === 'publicado') return { inline_keyboard: [] };
  var linha1 = est === 'aprovado'
    ? [{ text: '✅ Aprovado', callback_data: 'nada|' + pid }, { text: '⏸ Suspender', callback_data: 'sus|' + pid }]
    : est === 'suspenso'
      ? [{ text: '✅ Aprovar', callback_data: 'ok|' + pid }, { text: '⏸ Suspenso', callback_data: 'nada|' + pid }]
      : [{ text: '✅ Aprovar', callback_data: 'ok|' + pid }, { text: '⏸ Suspender', callback_data: 'sus|' + pid }];
  return { inline_keyboard: [linha1, [{ text: '✏️ Pedir alteração', callback_data: 'alt|' + pid }]] };
}

// ---------- Telegram: lê as respostas a cada minuto ----------
function telegram() {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(20000)) return;
  try {
    var e = lerEstado();
    var r = tg('getUpdates', { offset: e.offset || 0, timeout: 0 });
    if (!r.ok || !r.result.length) return;
    r.result.forEach(function (u) { e.offset = u.update_id + 1; try { tratar(u, e); } catch (err) { console.log(err); } });
    guardarEstado(e);
  } finally { lock.releaseLock(); }
}

function tratar(u, e) {
  var msg = u.message, cb = u.callback_query;
  var chat = (msg || (cb && cb.message) || {}).chat;
  chat = chat && chat.id;
  if (!e.chat_id && msg) { e.chat_id = chat; }
  if (chat !== e.chat_id) return;
  if (cb) {
    var partes = cb.data.split('|'), acao = partes[0], pid = partes[1];
    var st = e.posts[pid] = e.posts[pid] || {};
    if (acao === 'nada') { tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Já está assim 👍' }); return; }
    if (st.estado === 'publicado') { tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Este post já foi publicado.' }); return; }
    var novo = { ok: 'aprovado', sus: 'suspenso', alt: 'alterar' }[acao];
    st.estado = novo; st.atualizado = fmt(new Date(), "yyyy-MM-dd'T'HH:mm");
    tg('answerCallbackQuery', { callback_query_id: cb.id,
      text: { aprovado: 'Aprovado ✅', suspenso: 'Suspenso ⏸', alterar: 'Escreva o que quer mudar' }[novo] });
    var posts = lerPosts();
    if (posts[pid]) tg('editMessageCaption', { chat_id: chat, message_id: cb.message.message_id,
      caption: legenda(posts[pid], novo).slice(0, 1020), reply_markup: teclado(pid, novo) });
    if (novo === 'alterar') {
      e.a_espera_alteracao = pid;
      tg('sendMessage', { chat_id: chat, text: '✏️ Escreva numa mensagem o que quer mudar neste post. O Claude trata da alteração e o post volta para aprovação.' });
    }
  } else if (msg && msg.text) {
    var t = msg.text.trim();
    if (e.a_espera_alteracao) {
      var p = e.posts[e.a_espera_alteracao];
      (p.pedidos = p.pedidos || []).push({ quando: fmt(new Date(), "yyyy-MM-dd'T'HH:mm"), texto: t });
      delete e.a_espera_alteracao;
      tg('sendMessage', { chat_id: chat, text: 'Anotado 👍 Fica à espera do Claude. Até lá, o post não sai.' });
    } else if (/^\/?estado$/i.test(t)) {
      var ps = lerPosts(), linhas = [];
      Object.keys(ps).map(function (k) { return ps[k]; }).sort(function (a, b) { return quando(a) - quando(b); })
        .forEach(function (p) { linhas.push(fmt(quando(p), 'dd/MM HH:mm') + ' · ' + p.titulo + ' · ' + (ROTULO[(e.posts[p.id] || {}).estado || 'por_aprovar'])); });
      tg('sendMessage', { chat_id: chat, text: linhas.join('\n') || 'Sem posts.' });
    } else if (/^\/start/.test(t) || /^ol[aá]/i.test(t)) {
      tg('sendMessage', { chat_id: chat, text: 'Olá Cristiano 👋 O TG Publicações está ligado. Escreva «estado» para ver os posts.' });
    }
  }
}

// ---------- volta a cada 5 minutos ----------
function volta() {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(30000)) return;
  try {
    var e = lerEstado();
    if (!e.chat_id) return;
    var posts = lerPosts(), agora = new Date();
    var ordem = Object.keys(posts).map(function (k) { return posts[k]; }).sort(function (a, b) { return quando(a) - quando(b); });
    ordem.forEach(function (p) {          // novos ou alterados -> aprovação
      var st = e.posts[p.id] = e.posts[p.id] || {};
      if (st.msg && st.versao === (p.versao || 1)) return;
      if (quando(p) < agora) return;
      st.estado = 'por_aprovar'; st.versao = p.versao || 1;
      var r = tg('sendPhoto', { chat_id: e.chat_id, photo: RAW + p.imagem,
        caption: legenda(p, 'por_aprovar').slice(0, 1020), reply_markup: teclado(p.id, 'por_aprovar') });
      if (r.ok) st.msg = r.result.message_id;
    });
    ordem.forEach(function (p) { publicarSeFor(p, e, agora); });
    partilhas(e, posts, agora);
    guardarEstado(e);
  } finally { lock.releaseLock(); }
}

function publicarSeFor(p, e, agora) {
  var st = e.posts[p.id] || {};
  if (st.estado !== 'aprovado' || st.versao !== (p.versao || 1)) return;
  var atraso = (agora - quando(p)) / 60000;
  if (atraso < 0) return;
  if (atraso > JANELA_MAX_H * 60) {
    st.estado = 'expirado';
    tg('sendMessage', { chat_id: e.chat_id, text: '⚠️ «' + p.titulo + '» não saiu: passou a hora há mais de ' + JANELA_MAX_H + ' h.' });
    return;
  }
  var img = RAW + p.imagem, links = {}, erros = [];
  p.paginas.forEach(function (chave) {
    var token = prop('META_TOKEN_' + chave.toUpperCase());
    if (!token) { erros.push('falta a propriedade META_TOKEN_' + chave.toUpperCase()); return; }
    var nome = NOMES[chave] || chave;
    try {
      var pag = graph('me?fields=id,instagram_business_account&access_token=' + encodeURIComponent(token));
      var r = graph(pag.id + '/photos', { url: img, message: p.texto_fb, access_token: token });
      links[nome + ' · Facebook'] = 'https://www.facebook.com/' + (r.post_id || r.id);
      var ig = pag.instagram_business_account && pag.instagram_business_account.id;
      if (ig) {
        var c = graph(ig + '/media', { image_url: img, caption: p.texto_ig, access_token: token });
        for (var i = 0; i < 10; i++) {
          var s = graph(c.id + '?fields=status_code&access_token=' + encodeURIComponent(token));
          if (s.status_code === 'FINISHED') break;
          Utilities.sleep(3000);
        }
        var m = graph(ig + '/media_publish', { creation_id: c.id, access_token: token });
        var pl = graph(m.id + '?fields=permalink&access_token=' + encodeURIComponent(token));
        links[nome + ' · Instagram'] = pl.permalink || '';
      }
    } catch (err) { erros.push(nome + ': ' + err.message); }
  });
  st.estado = Object.keys(links).length ? 'publicado' : 'erro';
  st.publicado_em = new Date().toISOString(); st.links = links; st.erros = erros;
  var txt = '📣 Publicado: «' + p.titulo + '»\n' + Object.keys(links).map(function (k) { return k + ': ' + links[k]; }).join('\n');
  if (erros.length) txt += '\n\n⚠️ Problemas:\n' + erros.join('\n');
  tg('sendMessage', { chat_id: e.chat_id, text: txt, disable_web_page_preview: true });
  if (st.msg) tg('editMessageReplyMarkup', { chat_id: e.chat_id, message_id: st.msg, reply_markup: { inline_keyboard: [] } });
}

function partilhas(e, posts, agora) {
  Object.keys(e.posts).forEach(function (pid) {
    var st = e.posts[pid];
    if (st.estado !== 'publicado' || st.partilha_enviada || !st.links) return;
    if ((agora - new Date(st.publicado_em)) / 60000 < ATRASO_PARTILHA_MIN) return;
    var botoes = [];
    Object.keys(st.links).forEach(function (k) {
      var url = st.links[k];
      if (/Facebook/.test(k)) botoes.push([{ text: '📘 Partilhar no meu Facebook', url: 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url) }]);
      else if (url) botoes.push([{ text: '📸 Abrir no Instagram para republicar', url: url }]);
    });
    tg('sendMessage', { chat_id: e.chat_id,
      text: '🔁 Hora de partilhar no seu perfil: «' + ((posts[pid] || {}).titulo || pid) + '»\nNo Facebook escolha «Público». No Instagram toque em 🔁.',
      reply_markup: { inline_keyboard: botoes } });
    st.partilha_enviada = new Date().toISOString();
  });
}

// ---------- configurar (correr uma vez) ----------
function configurar() {
  tg('deleteWebhook', {});
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('telegram').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('volta').timeBased().everyMinutes(5).create();
  var e = lerEstado();
  tg('sendMessage', { chat_id: e.chat_id, text: '✅ TG Publicações passou para o Google. Os botões passam a responder em menos de 1 minuto. Escreva «estado» para confirmar.' });
  console.log('Pronto.');
}
