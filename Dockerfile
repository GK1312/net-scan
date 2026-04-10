FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY .env.example /app/.env

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
