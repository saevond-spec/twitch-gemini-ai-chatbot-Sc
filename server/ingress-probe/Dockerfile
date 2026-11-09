FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg nginx libnginx-mod-rtmp openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.mjs /app/server.mjs
COPY nginx.conf /etc/nginx/nginx.conf
ENV NODE_ENV=production PORT=10000
EXPOSE 10000
USER node
CMD ["node","/app/server.mjs"]
