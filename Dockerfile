FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace=@selection/api && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/src/schema.sql apps/api/dist/schema.sql
COPY --from=build /app/apps/web/dist apps/web/dist
EXPOSE 6754
CMD ["node", "apps/api/dist/server.js"]
