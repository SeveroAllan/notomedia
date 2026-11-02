FROM node:22-alpine

WORKDIR /app

# Navegador TribeMD para os cofres por conta.
RUN apk add --no-cache chromium xvfb nss freetype harfbuzz ca-certificates ttf-freefont

# Copia manifestos de dependência
COPY package*.json ./

# Instala dependências de produção
RUN npm ci

# Copia código-fonte e configurações
COPY tsconfig.json ./
COPY agent.md ./agent.md
COPY src ./src
COPY scripts ./scripts

# Porta padrão da aplicação HTTP
EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

# Aplicativo único: painel, webhook, API fiscal e worker embutido.
CMD ["npm", "start"]
