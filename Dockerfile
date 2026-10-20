# Agent Village em container: observa as sessões do Claude Code e do Codex do host (somente leitura) e mostra a
# vila em http://127.0.0.1:4173/village/. Suba com `docker compose up -d` (veja docker-compose.yml).
# Sem dependências de produção: só o Node e os arquivos do app. Execução real de missões fica desligada aqui,
# porque as CLIs e os logins ficam no host.
FROM node:22-alpine

ENV NODE_ENV=production \
    VILLAGE_IN_DOCKER=1 \
    OPS_ROOM_PORT=4173 \
    HOME=/home/node \
    AGENT_VILLAGE_HOME=/data \
    CLAUDE_CONFIG_DIR=/claude \
    CODEX_HOME=/codex

WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY scripts/claude-statusline-tap.mjs ./scripts/

USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4173/api/health >/dev/null || exit 1
CMD ["node", "server.js"]
