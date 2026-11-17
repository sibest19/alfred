# OpenVINO plugin migration — issue #55

Status: core Intel GPU inference validated; remaining acceptance checks are open.
Ubuntu remains at 24.04; the Ubuntu 26.04 upgrade in #47 is a separate validation gate.

## Implementation

- Replace `onnxruntime-openvino==1.24.1` with `onnxruntime==1.32.0` and
  `onnxruntime-ep-openvino==1.8.1`. The plugin wheel bundles OpenVINO
  (`libopenvino.so.2641`) and TBB; do not install a second OpenVINO Python runtime.
  The image retains its Intel OpenCL and Level Zero drivers.
- Register the plugin and choose an OpenVINO hardware GPU explicitly. Pass the
  selected device through `asr_config.sess_options` to both Parakeet sessions.
  Passing it only as the top-level `sess_options` is insufficient: onnx-asr 0.12.0
  supplies default `providers`, which take precedence over the device selection.
  Preprocessing and resampling use the standard CPU provider.
- Retain CPU mode, serialized inference, warmup before readiness and the existing
  lazy CPU retry after GPU inference exceptions. No legacy provider path remains.
  There is no new compatibility shim to remove.
- Cache stays off by default. When enabled, use `load_config` with the OpenVINO
  `CACHE_DIR` property; the plugin ignores the legacy `cache_dir` option. Choose
  a new empty directory, never the old runtime's compilation cache.

