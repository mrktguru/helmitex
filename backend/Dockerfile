# Образ API и PDF-воркера портала (один образ, разные команды в docker-compose).
FROM node:20-bookworm-slim

# pdf2pic -> GraphicsMagick + Ghostscript; decode_datamatrix.py -> Python + Pillow + libdmtx; Prisma -> openssl
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      graphicsmagick ghostscript openssl ca-certificates \
      python3 python3-pil python3-pip libdmtx0b \
 && pip3 install --no-cache-dir --break-system-packages pylibdmtx==0.1.10 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY assets ./assets
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
