# Python services on guardrl (numba simulator + torch), one image per target:
#   docker build -f deploy/docker/guardrl.Dockerfile --target agent-inference -t pml/agent-inference .
#   docker build -f deploy/docker/guardrl.Dockerfile --target trainer -t pml/trainer .
#
# Every numba kernel is compiled at build time into NUMBA_CACHE_DIR, so pods start without the
# ~30 s JIT. NUMBA_CPU_NAME=generic makes that machine code portable across nodes of one
# architecture; build each architecture natively (or with buildx) rather than copying caches.
# Numba only uses a cache directory it can write to, so the runtime user owns it. USER is
# numeric so Kubernetes can verify runAsNonRoot.
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NUMBA_CACHE_DIR=/opt/numba-cache \
    NUMBA_CPU_NAME=generic \
    GUARDRL_CACHE_DIR=/var/cache/guardrl
RUN pip install --no-cache-dir numpy==1.26.4 numba==0.60.0 "psycopg[binary]==3.2.3" boto3==1.35.54 \
 && pip install --no-cache-dir torch==2.4.0 --index-url https://download.pytorch.org/whl/cpu
RUN useradd --uid 10001 --create-home app \
 && mkdir -p "$NUMBA_CACHE_DIR" "$GUARDRL_CACHE_DIR" \
 && chown app "$NUMBA_CACHE_DIR" "$GUARDRL_CACHE_DIR"
COPY artifacts/pyproject.toml /src/guardrl/pyproject.toml
COPY artifacts/guardrl /src/guardrl/guardrl
COPY services/model-store /src/model-store
RUN pip install --no-cache-dir --no-deps /src/guardrl /src/model-store
COPY ["artifacts/plans_curriculum/C07 Two Storey.json", "/opt/warmup/plan.json"]
USER 10001
RUN GUARDRL_CACHE_DIR=/tmp/warmup-los python -m guardrl.warmup /opt/warmup/plan.json --heuristic \
 && rm -rf /tmp/warmup-los

# The agent service and the trainer carry the pretrained checkpoints and the plans they were
# trained on, with those plans' line-of-sight caches built (and every model warmed) at build
# time, so a new pod is ready in seconds.
FROM base AS with-models
USER root
COPY services/agent-inference /src/agent-inference
RUN pip install --no-cache-dir --no-deps /src/agent-inference
COPY artifacts/final_models /opt/models
COPY apps/web/plans /opt/plans
ENV MODELS_DIR=/opt/models PLANS_DIR=/opt/plans GUARDRL_CACHE_DIR=/opt/sight-cache
RUN mkdir -p /opt/sight-cache && chown 10001 /opt/sight-cache
USER 10001
RUN python -c "from agent_inference.policy import Policies; Policies().preload()"

FROM with-models AS agent-inference
EXPOSE 8080
CMD ["python", "-m", "agent_inference.server"]

# The trainer image runs training jobs from the queue (python -m trainer.worker, as the
# Kubernetes Deployment does) or a whole guardrl training run (the default entry point).
FROM with-models AS trainer
USER root
COPY services/trainer /src/trainer
RUN pip install --no-cache-dir --no-deps /src/trainer
USER 10001
ENTRYPOINT ["python", "-m", "trainer"]
