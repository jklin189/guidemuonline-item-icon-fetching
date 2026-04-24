FROM mcr.microsoft.com/playwright:v1.54.2-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY server.mjs ./

ENV NODE_ENV=production
ENV PORT=8080
# Playwright base image ships browsers in /ms-playwright.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Ensure chromium headless shell exists (Playwright may prefer it).
RUN npx playwright install chromium-headless-shell
EXPOSE 8080

CMD ["npm","start"]

