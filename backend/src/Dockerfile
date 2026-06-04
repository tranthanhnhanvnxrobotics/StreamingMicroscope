FROM node:20-alpine

WORKDIR /app

# Copy package.json và package-lock.json vào trước để tận dụng cache của Docker
COPY package*.json ./

RUN npm install

# Copy toàn bộ mã nguồn vào container
COPY . .

EXPOSE 5000

# Chạy bằng nodemon trỏ vào src/index.js để tự động reload khi code thay đổi
CMD ["npx", "nodemon", "src/index.js"]