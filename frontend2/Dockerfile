# The SPA and its /api proxy in one container, for Cloud Run.
#
# Serving the built assets is the easy half. The half that matters is the
# proxy: the browser must only ever talk to one origin, because the session is
# a cookie and a cross-site cookie is a cookie that does not arrive. This is
# the same trick `frontend/vercel.json` plays today — /api and /media are
# rewritten to the Django service, so cookies stay first-party and there is no
# CORS configuration to get wrong.

# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so an edit to src/ does not reinstall node_modules.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# `npm run build` runs `tsc -b` first, so a type error fails the image rather
# than shipping a broken bundle that only breaks in somebody's browser.
RUN npm run build

# ---- serve ----------------------------------------------------------------
FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Cloud Run tells the container which port to listen on, and it is not
# always 8080. nginx's own envsubst entrypoint fills these in at start.
ENV PORT=8080
ENV API_ORIGIN=https://faculty-paper-api-635082195334.asia-south1.run.app

EXPOSE 8080
