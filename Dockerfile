# ============================================================
# Dockerfile - Telegram OTP Bot
# Node.js 20 Alpine + better-sqlite3 native build
# ============================================================

# ---- Build stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# প্যাকেজ files কপি করে dependencies install
COPY package.json package-lock.json ./
RUN npm ci --production

# ---- Runtime stage ----
FROM node:20-alpine

# better-sqlite3 এর জন্য দরকার
RUN apk add --no-cache python3 make g++

WORKDIR /app

# প্যাকেজ + সব source files কপি
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Source files কপি
COPY index.js ./
COPY config.js ./
COPY database.js ./
COPY src/ ./src/

# Data directory (SQLite database থাকবে এখানে)
RUN mkdir -p /app/data

# Non-root user
RUN addgroup -S botgroup && adduser -S botuser -G botgroup
RUN chown -R botuser:botgroup /app

USER botuser

# Health check (container alive আছে কিনা)
HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));" || exit 0

EXPOSE 3000

CMD ["node", "index.js"]
