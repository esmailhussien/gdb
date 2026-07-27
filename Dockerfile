FROM ghcr.io/osgeo/gdal:ubuntu-small-latest

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt

COPY app.py mapplex_schema.py mapplex_attachments.py ./

ENV PORT=8080
ENV MAX_UPLOAD_MB=512
ENV CONVERT_TIMEOUT_SECONDS=1800

EXPOSE 8080

CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
