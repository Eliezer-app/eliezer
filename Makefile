.PHONY: dev dev-down shell logs stop clean test test-up test-down

dev:
	docker compose up -d

dev-down:
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

test: test-up
	@npm test; ret=$$?; $(MAKE) test-down; exit $$ret
