FROM node:22-alpine
WORKDIR /app/server
COPY package.json /app/package.json
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server/src ./src
RUN mkdir -p /app/uploads /app/data /app/inbox
EXPOSE 3000
CMD ["npm", "start"]
