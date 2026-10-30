# MongoDB with the app-user init script baked in, so the stack needs no bind mount from the repository
# checkout (works the same on a laptop, a VPS and Coolify). The script runs only on an empty data volume.
FROM mongo:8
COPY init-app-user.js /docker-entrypoint-initdb.d/10-init-app-user.js
