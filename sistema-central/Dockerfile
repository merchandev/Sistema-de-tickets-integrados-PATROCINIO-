FROM node:24.11.1-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir -p data storage/uploads storage/tickets && chown -R node:node data storage
USER node
EXPOSE 4000
CMD ["node", "src/server.js"]
