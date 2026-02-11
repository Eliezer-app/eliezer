.PHONY: dev stop shell logs clean test test-up test-down export export-html api-docs dump-system

dev: stop test-down
	docker compose up -d
	docker compose restart eliezer
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if curl -sf http://localhost:3200/info/health >/dev/null 2>&1; then \
			echo "eliezer is healthy"; exit 0; \
		fi; \
		if ! docker compose ps eliezer --format '{{.State}}' 2>/dev/null | grep -q running; then \
			echo "ERROR: eliezer crashed on startup:"; \
			docker compose logs eliezer --tail=20; \
			exit 1; \
		fi; \
		sleep 1; \
	done; \
	echo "ERROR: eliezer not healthy after 10s:"; \
	docker compose logs eliezer --tail=20; \
	exit 1

stop:
	docker compose down

shell:
	docker compose exec eliezer /bin/bash

logs:
	docker compose logs -f

clean:
	docker compose down -v 2>/dev/null || true
	docker compose -f docker-compose.test.yml down -v 2>/dev/null || true

test-up:
	docker compose -f docker-compose.test.yml up -d

test-down:
	docker compose -f docker-compose.test.yml down

test: stop test-up
	@npm test; ret=$$?; $(MAKE) test-down; exit $$ret

export:
	@npx tsx export-chat.mts

export-html:
	@npx tsx export-chat-html.mts

api-docs:
	@npx tsx -e "const s=require('fs').readFileSync('server.mts','utf-8');for(const l of s.split('\n')){const m=l.match(/^\t\t\/\/ ?(.*)/);if(m)console.log(m[1])}"

dump-system:
	@npx tsx scripts/dump-system.mts state/system-dump.txt
