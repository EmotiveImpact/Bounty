# The Bounty API and its Open Prices import loop, for a small always-on host
# with a persistent disk mounted at /data (Railway, Fly.io or similar). The
# React app is built and served separately by Vercel. This is the persistent
# option; the free demo runs entirely on Vercel. See docs/DEPLOY.md.
FROM node:24-slim
ENV NODE_ENV=production \
    BOUNTY_DATA_DIR=/data \
    BOUNTY_LISTEN_HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
# The tests are not needed at run time. The fixtures stay: imports compare
# files against them so sample data is never taken as live evidence.
RUN rm -f server/*.test.mjs server/test-support.mjs
CMD ["node", "server/start.mjs"]
