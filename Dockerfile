FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update -qq && \
    apt-get install -y -qq nodejs npm sqlite3 cron curl build-essential python3 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/eliezer /var/log/eliezer /var/run/eliezer

WORKDIR /opt/eliezer

CMD ["/bin/bash"]
