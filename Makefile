.PHONY: seed clean up down run shell logs watch stop build

# Build the Docker image
build:
	docker compose build

# Generate seed.sh from prompt
seed:
	@bash generate-seed.sh

clean:
	docker compose down 2>/dev/null || true
	rm -f mount/seed.sh
	rm -rf logs/*
	@bash generate-seed.sh

# Container lifecycle
up:
	docker compose up -d

down:
	docker compose down

# Run the seed (starts the experiment)
run: up
	docker compose exec eliezer /opt/eliezer/seed.sh

# Get a shell into the container
shell:
	docker compose exec eliezer /bin/bash

# View logs
logs:
	@cat logs/seed-output.sh 2>/dev/null || echo "No output yet"

# Watch the agent's progress
watch:
	tail -f logs/*.log logs/*.sh 2>/dev/null || echo "No logs yet"

# Stop the agent process but keep container
stop:
	docker compose exec eliezer pkill -f "node\|npm\|tsx" 2>/dev/null || true
	docker compose exec eliezer pkill -f "seed.sh" 2>/dev/null || true
	@echo "Agent stopped. Container still running. Use 'make shell' to inspect."

# Check agent status
status:
	@echo "=== Container ==="
	@docker compose ps
	@echo ""
	@echo "=== Progress ==="
	@docker compose exec eliezer cat /var/run/eliezer/progress 2>/dev/null || echo "No progress file yet"
	@echo ""
	@echo "=== Processes ==="
	@docker compose exec eliezer ps aux 2>/dev/null || echo "Container not running"
