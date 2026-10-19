# transcriber

A small speech-to-text service (Python, FastAPI), published as `ghcr.io/sibest19/alfred-transcriber:<version>` (amd64). It runs [Parakeet Ultra](https://huggingface.co/moondream/parakeet-ultra) (NVIDIA Parakeet TDT 0.6B v3 post-trained by Moondream; 25 European languages, punctuation, CC BY 4.0) as ONNX through [onnx-asr](https://github.com/istupakov/onnx-asr), on an Intel GPU via ONNX Runtime's OpenVINO provider (`DEVICE=GPU`, needs `/dev/dri/renderD*` and the render group) or on the CPU (`DEVICE=CPU`). The model (`MODEL_REPO`, default `Masterx/parakeet-tdt-0.6b-ultra-onnx`, `MODEL_QUANTIZATION=fp16`) is downloaded into `/models` on first start. GPU kernels are compiled at every start (about 30 s): OpenVINO's on-disk cache (`OPENVINO_CACHE_DIR`) is off by default, because a cached model aborted the process at its first inference on an Arc A310.

- `POST /transcribe`: audio in any format ffmpeg reads (raw body or multipart `file`) → `{"text", "duration_s", "elapsed_s"}`.
- `POST /v1/audio/transcriptions`: the OpenAI-style form of the same.
- `GET /health`: `200` once the model is loaded and warmed up.

Measured on an Intel Arc A310 (fp16): a 197 s voice note in 10 s, a 4 s one in 0.15 s; the same on a Ryzen 9 5900X CPU took 18 s and 0.25 s.
