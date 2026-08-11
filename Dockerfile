FROM node:22-slim

# Install Chromium + Git + Cron
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    git \
    cron \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer expects chromium here
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Install cron schedule
COPY scraper-cron /etc/cron.d/scraper-cron
RUN chmod 0644 /etc/cron.d/scraper-cron && crontab /etc/cron.d/scraper-cron

CMD ["cron", "-f"]
