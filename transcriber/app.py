"""Speech-to-text over HTTP: Parakeet (NeMo TDT, ONNX) on an Intel GPU through OpenVINO, or on the CPU.

POST /transcribe                 raw audio body (any format ffmpeg reads) or multipart field "file"
POST /v1/audio/transcriptions    OpenAI-style multipart ("file"; "model" is ignored)
GET  /health                     200 once the model is loaded and warmed up
"""

import logging
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
import onnx_asr
from fastapi import FastAPI, HTTPException, Request, UploadFile
from huggingface_hub import snapshot_download

MODEL_REPO = os.environ.get("MODEL_REPO", "Masterx/parakeet-tdt-0.6b-ultra-onnx")
MODEL_TYPE = os.environ.get("MODEL_TYPE", "nemo-parakeet-tdt-0.6b-v3")
MODEL_QUANTIZATION = os.environ.get("MODEL_QUANTIZATION", "fp16") or None  # empty = fp32
MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/models"))
DEVICE = os.environ.get("DEVICE", "GPU").upper()  # GPU (OpenVINO) | CPU
MAX_SECONDS = int(os.environ.get("MAX_SECONDS", "1200"))
OPENVINO_CACHE_DIR = os.environ.get("OPENVINO_CACHE_DIR", "")

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("transcriber")

app = FastAPI(title="transcriber")
state: dict = {"model": None, "error": None}
lock = threading.Lock()  # one inference at a time: one GPU, and voice notes are short


def model_files() -> Path:
    suffix = f".{MODEL_QUANTIZATION}" if MODEL_QUANTIZATION else ""
    patterns = ["config.json", "vocab.txt", f"encoder-model{suffix}.onnx", f"decoder_joint-model{suffix}.onnx"]
    if not MODEL_QUANTIZATION:
        patterns.append("encoder-model.onnx.data")
    target = MODELS_DIR / MODEL_REPO.replace("/", "__")
    return Path(snapshot_download(MODEL_REPO, local_dir=target, allow_patterns=patterns))


def providers():
    if DEVICE == "CPU":
        return ["CPUExecutionProvider"]
    options = {"device_type": "GPU"}
    # Off by default: with onnxruntime-openvino 1.23 on an Arc A310, a model loaded from this cache aborts
    # the process at the first inference ("Could not find a suitable kernel for fullyconnected"), while
    # compiling from scratch (~30 s at start) works.
    if OPENVINO_CACHE_DIR:
        Path(OPENVINO_CACHE_DIR).mkdir(parents=True, exist_ok=True)
        options["cache_dir"] = OPENVINO_CACHE_DIR
    return [("OpenVINOExecutionProvider", options), "CPUExecutionProvider"]


def load() -> None:
    try:
        started = time.monotonic()
        path = model_files()
        model = onnx_asr.load_model(MODEL_TYPE, path, quantization=MODEL_QUANTIZATION, providers=providers())
        # The first GPU run compiles the kernels.
        model.recognize(np.zeros(16000, dtype=np.float32))
        state["model"] = model
        log.info("model %s (%s) ready on %s in %.1fs", MODEL_REPO, MODEL_QUANTIZATION or "fp32", DEVICE,
                 time.monotonic() - started)
    except Exception as err:  # keep serving /health with the error
        state["error"] = repr(err)
        log.exception("model load failed")


threading.Thread(target=load, daemon=True).start()


def cpu_model():
    """CPU copy of the model, loaded on first need (a few seconds)."""
    if state.get("cpu") is None:
        state["cpu"] = onnx_asr.load_model(MODEL_TYPE, model_files(), quantization=MODEL_QUANTIZATION,
                                           providers=["CPUExecutionProvider"])
    return state["cpu"]


def decode(audio: bytes) -> np.ndarray:
    """Any input format to 16 kHz mono float32 via ffmpeg."""
    try:
        out = subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", "pipe:0", "-t", str(MAX_SECONDS),
             "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
            input=audio, capture_output=True, check=True, timeout=120,
        ).stdout
    except subprocess.CalledProcessError as err:
        raise HTTPException(400, f"cannot decode audio: {err.stderr.decode(errors='replace')[:300]}") from err
    return np.frombuffer(out, dtype=np.float32)


def transcribe(audio: bytes) -> dict:
    model = state["model"]
    if model is None:
        raise HTTPException(503, state["error"] or "model is loading")
    if not audio:
        raise HTTPException(400, "empty body")
    wave = decode(audio)
    started = time.monotonic()
    with lock:
        try:
            text = model.recognize(wave) if len(wave) else ""
        except Exception:
            if DEVICE == "CPU":
                raise
            # OpenVINO's GPU plugin occasionally returns a wrongly shaped encoder output for some input
            # lengths (onnx-asr then asserts): redo that clip on the CPU.
            log.warning("GPU inference failed for %.1fs of audio, retrying on the CPU", len(wave) / 16000, exc_info=True)
            text = cpu_model().recognize(wave)
    elapsed = time.monotonic() - started
    seconds = len(wave) / 16000
    log.info("transcribed %.1fs of audio in %.2fs", seconds, elapsed)
    return {"text": str(text).strip(), "duration_s": round(seconds, 2), "elapsed_s": round(elapsed, 3)}


async def body_audio(request: Request) -> bytes:
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        form = await request.form()
        file = form.get("file")
        if not isinstance(file, UploadFile):
            raise HTTPException(400, 'multipart needs a "file" field')
        return await file.read()
    return await request.body()


@app.post("/transcribe")
async def post_transcribe(request: Request):
    return transcribe(await body_audio(request))


@app.post("/v1/audio/transcriptions")
async def openai_transcriptions(request: Request):
    return {"text": transcribe(await body_audio(request))["text"]}


@app.get("/health")
def health():
    if state["model"] is None:
        raise HTTPException(503, state["error"] or "model is loading")
    return {"model": MODEL_REPO, "quantization": MODEL_QUANTIZATION or "fp32", "device": DEVICE}
