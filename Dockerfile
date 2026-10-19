FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    IRSC_MCP_HOST=0.0.0.0 \
    IRSC_MCP_PORT=8765

WORKDIR /app
RUN addgroup --system app && adduser --system --ingroup app app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && python -c "import sqlite3; sqlite3.connect(':memory:').execute('CREATE VIRTUAL TABLE t USING fts5(x)')"

COPY --chown=app:app riverguide ./riverguide
COPY --chown=app:app corpus ./corpus
COPY --chown=app:app data/sections.db ./data/sections.db
# Build the search index once at image build to fail fast on a broken corpus.
RUN python -c "from riverguide.index import default_index; print(len(default_index().pages), 'pages indexed')"

# Commit this image was built from; reported as MCP serverInfo.version.
ARG IRSC_BUILD_SHA=""
ENV IRSC_BUILD_SHA=$IRSC_BUILD_SHA

USER app
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import socket; socket.create_connection(('127.0.0.1', 8765), 3).close()"
CMD ["python", "-m", "riverguide.server"]
