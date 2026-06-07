FROM node:20-alpine

WORKDIR /app

# install deps first for layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

EXPOSE 2567
CMD ["node", "index.js"]
