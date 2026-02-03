.PHONY: build run shell logs status stop clean purge

build:
	docker compose build

run: build
	@mkdir -p mount/state logs
	@rm -rf mount/node_modules
	@cp eliezer.mts prompt.txt credentials.env package.json package-lock.json mount/
	docker compose up --attach eliezer

shell:
	docker compose exec eliezer /bin/bash

logs:
	docker compose logs -f

status:
	docker compose exec eliezer ps aux

stop:
	docker compose down

clean:
	docker compose down 2>/dev/null || true
	rm -rf mount logs

purge: clean
	docker compose down -v 2>/dev/null || true
