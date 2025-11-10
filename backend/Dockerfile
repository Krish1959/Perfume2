# /backend/Dockerfile
FROM python:3.11-slim

# (optional) system deps you use
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install Python deps (requirements.txt is inside backend/)
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# copy ONLY backend code (context is already /backend)
COPY . /app

# Render provides $PORT at runtime; default to 8000 locally
ENV PORT=8000

# shell-form command, single worker as requested
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1
