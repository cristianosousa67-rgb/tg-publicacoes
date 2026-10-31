# TG Publicações

Robô que publica os posts da TodosGanham no Facebook e no Instagram, com aprovação pelo Telegram.

- `posts/` · os posts preparados pelo Claude (texto, imagem, dia e hora)
- `media/` · as imagens (públicas, usadas pelo Meta e pelo Telegram)
- `robo/robo.py` · o robô
- `estado/estado.json` · o que foi aprovado, suspenso e publicado (escrito pelo robô)

O robô corre a cada 10 minutos no GitHub Actions. No Telegram: ✅ Aprovar, ⏸ Suspender, ✏️ Pedir alteração. Escreva `estado` para ver a lista.
Segredos: `TELEGRAM_TOKEN`, `META_TOKEN_TODOSGANHAM`.
