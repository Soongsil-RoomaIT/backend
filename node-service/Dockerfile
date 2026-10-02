FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/main.js"]
