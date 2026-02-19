FROM node:22-slim
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
    git chromium build-essential python3 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2 \
    libpangocairo-1.0-0 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxshmfence1 libnss3 libnspr4 >/dev/null 2>&1 && \
    rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /opt/eliezer
