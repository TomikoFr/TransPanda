FROM python:3.12-slim
WORKDIR /app
COPY server.py /app/server.py
COPY index.html /app/index.html
COPY assets /app/assets
COPY runtime-data/gtfs.sqlite /data/gtfs.sqlite
ENV PORT=8080
ENV GTFS_DB=/data/gtfs.sqlite
RUN useradd --uid 10001 --create-home appuser && chmod -R a+rX /app /data
USER appuser
CMD ["python", "server.py"]
