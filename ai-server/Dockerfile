FROM node:20-alpine AS builder
RUN apk add --no-cache bash build-base curl
WORKDIR /workspace/ai-server
COPY ai-server/package*.json ./
RUN npm ci
COPY ai-server/tsconfig.json ./
COPY ai-server/src/ ./src/
COPY ai-server/native/ ./native/
COPY ai-server/scripts/setup_sanotts.sh ./scripts/setup_sanotts.sh
COPY sanoTTS-jp/ /workspace/sanoTTS-jp/
RUN npm run setup:sanotts && npm run build

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 ffmpeg
COPY ai-server/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /workspace/ai-server/dist/ ./dist/
COPY --from=builder /workspace/ai-server/.sanotts/ ./.sanotts/
COPY NOTICE-SANOTTS.md ./NOTICE-SANOTTS.md
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
