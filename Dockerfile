FROM python:3.12-slim
# ffmpeg wird später für die kleinere Unterwegs-Qualität gebraucht
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend backend
COPY web web
ENV DATA_DIR=/data WEB_DIR=/app/web PYTHONUNBUFFERED=1
EXPOSE 8080
WORKDIR /app/backend
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
