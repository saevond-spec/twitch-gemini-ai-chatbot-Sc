FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg nginx libnginx-mod-rtmp openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /var/log/nginx /var/lib/nginx /run/nginx \
 && chown -R node:node /var/log/nginx /var/lib/nginx /run/nginx
WORKDIR /app
COPY server.mjs /app/server.mjs
COPY sleipnir-relay.mjs /app/sleipnir-relay.mjs
COPY nginx.conf /etc/nginx/nginx.conf
ENV NODE_ENV=production PORT=10000
EXPOSE 10000
USER node
CMD ["node","/app/server.mjs"]