References: [plugin installation and registration](https://pypi.org/project/onnxruntime-ep-openvino/1.8.1/),
[onnx-asr API](https://istupakov.github.io/onnx-asr/reference/),
[OpenVINO properties](https://onnxruntime.ai/docs/execution-providers/OpenVINO-ExecutionProvider.html#load_config).

## Repeatable local checks

```sh
docker build --platform linux/amd64 -t alfred-transcriber:parakeet-plugin transcriber
docker run --rm --platform linux/amd64 --entrypoint python \
  alfred-transcriber:parakeet-plugin -m unittest -v test_app
TRANSCRIBER_IMAGE=alfred-transcriber:parakeet-plugin smoke/transcriber.sh
```

The routing test uses the actual onnx-asr loader and synthetic model filenames,
mocking native sessions to verify both encoder and decoder receive the plugin
session options without a `providers` override. Other checks cover device
selection, missing GPU readiness, opt-in cache configuration, warmup and CPU retry.
These checks do not prove GPU execution. The existing CPU smoke exercises actual
model loading and both HTTP upload formats using synthetic speech.

Validated on 2026-11-17, Docker Desktop on an ARM Mac with Linux amd64 emulation:

- Ubuntu 24.04 image build and installation: passed (Python 3.12,
  ONNX Runtime 1.32.0, plugin 1.8.1).
- Nine tests, including native plugin registration/device enumeration: passed.
- Actual Parakeet CPU smoke: passed readiness, raw upload and multipart upload;
  both transcribed “The quick brown fox jumps over the lazy dog.” correctly.
  This is functional evidence, not a native Intel latency benchmark.
- Ubuntu 26.04 / Python 3.14.4, using a temporary Dockerfile with only the base
  image changed: build, nine tests (including native plugin registration) and
  actual CPU smoke passed. Both HTTP upload formats returned the correct sentence.
  This removes the observed installation blocker for #47, but its Intel GPU
  driver/inference validation remains pending. The committed base stays at 24.04.
- With the actual plugin on the CPU-only emulated host, `DEVICE=GPU` correctly
  rejected the missing Intel GPU. The candidate contains no `onnxruntime-openvino`
  distribution.

## Required Intel GPU validation

### Arc A310 maintenance test, 2026-11-17

Native Linux amd64 / Ubuntu 24.04 validation used candidate commit `5d89ef8`,
Python 3.12.3, ONNX Runtime 1.32.0, plugin 1.8.1, onnx-asr 0.12.0 and NumPy 2.5.5.
The Arc A310 used i915 with Intel OpenCL/Level Zero GPU runtime
`23.43.27642.40-1ubuntu3` and Level Zero loader `1.16.1-1build1`.

- All nine updated tests passed. Native registration and enumeration must succeed,
  but the test allows no OpenVINO hardware on AMD hosts without an exposed GPU.
- During an explicitly authorized maintenance window, the current transcriber was
  stopped while the candidate used the GPU. Other services remained running.
  A temporary harness used the unchanged application with model discovery pointed
  directly at existing read-only weights, profiling enabled and ORT automatic
  session fallback disabled. No model/cache downloads or production audio were used.
- Readiness was initially 503, then 200 after model warmup. Synthetic 4 s and 197 s
  speech clips transcribed successfully through raw and multipart HTTP uploads,
  with matching transcripts across formats. Both encoder and decoder profiles
  contained executed `OpenVINOExecutionProvider` nodes.
- An injected recognize exception exercised application-level CPU retry with real
  Parakeet CPU inference and produced the expected short transcript. This simulates
  an inference exception; it does not establish recovery after a GPU driver crash.
- Temporary containers/image were removed and the original production container,
  image and configuration restored, with health verified. Raw profiles and
  infrastructure-specific evidence remain outside this public repository.

This run validates core GPU functionality, not release completion. A controlled
comparison with the previous image, cache restart behavior and Ubuntu 26.04 GPU
checks remain unperformed. The checklist below remains the full acceptance scope.

### Remaining acceptance scope

1. Record GPU model, kernel, render-node permissions, installed Intel OpenCL/Level
   Zero driver versions, image digest, Python version and `pip freeze`. Run the
   previous image and candidate on the same host with the same settings and model.
   Use synthetic short (~4 s) and long (~197 s) speech clips. Keep recordings and
   raw traces outside the public repository.
2. Pass `/dev/dri` and the render group to the candidate container with `DEVICE=GPU`.
   Confirm the selected OpenVINO GPU metadata in startup logs. Enable ORT profiling
   on `asr_config["sess_options"]` in a temporary validation script before calling
   `onnx_asr.load_model`. Capture both model sessions, call `disable_fallback()` on
   them, transcribe both clips and inspect `end_profiling()` output. Require executed
   `OpenVINOExecutionProvider` nodes in **both** session profiles and device activity
   in `intel_gpu_top`. Merely listing an available provider or passing `/health`
   does not prove GPU execution. Some unsupported graph nodes may execute on CPU.
3. Compare transcript correctness, startup/warmup time, inference latency and peak
   host/GPU memory against the previous image. Verify a missing render device fails
   readiness, and exercise an injected GPU inference exception to check the CPU
   retry returns a transcription. Automated retry tests simulate this failure;
   hardware recovery remains unverified.
4. Keep caching disabled for the first comparison. If retaining cache support,
   repeat cold start, restart and first inference with a fresh cache directory.
   Check short and long clips after each restart. Do not enable cache by default
   until this passes; the legacy Arc A310 crash is not evidence about this plugin.
5. Rebuild and repeat installation/imports, CPU smoke and GPU checks on Ubuntu 26.04
   / Python 3.14 before merging #47. Dependency resolution or wheel availability
   alone does not establish runtime compatibility. Attach sanitized measurements
   to the migration PR and leave #55 open until hardware checks pass.

## Rollback and cleanup

Before rollout, record the previously deployed image digest outside this repository.
Rollback means redeploying that complete image with its previous configuration,
not reinstalling `onnxruntime-openvino` alongside the plugin. Keep `/models` so model
weights need not be downloaded again; use separate compilation cache directories
for each runtime and leave caching disabled during rollback. No database migration
or HTTP client changes are needed.

After acceptance, retire the previous image from active deployment configuration,
remove its compilation cache, and verify the candidate's `pip freeze` has no
`onnxruntime-openvino`. Never restore the old wheel into the candidate environment.
The application-level CPU retry is supported behavior, not a migration fallback.
