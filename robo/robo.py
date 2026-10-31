"""TG Publicações · robô que corre no GitHub Actions.

O que faz em cada volta (a cada 10 minutos):
  1. Lê as respostas do Cristiano no Telegram (Aprovar / Suspender / Pedir alteração).
  2. Envia para aprovação os posts novos de posts/*.json.
  3. Publica no Facebook e no Instagram das páginas os posts aprovados cuja hora chegou.
  4. 10 minutos depois de publicar, envia a mensagem para partilhar no perfil pessoal.
  5. Guarda o estado em estado/estado.json (o workflow faz commit).

Segredos (GitHub > Settings > Secrets and variables > Actions):
  TELEGRAM_TOKEN            token do bot dado pelo @BotFather
  META_TOKEN_TODOSGANHAM    token da página TodosGanham (uma linha por página: META_TOKEN_<CHAVE>)
"""
import json, os, glob, time, urllib.request, urllib.parse, datetime
from zoneinfo import ZoneInfo

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EST_F = os.path.join(RAIZ, "estado", "estado.json")
LX = ZoneInfo("Europe/Lisbon")
REPO = os.environ.get("GITHUB_REPOSITORY", "cristianosousa67-rgb/tg-publicacoes")
RAW = f"https://raw.githubusercontent.com/{REPO}/main/"
GRAPH = "https://graph.facebook.com/v21.0/"
TG = "https://api.telegram.org/bot" + os.environ.get("TELEGRAM_TOKEN", "") + "/"
ATRASO_PARTILHA = 10 * 60      # segundos depois de publicar
JANELA_MAX = 6 * 3600          # não publica posts com mais de 6 h de atraso
NOMES = {"todosganham": "TodosGanham"}


def agora():
    return datetime.datetime.now(LX)


def http(url, data=None, timeout=60):
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        txt = e.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {e.code} em {url.split('?')[0]}: {txt[:400]}")


def tg(metodo, **dados):
    for k, v in list(dados.items()):
        if isinstance(v, (dict, list)):
            dados[k] = json.dumps(v)
    return http(TG + metodo, dados)


def carregar():
    if os.path.exists(EST_F):
        with open(EST_F, encoding="utf-8") as f:
            return json.load(f)
    return {"chat_id": None, "offset": 0, "posts": {}}


def guardar(e):
    os.makedirs(os.path.dirname(EST_F), exist_ok=True)
    with open(EST_F, "w", encoding="utf-8") as f:
        json.dump(e, f, ensure_ascii=False, indent=1)


def ler_posts():
    posts = []
    for fn in sorted(glob.glob(os.path.join(RAIZ, "posts", "*.json"))):
        with open(fn, encoding="utf-8") as f:
            posts.extend(json.load(f))
    return {p["id"]: p for p in posts}


def quando(p):
    return datetime.datetime.fromisoformat(p["quando"]).replace(tzinfo=LX)


def legenda_aprovacao(p, est):
    q = quando(p)
    dias = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"]
    pags = ", ".join(NOMES.get(k, k) for k in p["paginas"])
    estado = {"por_aprovar": "⏳ Por aprovar", "aprovado": "✅ Aprovado", "suspenso": "⏸ Suspenso",
              "alterar": "✏️ Alteração pedida", "publicado": "📣 Publicado"}.get(est, est)
    txt = (f"{estado}\n🗓 {dias[q.weekday()]}, {q:%d/%m} às {q:%H:%M}\n📍 {pags} · Facebook e Instagram\n\n"
           f"{p['texto_fb']}")
    return txt[:1020]


def teclado(pid):
    return {"inline_keyboard": [[
        {"text": "✅ Aprovar", "callback_data": f"ok|{pid}"},
        {"text": "⏸ Suspender", "callback_data": f"sus|{pid}"},
    ], [{"text": "✏️ Pedir alteração", "callback_data": f"alt|{pid}"}]]}


def texto_rede(p, rede):
    return (p["texto_ig"] if rede == "ig" else p["texto_fb"]).strip()


def respostas(e, posts):
    r = http(TG + "getUpdates?" + urllib.parse.urlencode({"offset": e["offset"], "timeout": 0}))
    for u in r.get("result", []):
        e["offset"] = u["update_id"] + 1
        msg = u.get("message")
        cb = u.get("callback_query")
        chat = (msg or (cb or {}).get("message") or {}).get("chat", {}).get("id")
        if e["chat_id"] is None and msg:
            e["chat_id"] = chat
            tg("sendMessage", chat_id=chat, text="Olá Cristiano 👋 O TG Publicações está ligado. "
               "Vou enviar-lhe aqui os posts para aprovar.")
            continue
        if chat != e["chat_id"]:
            continue  # ignora outras pessoas
        if cb:
            acao, pid = cb["data"].split("|", 1)
            st = e["posts"].setdefault(pid, {})
            novo = {"ok": "aprovado", "sus": "suspenso", "alt": "alterar"}[acao]
            if st.get("estado") == "publicado":
                tg("answerCallbackQuery", callback_query_id=cb["id"], text="Este post já foi publicado.")
                continue
            st["estado"] = novo
            st["atualizado"] = agora().isoformat(timespec="minutes")
            tg("answerCallbackQuery", callback_query_id=cb["id"],
               text={"aprovado": "Aprovado ✅", "suspenso": "Suspenso ⏸", "alterar": "Escreva o que quer mudar"}[novo])
            if pid in posts:
                tg("editMessageCaption", chat_id=chat, message_id=cb["message"]["message_id"],
                   caption=legenda_aprovacao(posts[pid], novo), reply_markup=teclado(pid))
            if novo == "alterar":
                e["a_espera_alteracao"] = pid
                tg("sendMessage", chat_id=chat, text="✏️ Escreva numa mensagem o que quer mudar neste post. "
                   "O Claude trata da alteração e o post volta para aprovação.")
        elif msg and msg.get("text"):
            pid = e.pop("a_espera_alteracao", None)
            if pid:
                e["posts"].setdefault(pid, {}).setdefault("pedidos", []).append(
                    {"quando": agora().isoformat(timespec="minutes"), "texto": msg["text"]})
                tg("sendMessage", chat_id=chat, text="Anotado 👍 Fica à espera do Claude. Até lá, o post não sai.")
            elif msg["text"].strip().lower() in ("/estado", "estado"):
                linhas = []
                for p in sorted(posts.values(), key=quando):
                    s = e["posts"].get(p["id"], {}).get("estado", "por_aprovar")
                    linhas.append(f"{quando(p):%d/%m %H:%M} · {p['titulo']} · {s}")
                tg("sendMessage", chat_id=chat, text="\n".join(linhas) or "Sem posts.")


