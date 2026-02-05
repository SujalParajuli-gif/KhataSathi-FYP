FROM node:20-alpine

WORKDIR /app

# installing pnpm globally
RUN npm i -g pnpm

# copying only package files first for faster installs
COPY package.json pnpm-lock.yaml ./

# installing dependencies
RUN pnpm install

# copying the rest of the frontend code
COPY . .

EXPOSE 5173

CMD ["pnpm", "dev", "--host", "0.0.0.0", "--port", "5173"]
