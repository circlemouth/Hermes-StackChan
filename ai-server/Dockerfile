FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
