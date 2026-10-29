# Production multi-stage Dockerfile for CampusShare X
# Compatible with Koyeb, Render, Fly.io, Railway, and standard Docker hosts

FROM node:24-alpine AS builder

WORKDIR /app

# Install all dependencies (including devDependencies needed for Vite build & typecheck)
COPY package*.json ./
RUN npm ci

# Copy source code and compile production assets
COPY . .
RUN npm run build

# Production runtime stage
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled frontend and server backend
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server

EXPOSE 3001

CMD ["npm", "start"]
