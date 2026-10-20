# Motore di monitoraggio 24/7 headless (server, NAS, Raspberry Pi)
FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY ui ./ui
ENV FFMPEG_PATH=/usr/bin/ffmpeg DATA_DIR=/data HOST=0.0.0.0 PORT=8686
VOLUME /data
EXPOSE 8686
LABEL org.opencontainers.image.authors="Massimiliano Mascioli Trippa <max@maxtrip.it>"
CMD ["node", "src/server.js"]
