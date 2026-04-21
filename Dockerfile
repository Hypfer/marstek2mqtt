FROM node:lts-alpine

WORKDIR /app
ENV LOGLEVEL="info"
ENV MQTT_BROKER_URL="mqtt://127.0.0.1"
ENV POLL_IP="192.168.1.100"
ENV POLL_INTERVAL="5000"
ENV ENERGY_IN_OFFSET="0.0"
ENV ENERGY_OUT_OFFSET="0.0"

COPY package.json /app
COPY package-lock.json* /app

RUN npm install --omit=dev

COPY . /app

CMD ["node", "app.js"]
