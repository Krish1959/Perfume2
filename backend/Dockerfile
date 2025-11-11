# syntax=docker/dockerfile:1
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg build-essential && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install deps (paths relative to REPO ROOT)
# COPY backend/requirements.txt /app/requirements.txt
COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# copy app
COPY backend /app/backend
COPY frontend /app/frontend

EXPOSE 8000
WORKDIR /app/backend
ENV PORT=8000
ENV HOST=0.0.0.0

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

