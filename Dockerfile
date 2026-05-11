FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 5000
ENV NODE_ENV=production
ENV PORT=5000
ENV DATABASE_URL=./database.sqlite

CMD ["node", "dist/index.js"]
