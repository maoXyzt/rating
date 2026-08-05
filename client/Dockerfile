FROM node:22-alpine AS build
WORKDIR /app/client
COPY package.json /app/package.json
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80
