FROM node:20-slim

WORKDIR /app

# sqlite3 requires Python + build tools to compile its native addon
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

# Persist the SQLite database file across container restarts
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    DATABASE_TYPE=sqlite \
    PORT=3001

EXPOSE 3001

CMD ["node", "server.js"]
