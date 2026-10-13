# Production image: the Node.js app that serves the board, the API and sign-in.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# CA bundle used to verify TLS connections to Amazon RDS (DB_SSL=rds).
RUN mkdir -p /app/certs \
 && wget -q -O /app/certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

COPY server ./server
COPY public ./public

USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
