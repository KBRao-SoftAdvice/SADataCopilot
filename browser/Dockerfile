FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates sqlite3 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 app
USER app
WORKDIR /app

RUN pip install --no-cache-dir --user pandas

COPY --chown=app:app package.json package-lock.json ./
RUN npm install --omit=dev

COPY --chown=app:app server.py notebook.html sidecar.mjs ./
COPY --chown=app:app mcp/ ./mcp/

RUN mkdir -p /app/.workspaces /home/app/.claude/projects /home/app/.copilot/session-state

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NOTEBOOK_HOST=0.0.0.0 \
    OPENAI_BASE_URL=https://api.openai.com/v1
EXPOSE 8787

CMD ["python3", "-u", "server.py"]
