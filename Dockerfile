FROM node:22-alpine AS build

# better-sqlite3 is a native module; the toolchain is needed whenever no
# prebuilt binary matches this platform/node combination.
RUN apk add --no-cache python3 make g++

WORKDIR /app
# scripts/ comes before the install because postinstall runs setup-assets.mjs.
# Installing with --ignore-scripts instead is not an option: better-sqlite3
# needs its install script to fetch or compile the native binary.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
# setup-assets runs again inside `npm run build` — it is idempotent, and this
# is what puts the soundfont in static/ before vite copies it into build/.
# The prune then drops the 58MB soundfont *package* from the runtime image
# while the one file we copied stays in the build output.
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    BODY_SIZE_LIMIT=64M

# Migrations ship with the image and run at boot — see src/lib/server/db/index.ts.
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "build"]
