APP_DIR := /opt/eliezer
NODE_VERSION := 22

.PHONY: setup deploy ssh-key install-deps install-swap install-app configure install-searxng enable status logs

# Full setup: deps → swap → app → pause for .env → searxng → systemd
setup: install-deps install-swap install-app configure install-searxng enable

install-deps:
	# Node.js 22 via nodesource
	curl -fsSL https://deb.nodesource.com/setup_$(NODE_VERSION).x | bash -
	apt-get install -y nodejs build-essential sqlite3 bash-completion \
		libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2t64 \
		libpangocairo-1.0-0 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
		libxkbcommon0 libxshmfence1 libnss3 libnspr4 libxfixes3 libxext6 libx11-6
	# Docker (for SearXNG)
	which docker || (curl -fsSL https://get.docker.com | sh)

install-swap:
	@if [ ! -f /swapfile ]; then \
		SIZE=$$(grep MemTotal /proc/meminfo | awk '{print int($$2/1024)}'); \
		echo "Creating $${SIZE}M swap..."; \
		dd if=/dev/zero of=/swapfile bs=1M count=$$SIZE status=progress; \
		chmod 600 /swapfile; \
		mkswap /swapfile; \
		swapon /swapfile; \
		grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab; \
	else \
		echo "Swap already exists"; \
	fi

install-app:
	mkdir -p $(APP_DIR)/state $(APP_DIR)/prompts
	test -d $(APP_DIR)/.git || git clone https://github.com/clawchat/eliezer.git $(APP_DIR)
	cd $(APP_DIR) && npm ci
	cp -rn $(APP_DIR)/prompts-default/* $(APP_DIR)/prompts/
	# Gate curl/wget to localhost only
	chmod +x $(APP_DIR)/deploy/curl-gate.sh $(APP_DIR)/deploy/wget-gate.sh
	ln -sf $(APP_DIR)/deploy/curl-gate.sh /usr/local/bin/curl
	ln -sf $(APP_DIR)/deploy/wget-gate.sh /usr/local/bin/wget
	# Install systemd unit
	cp $(APP_DIR)/deploy/eliezer.service /etc/systemd/system/eliezer.service
	systemctl daemon-reload

configure:
	@test -f $(APP_DIR)/.env || (echo "Create $(APP_DIR)/.env with your API keys and config, then rerun make setup."; exit 1)

install-searxng:
	mkdir -p /opt/searxng && \
	cp $(APP_DIR)/config/searxng/settings.yml /opt/searxng/settings.yml && \
	docker pull searxng/searxng && \
	(docker rm -f searxng 2>/dev/null || true) && \
	docker run -d --name searxng --restart unless-stopped \
		-p 127.0.0.1:8080:8080 \
		-e SEARXNG_BASE_URL=http://localhost:8080 \
		-v /opt/searxng/settings.yml:/etc/searxng/settings.yml \
		searxng/searxng

enable:
	systemctl enable --now eliezer
	@echo ""
	@echo "Eliezer is running. Check with: make status"

ssh-key:
	@echo "Generating git_access key (passphrase-protected, for manual git pull)..."
	ssh-keygen -t ed25519 -f /root/.ssh/git_access -C "git_access@$$(hostname)"
	@echo ""
	@echo "Add this as a deploy key on GitHub:"
	@cat /root/.ssh/git_access.pub
	@echo ""
	@echo "Configuring SSH to use deploy key for github.com..."
	@mkdir -p /root/.ssh
	@grep -q 'Host github.com' /root/.ssh/config 2>/dev/null || printf '\nHost github.com\n\tIdentityFile /root/.ssh/git_access\n' >> /root/.ssh/config
	@chmod 600 /root/.ssh/config

deploy:
	cd $(APP_DIR) && git pull
	cd $(APP_DIR) && npm ci
	systemctl restart eliezer
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		if curl -sf http://localhost:3200/info/health >/dev/null 2>&1; then \
			echo "deploy ok — eliezer is healthy"; exit 0; \
		fi; \
		sleep 1; \
	done; \
	echo "ERROR: eliezer not healthy after 10s"; \
	journalctl -u eliezer --no-pager -n 20; \
	exit 1

status:
	systemctl status eliezer

logs:
	journalctl -u eliezer -f
