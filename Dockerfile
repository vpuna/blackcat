# blackcat in a container. It follows the README's own install steps, so building this
# image is also a test of them.
#
#   docker build -t blackcat .
#   docker run -d --name blackcat --restart unless-stopped -e TZ=Europe/Lisbon \
#     -v blackcat-data:/blackcat/data -v blackcat-home:/home/blackcat blackcat
#
# What is yours is kept outside the image, in three places:
#   /blackcat/data           settings, messages, logins, logs
#   /home/blackcat           the Claude Code sign-in (optional: only with a model)
#   /blackcat/user-plugins   plugins of your own (optional)
FROM node:22-bookworm-slim AS base

# The system tools the README lists (README, "Install"), and two a container needs: tini to
# pass on signals and clean up after ended processes, procps for looking at processes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git zstd gnupg openssh-client ffmpeg unzip imagemagick poppler-utils \
      ca-certificates tzdata tini procps \
 && rm -rf /var/lib/apt/lists/*

# Runs as an ordinary user, never as root. 99:100 is what a NAS such as Unraid gives its
# shared folders; use --user to run as another.
RUN useradd --uid 99 --gid 100 --create-home --home-dir /home/blackcat --shell /bin/bash blackcat

WORKDIR /blackcat
COPY package.json package-lock.json ./
# tini is the first process in every image made from this: it passes on a stop, and clears
# away processes that have ended (without it they linger, and look as if they were running).
ENTRYPOINT ["tini", "--"]

# ---- the compiler some libraries need when they are installed (the database library is
#      built on the machine). Not carried into the image that is run.
FROM base AS tools
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

# ---- everything, with the tools the tests need: `docker build --target test`, then
#      `docker run --rm <image> npm test`
FROM tools AS test
RUN npm ci
COPY . .
RUN mkdir -p data user-plugins && chown -R blackcat:users /blackcat /home/blackcat
USER blackcat
CMD ["npm", "test"]

# ---- the libraries, as they are run (no linter, no formatter)
FROM tools AS libraries
RUN npm ci --omit=dev

# ---- what is run
FROM base AS run
COPY --from=libraries /blackcat/node_modules ./node_modules
# Claude Code runs the model, under your own sign-in (optional: blackcat works without it).
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force
COPY . .
RUN ln -s /blackcat/bin/bc.js /usr/local/bin/blackcat \
 && ln -s /blackcat/bin/bc.js /usr/local/bin/bc \
 && mkdir -p data user-plugins \
 && chown -R blackcat:users /blackcat/data /blackcat/user-plugins /blackcat/agent /home/blackcat

USER blackcat
ENV HOME=/home/blackcat \
    TZ=UTC \
    BLACKCAT_KEEPER=container \
    DISABLE_AUTOUPDATER=1
VOLUME ["/blackcat/data", "/home/blackcat"]

# Its own supervisor runs the agent and each message source, and stops them when the
# container stops. `docker restart` (or the restart policy) is what starts it again.
HEALTHCHECK --interval=60s --timeout=10s --start-period=40s CMD test -S /blackcat/data/run/services.sock || exit 1
CMD ["blackcat", "service", "run"]
