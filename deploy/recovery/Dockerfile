# syntax=docker/dockerfile:1.7

ARG RESTIC_VERSION=0.19.1
FROM restic/restic:${RESTIC_VERSION}@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 AS restic

FROM debian:bookworm-slim

ARG RESTIC_VERSION=0.19.1
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Kathmandu

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        default-mysql-client \
        jq \
        tini \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY --from=restic /usr/bin/restic /usr/bin/restic
COPY run-backup.sh /usr/local/bin/khatasathi-recovery-backup
RUN restic version | grep -F "restic ${RESTIC_VERSION}" \
    && chmod 0755 /usr/local/bin/khatasathi-recovery-backup \
    && mkdir -p /payload/uploads /payload/documents /payload/backup /status /repository /cache

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/khatasathi-recovery-backup"]
