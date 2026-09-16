# Installing this checkout as a plugin, without going through GitHub.
#
# The published route is the marketplace in the README: push, then let every
# machine pull the release. This file is the other one — the working copy itself
# registered as a directory marketplace, so an edit reaches the installed plugin
# with one `make update` instead of a push and a refresh.
#
# `make install` binds the installation to the current path of this directory:
# moving the checkout means running it again.
#
# The marketplace name here is the same `pi-tools` the GitHub one uses (it comes
# from .claude-plugin/marketplace.json, which both share). If this machine still
# has the GitHub marketplace registered, drop it first — `make uninstall`, or
# `claude plugin marketplace remove pi-tools` — or the name collides.

SHELL       := /bin/bash
ROOT        := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
MARKETPLACE := pi-tools
PLUGIN      := pi
PLUGIN_DIR  := $(ROOT)/plugins/$(PLUGIN)
CLAUDE      ?= claude
BIN_DIR     ?= $(HOME)/.local/bin

.DEFAULT_GOAL := help
.PHONY: help install update uninstall reinstall validate test status link

help: ## List the targets
	@awk 'BEGIN{FS=":.*##"} /^[a-z-]+:.*##/ {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: validate ## Register this directory as a marketplace and install the plugin
	$(CLAUDE) plugin marketplace add "$(ROOT)"
	$(CLAUDE) plugin install $(PLUGIN)@$(MARKETPLACE) -y
	@$(MAKE) --no-print-directory status

# Why not `claude plugin update`: with a bare name it does not resolve the
# plugin at all, and with `plugin@marketplace` it compares the `version` field
# and copies nothing when the two are equal. Version is frozen at 0.1.0 here, so
# that path reports success and leaves the installed copy on the old code.
# `install` always copies the directory whole, which is why an update is a
# reinstall. (The other fix is to bump `version` in both manifests — that is the
# only one a user installing from GitHub has.)
#
# Uninstall refuses while another Claude Code session holds the installed copy.
# Close the other sessions — this one included — if it does.
update: validate ## Copy the current checkout into the installed plugin
	$(CLAUDE) plugin marketplace update $(MARKETPLACE)
	$(CLAUDE) plugin uninstall $(PLUGIN)@$(MARKETPLACE) -y
	$(CLAUDE) plugin install $(PLUGIN)@$(MARKETPLACE) -y
	@$(MAKE) --no-print-directory status
	@echo "Restart the Claude Code session for the change to take effect."

uninstall: ## Remove the plugin and unregister the marketplace
	-$(CLAUDE) plugin uninstall $(PLUGIN)@$(MARKETPLACE) -y
	-$(CLAUDE) plugin marketplace remove $(MARKETPLACE)

reinstall: uninstall install ## Install from scratch

validate: ## Check the plugin and marketplace manifests (--strict)
	$(CLAUDE) plugin validate --strict "$(PLUGIN_DIR)"
	$(CLAUDE) plugin validate --strict "$(ROOT)"

test: ## Run the test suite
	npm test

# The shim in PATH is a symlink, and a symlink into a marketplace clone dies
# with that clone: switching away from the GitHub marketplace leaves `pia`
# pointing at a directory that is no longer there. Pointed at the checkout it
# survives every install and uninstall below.
link: ## Point `pia` in PATH at this checkout
	@mkdir -p "$(BIN_DIR)"
	ln -sfn "$(ROOT)/bin/pia" "$(BIN_DIR)/pia"
	@echo "$(BIN_DIR)/pia -> $(ROOT)/bin/pia"

status: ## Installation state and what the plugin contains
	@$(CLAUDE) plugin list 2>/dev/null | grep -A3 '$(PLUGIN)@$(MARKETPLACE)' || echo "  plugin not installed"
	@$(CLAUDE) plugin details $(PLUGIN) 2>/dev/null | sed -n '5,11p' || true
