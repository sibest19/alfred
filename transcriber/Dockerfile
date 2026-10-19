# Ubuntu 24.04 for Intel's GPU compute runtime (OpenCL + Level Zero) with Arc (DG2) support
FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
      intel-opencl-icd libze1 libze-intel-gpu1 \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
COPY requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt
COPY app.py /app/app.py
ENV PATH=/opt/venv/bin:$PATH MODELS_DIR=/models HF_HOME=/models/hf HOME=/tmp PYTHONUNBUFFERED=1
WORKDIR /app
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
