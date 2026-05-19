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

# Rebuild sqlite3 from source inside the container so it links against
# the correct glibc version rather than using a prebuilt binary from the host
RUN npm rebuild sqlite3 --build-from-source

COPY server.js ./

# Persist the SQLite database file across container restarts
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    DATABASE_TYPE=sqlite \
    PORT=3001

EXPOSE 3001

CMD ["node", "server.js"]
