# syntax=docker/dockerfile:1.7

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Kathmandu

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        default-mysql-client \
        jq \
        restic \
        tini \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY run-backup.sh /usr/local/bin/khatasathi-recovery-backup
RUN chmod 0755 /usr/local/bin/khatasathi-recovery-backup \
    && mkdir -p /payload/uploads /payload/documents /payload/backup /status /repository /cache

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/khatasathi-recovery-backup"]
