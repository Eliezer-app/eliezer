.PHONY: dev stop shell logs clean clean-compacted test test-up test-down export export-html api-docs dump-system status

dev: stop test-down
	rm -f state/eliezer.log
	docker compose up -d --force-recreate
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

clean-compacted:
	sqlite3 state/eliezer.db "UPDATE messages SET archived = 0; DELETE FROM compacted;"
	@echo "Reset: all messages unarchived, compacted table cleared"

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

status:
	@echo "checking localhost:3200/info/memory"
	@curl -sf http://localhost:3200/info/memory | jq -r ' \
		"Context budget: \(.context.budget) tokens", \
		"", \
		"  system:    \(.context.system.tokens) tokens (\(.context.system.pct)%)", \
		"  memory:    \(.context.memory.tokens) tokens (\(.context.memory.pct)%)", \
		"  compacted: \(.context.compacted.tokens) tokens (\(.context.compacted.pct)%) — \(.context.compacted.groups) groups", \
		"  flow:      \(.context.flow.tokens) tokens (\(.context.flow.pct)%) — \(.context.flow.messages) messages", \
		"  total:     \(.context.total.tokens) tokens (\(.context.total.pct)%)", \
		"", \
		"Archived: \(.archived.messages) messages", \
		"Compressions: \(.ops.compressions | length)", \
		"Distillations: \(.ops.distillations | length)"'

dump-system:
	@npx tsx scripts/dump-system.mts state/system-dump.txt
