FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY memory-service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY memory-service/app.py memory-service/extraction_rules.py memory-service/lifecycle.py memory-service/memory_store.py ./
RUN mkdir -p /data

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=3)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]
