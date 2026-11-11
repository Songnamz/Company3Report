FROM node:22-alpine
ENV NODE_ENV=production NODE_NO_WARNINGS=1 TZ=Asia/Bangkok DATA_DIR=/data PORT=3000
WORKDIR /app
COPY server.js import.js ./
COPY views ./views
COPY public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
