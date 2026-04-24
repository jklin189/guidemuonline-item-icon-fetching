FROM mcr.microsoft.com/playwright:v1.54.2-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY server.mjs ./

ENV NODE_ENV=production
ENV PORT=8080
# Playwright base image ships browsers in /ms-playwright.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 8080

CMD ["npm","start"]

