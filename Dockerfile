FROM node:22-alpine

WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy server and static frontend assets
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
