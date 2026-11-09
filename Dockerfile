FROM node:22-alpine

# iputils: ICMP ping ile çevrimiçi kontrolü için
RUN apk add --no-cache iputils

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

ENV NODE_ENV=production
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["node", "server.js"]
