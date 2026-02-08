.PHONY: dev dev-stop shell logs stop clean test test-up test-down export export-html api-docs

dev: test-down
	docker compose up -d
	docker compose restart eliezer

dev-stop:
	docker compose down

shell:
	docker compose exec eliezer /bin/bash

logs:
	docker compose logs -f

stop:
	docker compose down

clean:
	docker compose down -v 2>/dev/null || true
	docker compose -f docker-compose.test.yml down -v 2>/dev/null || true

test-up:
	docker compose -f docker-compose.test.yml up -d

test-down:
	docker compose -f docker-compose.test.yml down

test: dev-stop test-up
	@npm test; ret=$$?; $(MAKE) test-down; exit $$ret

export:
	@npx tsx export-chat.mts

export-html:
	@npx tsx export-chat-html.mts

api-docs:
	@npx tsx -e "const s=require('fs').readFileSync('server.mts','utf-8');for(const l of s.split('\n')){const m=l.match(/^\t\t\/\/ ?(.*)/);if(m)console.log(m[1])}"
