#!/bin/zsh
cd "${0:A:h}" || exit 1
if ! command -v npm >/dev/null 2>&1; then
  print 'Node.js and npm are required. Install Node.js, then reopen this launcher.'
  read -k 1
  exit 1
fi
if [[ ! -d node_modules ]]; then
  npm ci || exit 1
fi
npm run dev -- --port 5173 --open
