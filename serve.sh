#!/bin/sh
cd "$(dirname "$0")" && python3 -m http.server ${1:-8080} --bind 127.0.0.1
