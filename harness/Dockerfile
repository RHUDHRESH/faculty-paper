# The college's own Gemma inference harness.
#
# This build is the CPU one: it runs anywhere, slowly, and is what the tests
# and a small VM get. For Cloud Run with an L4, build the GPU variant below
# -- same code, a CUDA-enabled llama.cpp, and a bigger base image.
#
# CPU build:
#   docker build -t gemma-harness harness/
#
# GPU build (Cloud Run GPU / GCE): swap the base image for
#   nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
# and set CMAKE_ARGS="-DGGML_CUDA=on" before the pip install. Nothing else
# changes; engine.py turns the GPU on by itself when llama.cpp supports
# offload (HARNESS_N_GPU_LAYERS=0 forces the CPU even then).
FROM python:3.12-slim

# llama-cpp-python builds from source: it needs a compiler and cmake. There
# are no prebuilt wheels that pin the CUDA/CPU split this service needs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY engine.py app.py ./

# Weights are NOT baked in. They are the college's licensed copy of Gemma,
# pulled from the college's own bucket at cold start (engine.py), so the
# image stays small, the licence stays clean, and a new model is a bucket
# upload rather than a rebuild.
ENV HARNESS_WEIGHTS_DIR=/models \
    HARNESS_MAIN_MODEL=gemma-3-12b-it-q4_k_m \
    HARNESS_FAST_MODEL=gemma-3-4b-it-q4_k_m \
    HARNESS_MAIN_KEEP_ALIVE=10m \
    HARNESS_FAST_KEEP_ALIVE=30m
VOLUME /models

# Cloud Run injects $PORT; the default matches the backend's local default.
ENV HARNESS_HOST=0.0.0.0
CMD ["sh", "-c", "uvicorn app:app --host ${HARNESS_HOST} --port ${PORT:-8300} --timeout-keep-alive 0"]
