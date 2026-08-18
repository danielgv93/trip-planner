FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY icons /usr/share/nginx/html/icons
COPY js /usr/share/nginx/html/js
COPY styles /usr/share/nginx/html/styles

RUN chmod -R a+rX /usr/share/nginx/html /etc/nginx/conf.d

EXPOSE 80
