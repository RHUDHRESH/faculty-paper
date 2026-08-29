# The web tier: build the SPA, serve it from nginx, proxy /api and /media to
# the API service. One origin for the browser, so cookies are first-party and
# there is no CORS anywhere in a college's deployment.
#
# Built by docker compose with the build context at the repository root, so
# this file can reach both frontend2/ (the app) and the nginx config beside
# it. The root .dockerignore keeps node_modules, the virtualenv and the
# data directories out of the build context.

FROM node:24-alpine AS build
WORKDIR /app/frontend2
COPY frontend2/package.json frontend2/package-lock.json ./
RUN npm ci
COPY frontend2/ .
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend2/dist /usr/share/nginx/html
EXPOSE 80
