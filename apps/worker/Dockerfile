FROM node:22-alpine
# 7-Zip extracts tcgcsv price archives (tcgcsv-history step).
RUN apk add --no-cache 7zip
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @isp/worker... build
ENV NODE_ENV=production
ENV ISP_ENV=staging
CMD ["node", "apps/worker/dist/index.js"]
