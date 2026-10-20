.PHONY: setup build test run docker-build docker-run

NPM ?= npm
NODE ?= node
IMAGE ?= bisectpilot:local

setup:
	$(NPM) ci
	$(NPM) --prefix website ci

build:
	$(NPM) run build
	$(NPM) --prefix website run build

test:
	$(NPM) test
	$(NPM) run test:py
	$(NPM) --prefix website run test

run:
	$(NPM) run build
	$(NODE) dist/src/index.js --help

docker-build:
	docker build --tag $(IMAGE) .

docker-run:
	docker run --rm $(IMAGE) --help
