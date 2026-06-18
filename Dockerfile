FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY backend ./backend

ENV NODE_ENV=production
ENV PORT=8081

EXPOSE 8081

CMD ["npm", "run", "backend:dev"]