def enviar_novos(e, posts):
    for p in sorted(posts.values(), key=quando):
        st = e["posts"].setdefault(p["id"], {})
        if st.get("enviado_para_aprovacao") and st.get("versao") == p.get("versao", 1):
            continue
        if quando(p) < agora():
            continue
        st.update({"estado": "por_aprovar", "versao": p.get("versao", 1)})
        r = tg("sendPhoto", chat_id=e["chat_id"], photo=RAW + p["imagem"],
               caption=legenda_aprovacao(p, "por_aprovar"), reply_markup=teclado(p["id"]))
        st["enviado_para_aprovacao"] = r["result"]["message_id"]


def publicar(e, posts):
    for p in sorted(posts.values(), key=quando):
        st = e["posts"].get(p["id"], {})
        if st.get("estado") != "aprovado" or st.get("versao") != p.get("versao", 1):
            continue
        atraso = (agora() - quando(p)).total_seconds()
        if atraso < 0:
            continue
        if atraso > JANELA_MAX:
            st["estado"] = "expirado"
            tg("sendMessage", chat_id=e["chat_id"], text=f"⚠️ «{p['titulo']}» não saiu: passou a hora há mais de 6 h.")
            continue
        img = RAW + p["imagem"]
        links, erros = {}, []
        for chave in p["paginas"]:
            token = os.environ.get("META_TOKEN_" + chave.upper())
            if not token:
                erros.append(f"falta o segredo META_TOKEN_{chave.upper()}")
                continue
            try:
                pag = http(GRAPH + "me?" + urllib.parse.urlencode(
                    {"fields": "id,name,instagram_business_account", "access_token": token}))
                r = http(GRAPH + f"{pag['id']}/photos", {"url": img, "message": texto_rede(p, "fb"), "access_token": token})
                pid_fb = r.get("post_id") or r.get("id")
                links[f"{NOMES.get(chave, chave)} · Facebook"] = f"https://www.facebook.com/{pid_fb}"
                ig = (pag.get("instagram_business_account") or {}).get("id")
                if ig:
                    c = http(GRAPH + f"{ig}/media", {"image_url": img, "caption": texto_rede(p, "ig"), "access_token": token})
                    for _ in range(10):
                        s = http(GRAPH + f"{c['id']}?" + urllib.parse.urlencode({"fields": "status_code", "access_token": token}))
                        if s.get("status_code") == "FINISHED":
                            break
                        time.sleep(3)
                    m = http(GRAPH + f"{ig}/media_publish", {"creation_id": c["id"], "access_token": token})
                    pl = http(GRAPH + f"{m['id']}?" + urllib.parse.urlencode({"fields": "permalink", "access_token": token}))
                    links[f"{NOMES.get(chave, chave)} · Instagram"] = pl.get("permalink", "")
            except Exception as ex:
                erros.append(f"{chave}: {ex}")
        st.update({"estado": "publicado" if links else "erro", "publicado_em": agora().isoformat(timespec="minutes"),
                   "links": links, "erros": erros})
        txt = f"📣 Publicado: «{p['titulo']}»\n" + "\n".join(f"{k}: {v}" for k, v in links.items())
        if erros:
            txt += "\n\n⚠️ Problemas:\n" + "\n".join(erros)
        tg("sendMessage", chat_id=e["chat_id"], text=txt, disable_web_page_preview="true")


def partilhas(e, posts):
    for pid, st in e["posts"].items():
        if st.get("estado") != "publicado" or st.get("partilha_enviada") or not st.get("links"):
            continue
        t = datetime.datetime.fromisoformat(st["publicado_em"])
        if (agora() - t).total_seconds() < ATRASO_PARTILHA:
            continue
        botoes = []
        for k, url in st["links"].items():
            if "Facebook" in k:
                botoes.append([{"text": "📘 Partilhar no meu Facebook",
                                "url": "https://www.facebook.com/sharer/sharer.php?u=" + urllib.parse.quote(url, safe="")}])
            elif "Instagram" in k and url:
                botoes.append([{"text": "📸 Abrir no Instagram para republicar", "url": url}])
        titulo = posts.get(pid, {}).get("titulo", pid)
        tg("sendMessage", chat_id=e["chat_id"],
           text=f"🔁 Hora de partilhar no seu perfil: «{titulo}»\nNo Facebook escolha «Público». No Instagram toque em 🔁.",
           reply_markup={"inline_keyboard": botoes})
        st["partilha_enviada"] = agora().isoformat(timespec="minutes")


def main():
    e = carregar()
    posts = ler_posts()
    respostas(e, posts)
    if e["chat_id"]:
        enviar_novos(e, posts)
        publicar(e, posts)
        partilhas(e, posts)
    guardar(e)


if __name__ == "__main__":
    main()
